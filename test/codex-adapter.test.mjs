// codex adapter: verifies rollout .jsonl logs are regrouped into TURNS (codex
// has no per-message id, unlike Claude Code/opencode), that framework-injected
// records (developer role, <environment_context>/<permissions instructions>
// wrapped user turns) never surface as messages, that the codex tool
// vocabulary (exec_command/shell/shell_command/update_plan/
// request_user_input) maps onto the canonical names, that apply_patch diff
// bodies never leak (only touched file paths survive), and that reasoning
// text/tool output/secrets are reduced to structural counts exactly like the
// other two adapters. Also smoke-runs the bundle through digest,
// agentic-literacy, and intensity (the last one specifically guards the
// ISO-timestamp contract).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readCodex } from "../src/adapters/codex.mjs";
import { mergeSources } from "../src/adapters/opencode.mjs";
import { buildDigest } from "../src/digest.mjs";
import { computeAgenticLiteracy } from "../src/agentic-literacy.mjs";
import { computeIntensity } from "../src/intensity.mjs";

function makeCodexRoot() {
  return join(mkdtempSync(join(tmpdir(), "codex-")), "sessions");
}

// Write one rollout file (= one session) under sessions/YYYY/MM/DD/, mirroring
// codex's real on-disk layout. `lines` is an array of record objects (JSON
// stringified) OR raw strings (to inject malformed JSON verbatim).
function writeRollout(root, { date = "2026/01/15", uuid = "11111111-2222-7333-8444-555555555555", lines }) {
  const dir = join(root, date);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-2026-01-15T10-00-00-${uuid}.jsonl`);
  const body = lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n";
  writeFileSync(file, body);
  return file;
}

const rec = (type, payload, ts) => ({ timestamp: ts, type, payload });
const T = (n) => `2026-01-15T10:00:${String(n).padStart(2, "0")}.000Z`;

function withRoot(fn) {
  const root = makeCodexRoot();
  try {
    return fn(root);
  } finally {
    rmSync(join(root, ".."), { recursive: true, force: true });
  }
}

test("turn reconstruction: user/assistant alternate with correct uuids, parentUuids, chain, ISO ts", () => {
  withRoot((root) => {
    writeRollout(root, {
      lines: [
        rec("session_meta", { id: "sess-turns", cwd: "/Users/alice/proj", originator: "codex-tui", cli_version: "0.60.0", model_provider: "openai" }, T(0)),
        rec("turn_context", { cwd: "/Users/alice/proj", model: "gpt-5.5" }, T(1)),
        rec("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "first question" }] }, T(2)),
        rec("response_item", { type: "reasoning", summary: [{ type: "summary_text", text: "thinking about it" }], encrypted_content: "enc-blob-1" }, T(3)),
        rec("response_item", { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "ls -la" }), call_id: "call1" }, T(4)),
        rec("response_item", { type: "function_call_output", call_id: "call1", output: "Exit code: 0\nOutput:\nfile1\nfile2" }, T(5)),
        rec("event_msg", { type: "token_count", last_token_usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 135 } }, T(6)),
        rec("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "here is the answer" }] }, T(7)),
        rec("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "second question" }] }, T(8)),
        rec("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "second answer" }] }, T(9)),
      ],
    });

    const parsed = readCodex(root);
    assert.equal(parsed.sessions.length, 1);
    const s = parsed.sessions[0];
    assert.equal(s.sessionId, "sess-turns");
    assert.equal(s.messages.length, 4, `expected 4 messages, got ${s.messages.length}: ${JSON.stringify(s.messages.map((m) => m.role))}`);

    const [u1, a1, u2, a2] = s.messages;
    assert.equal(u1.role, "user");
    assert.equal(u1.ts, T(2));
    assert.equal(u1.textRedacted.trim(), "first question");
    assert.equal(u1.parentUuid, null);

    assert.equal(a1.role, "assistant");
    // first record folded into this turn is the reasoning record
    assert.equal(a1.ts, T(3));
    assert.equal(a1.parentUuid, u1.uuid);
    assert.equal(a1.thinkingChars, "thinking about it".length);
    assert.equal(a1.signatureChars, "enc-blob-1".length);
    assert.equal(a1.toolUses.length, 1);
    assert.equal(a1.toolUses[0].id, "call1");
    assert.equal(a1.toolUses[0].name, "Bash");
    assert.equal(a1.toolUses[0].cmd, "ls -la");
    assert.equal(a1.toolResults.length, 1);
    assert.equal(a1.toolResults[0].forId, "call1");
    assert.equal(a1.toolResults[0].isError, false);
    assert.ok(a1.toolResults[0].bytes > 0);
    assert.ok(a1.usage, "usage should be captured");
    assert.equal(a1.usage.input, 100);
    assert.equal(a1.usage.output, 20);
    assert.equal(a1.usage.cacheRead, 10);
    assert.equal(a1.usage.cacheCreate, 0);
    assert.ok(a1.textRedacted.includes("here is the answer"));

    assert.equal(u2.role, "user");
    assert.equal(u2.ts, T(8));
    assert.equal(u2.parentUuid, a1.uuid);

    assert.equal(a2.role, "assistant");
    assert.equal(a2.parentUuid, u2.uuid);
    assert.equal(a2.textRedacted.trim(), "second answer");

    // uuid scheme + chain
    for (const m of s.messages) assert.match(m.uuid, /^sess-turns-turn-\d+$/);
    assert.equal(s.chain.length, 4);
    assert.deepEqual(s.chain.map((c) => c.uuid), s.messages.map((m) => m.uuid));
    assert.deepEqual(s.chain.map((c) => c.parentUuid), s.messages.map((m) => m.parentUuid));

    assert.equal(s.firstTs, T(2));
    assert.equal(s.lastTs, T(9));
    for (const m of s.messages) {
      assert.equal(typeof m.ts, "string");
      assert.ok(Number.isFinite(Date.parse(m.ts)), `ts not ISO: ${m.ts}`);
    }
  });
});

test("framework-injected turns never surface: <environment_context>/<permissions instructions> user turns and developer role are dropped", () => {
  withRoot((root) => {
    writeRollout(root, {
      lines: [
        rec("session_meta", { id: "sess-fw", cwd: "/Users/bob/app", originator: "codex-tui", cli_version: "0.60.0", model_provider: "openai" }, T(0)),
        rec("turn_context", { cwd: "/Users/bob/app", model: "gpt-5.5" }, T(1)),
        rec("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n  MARKER_ENV_CONTEXT_TEXT\n</environment_context>" }] }, T(2)),
        rec("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "<permissions instructions>\n  MARKER_PERMISSIONS_TEXT\n</permissions instructions>" }] }, T(3)),
        rec("response_item", { type: "message", role: "developer", content: [{ type: "input_text", text: "MARKER_DEVELOPER_TEXT system prompt" }] }, T(4)),
        rec("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "real question here" }] }, T(5)),
        rec("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "real answer here" }] }, T(6)),
      ],
    });

    const parsed = readCodex(root);
    const s = parsed.sessions[0];
    assert.equal(s.messages.length, 2, `expected only the real user/assistant pair, got ${JSON.stringify(s.messages.map((m) => m.role))}`);
    assert.equal(s.messages[0].role, "user");
    assert.equal(s.messages[0].textRedacted.trim(), "real question here");
    assert.equal(s.messages[1].role, "assistant");
    assert.ok(!s.messages.some((m) => m.role === "developer"), "developer role must never appear");

    const bundleJson = JSON.stringify(parsed);
    assert.ok(!bundleJson.includes("MARKER_ENV_CONTEXT_TEXT"), "environment_context text leaked");
    assert.ok(!bundleJson.includes("MARKER_PERMISSIONS_TEXT"), "permissions instructions text leaked");
    assert.ok(!bundleJson.includes("MARKER_DEVELOPER_TEXT"), "developer text leaked");
  });
});

test("framework filtering is per content block: a user message mixing a framework block with a real block keeps only the real block", () => {
  withRoot((root) => {
    writeRollout(root, {
      lines: [
        rec("session_meta", { id: "sess-fw-mixed", cwd: "/Users/bob/app", originator: "codex-tui", cli_version: "0.60.0", model_provider: "openai" }, T(0)),
        rec("turn_context", { cwd: "/Users/bob/app", model: "gpt-5.5" }, T(1)),
        rec(
          "response_item",
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "<environment_context>\n  MARKER_MIXED_ENV_TEXT\n</environment_context>" },
              { type: "input_text", text: "MARKER_MIXED_REAL_TEXT actual human question" },
            ],
          },
          T(2),
        ),
        rec("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "answering the mixed message" }] }, T(3)),
      ],
    });

    const parsed = readCodex(root);
    const s = parsed.sessions[0];
    assert.equal(s.messages.length, 2, `expected the mixed message to survive as one user turn, got ${JSON.stringify(s.messages.map((m) => m.role))}`);
    assert.equal(s.messages[0].role, "user");
    assert.ok(s.messages[0].textRedacted.includes("MARKER_MIXED_REAL_TEXT"), "the real block must survive");
    assert.ok(!s.messages[0].textRedacted.includes("MARKER_MIXED_ENV_TEXT"), "the framework-wrapped block must be dropped, not the whole message");

    const bundleJson = JSON.stringify(parsed);
    assert.ok(!bundleJson.includes("MARKER_MIXED_ENV_TEXT"), "framework-wrapped block text leaked anywhere in the bundle");
  });
});

test("AGENTS.md instructions dump is filtered like the other framework-injected forms: a whole message is dropped, text never surfaces, userMessages count unaffected", () => {
  withRoot((root) => {
    writeRollout(root, {
      lines: [
        rec("session_meta", { id: "sess-agentsmd", cwd: "/Users/mia/app", originator: "codex-tui", cli_version: "0.60.0", model_provider: "openai" }, T(0)),
        rec("turn_context", { cwd: "/Users/mia/app", model: "gpt-5.5" }, T(1)),
        rec(
          "response_item",
          { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for /Users/mia/app\n\n<INSTRUCTIONS>\nMARKER_AGENTSMD_TEXT\n</INSTRUCTIONS>" }] },
          T(2),
        ),
        rec("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "real question here" }] }, T(3)),
        rec("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "real answer here" }] }, T(4)),
      ],
    });

    const parsed = readCodex(root);
    const s = parsed.sessions[0];
    assert.equal(s.messages.length, 2, `expected only the real user/assistant pair, got ${JSON.stringify(s.messages.map((m) => m.role))}`);
    assert.equal(s.messages[0].role, "user");
    assert.equal(s.messages[0].textRedacted.trim(), "real question here");

    const bundleJson = JSON.stringify(parsed);
    assert.ok(!bundleJson.includes("MARKER_AGENTSMD_TEXT"), "AGENTS.md instructions text leaked");

    const digest = buildDigest(mergeSources(parsed));
    assert.equal(digest.projects[0].userMessages, 1, "the AGENTS.md dump must not inflate the userMessages count");
    assert.ok(
      !digest.projects[0].promptSamples.some((p) => p.includes("MARKER_AGENTSMD_TEXT")),
      "AGENTS.md text must not surface in promptSamples",
    );
  });
});

test("AGENTS.md filtering is per content block: mixing the dump with a real block in the same message keeps only the real block", () => {
  withRoot((root) => {
    writeRollout(root, {
      lines: [
        rec("session_meta", { id: "sess-agentsmd-mixed", cwd: "/Users/mia/app", originator: "codex-tui", cli_version: "0.60.0", model_provider: "openai" }, T(0)),
        rec("turn_context", { cwd: "/Users/mia/app", model: "gpt-5.5" }, T(1)),
        rec(
          "response_item",
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "# AGENTS.md instructions for /Users/mia/app\n\n<INSTRUCTIONS>\nMARKER_AGENTSMD_MIXED_TEXT\n</INSTRUCTIONS>" },
              { type: "input_text", text: "MARKER_MIXED_REAL_TEXT actual human question" },
            ],
          },
          T(2),
        ),
        rec("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "answering the mixed message" }] }, T(3)),
      ],
    });

    const parsed = readCodex(root);
    const s = parsed.sessions[0];
    assert.equal(s.messages.length, 2, `expected the mixed message to survive as one user turn, got ${JSON.stringify(s.messages.map((m) => m.role))}`);
    assert.equal(s.messages[0].role, "user");
    assert.ok(s.messages[0].textRedacted.includes("MARKER_MIXED_REAL_TEXT"), "the real block must survive");
    assert.ok(!s.messages[0].textRedacted.includes("MARKER_AGENTSMD_MIXED_TEXT"), "the AGENTS.md-wrapped block must be dropped, not the whole message");

    const bundleJson = JSON.stringify(parsed);
    assert.ok(!bundleJson.includes("MARKER_AGENTSMD_MIXED_TEXT"), "AGENTS.md dump text leaked anywhere in the bundle");
  });
});

test("guard: a real user message that merely mentions the AGENTS.md instructions phrase inline (not as its leading text) survives", () => {
  withRoot((root) => {
    writeRollout(root, {
      lines: [
        rec("session_meta", { id: "sess-agentsmd-mention", cwd: "/Users/mia/app", originator: "codex-tui", cli_version: "0.60.0", model_provider: "openai" }, T(0)),
        rec("turn_context", { cwd: "/Users/mia/app", model: "gpt-5.5" }, T(1)),
        rec(
          "response_item",
          { type: "message", role: "user", content: [{ type: "input_text", text: 'I noticed the "# AGENTS.md instructions for" dump earlier, can you explain why it appears?' }] },
          T(2),
        ),
        rec("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "sure, that's Codex re-injecting your repo's AGENTS.md" }] }, T(3)),
      ],
    });

    const parsed = readCodex(root);
    const s = parsed.sessions[0];
    assert.equal(s.messages.length, 2, "a message that merely mentions the AGENTS.md prefix inline (not as its leading text) must survive");
    assert.equal(s.messages[0].role, "user");
    assert.ok(s.messages[0].textRedacted.includes("AGENTS.md instructions for"));
  });
});

test("shell array command is joined with spaces; secret-looking tokens in cmd are redacted", () => {
  withRoot((root) => {
    writeRollout(root, {
      lines: [
        rec("session_meta", { id: "sess-shell", cwd: "/Users/carol/svc", originator: "codex-tui", cli_version: "0.60.0", model_provider: "openai" }, T(0)),
        rec("turn_context", { cwd: "/Users/carol/svc", model: "gpt-5.5" }, T(1)),
        rec("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "check status and start the server" }] }, T(2)),
        rec("response_item", { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["git", "status"], workdir: "/Users/carol/svc" }), call_id: "call-git" }, T(3)),
        rec("response_item", { type: "function_call_output", call_id: "call-git", output: "Exit code: 0\nOutput:\nclean" }, T(4)),
        rec("response_item", { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "API_KEY=supersecretvalue123 uvicorn app.main:app" }), call_id: "call-secret" }, T(5)),
        rec("response_item", { type: "function_call_output", call_id: "call-secret", output: "Exit code: 0\nOutput:\nrunning" }, T(6)),
        rec("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }, T(7)),
      ],
    });

    const parsed = readCodex(root);
    const toolUses = parsed.sessions[0].messages.flatMap((m) => m.toolUses);
    const gitUse = toolUses.find((u) => u.id === "call-git");
    assert.equal(gitUse.name, "Bash");
    assert.equal(gitUse.cmd, "git status");

    const secretUse = toolUses.find((u) => u.id === "call-secret");
    assert.equal(secretUse.name, "Bash");
    assert.ok(!secretUse.cmd.includes("supersecretvalue123"), `secret leaked in cmd: ${secretUse.cmd}`);
    assert.ok(secretUse.cmd.includes("API_KEY"), "variable name should survive redaction");

    const bundleJson = JSON.stringify(parsed);
    assert.ok(!bundleJson.includes("supersecretvalue123"), "secret leaked anywhere in bundle");
  });
});

test("apply_patch: 2-file patch yields exactly 2 Edit toolUses with paths, diff body never appears anywhere", () => {
  withRoot((root) => {
    const patchBody = [
      "*** Begin Patch",
      "*** Add File: src/new_module.py",
      "+print('UNIQUE_DIFF_BODY_MARKER_TEXT')",
      "*** Update File: /Users/dave/proj/app/main.py",
      "@@",
      "-old_line_UNIQUE_DIFF_BODY_MARKER_TEXT",
      "+new_line",
      "*** End Patch",
    ].join("\n");

    writeRollout(root, {
      lines: [
        rec("session_meta", { id: "sess-patch", cwd: "/Users/dave/proj", originator: "codex-tui", cli_version: "0.60.0", model_provider: "openai" }, T(0)),
        rec("turn_context", { cwd: "/Users/dave/proj", model: "gpt-5.5" }, T(1)),
        rec("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "please update two files" }] }, T(2)),
        rec("response_item", { type: "custom_tool_call", status: "in_progress", call_id: "cpatch1", name: "apply_patch", input: patchBody }, T(3)),
        rec("response_item", { type: "custom_tool_call_output", call_id: "cpatch1", output: JSON.stringify({ output: "Success. Updated the following files:\nA src/new_module.py\nM app/main.py\n" }) }, T(4)),
        rec("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "patched both files" }] }, T(5)),
      ],
    });

    const parsed = readCodex(root);
    const toolUses = parsed.sessions[0].messages.flatMap((m) => m.toolUses);
    const edits = toolUses.filter((u) => u.name === "Edit");
    assert.equal(edits.length, 2, `expected 2 Edit toolUses, got ${JSON.stringify(edits)}`);
    assert.ok(edits.every((u) => u.id.startsWith("cpatch1-")), "ids should be suffixed for uniqueness");
    const paths = edits.map((u) => u.path).sort();
    assert.deepEqual(paths, ["/Users/⟨user⟩/proj/app/main.py", "src/new_module.py"]);
    assert.ok(!paths.some((p) => p.includes("\\")), "paths should be POSIX");

    const bundleJson = JSON.stringify(parsed);
    assert.ok(!bundleJson.includes("UNIQUE_DIFF_BODY_MARKER_TEXT"), "diff body leaked");
    assert.ok(!bundleJson.includes("Begin Patch"), "raw patch header text leaked");
    assert.ok(!bundleJson.includes("print("), "diff body content leaked");
  });
});

test("apply_patch with zero parseable file headers falls back to a single pathless Edit toolUse", () => {
  withRoot((root) => {
    writeRollout(root, {
      lines: [
        rec("session_meta", { id: "sess-patch-empty", cwd: "/Users/erin/proj", originator: "codex-tui", cli_version: "0.60.0", model_provider: "openai" }, T(0)),
        rec("turn_context", { cwd: "/Users/erin/proj", model: "gpt-5.5" }, T(1)),
        rec("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "patch something" }] }, T(2)),
        rec("response_item", { type: "custom_tool_call", call_id: "cpatch2", name: "apply_patch", input: "*** Begin Patch\nnothing parseable here\n*** End Patch" }, T(3)),
        rec("response_item", { type: "custom_tool_call_output", call_id: "cpatch2", output: JSON.stringify({ output: "no-op" }) }, T(4)),
        rec("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }, T(5)),
      ],
    });

    const parsed = readCodex(root);
    const toolUses = parsed.sessions[0].messages.flatMap((m) => m.toolUses);
    const edits = toolUses.filter((u) => u.name === "Edit");
    assert.equal(edits.length, 1);
    assert.ok(!edits[0].path, `expected no path, got: ${edits[0].path}`);
  });
});

test("custom_tool_call_output: status drives isError (failed -> true, completed -> false)", () => {
  withRoot((root) => {
    const failOutput = "boom — fatto ✅ è male";
    const okOutput = "great — fatto ✅ è bene";
    // Hard guard: same rationale as the function_call_output bytes test —
    // ASCII-only fixtures can't distinguish `.length` from `Buffer.byteLength`,
    // so this pins the fixtures to actually contain multi-byte chars.
    assert.notEqual(failOutput.length, Buffer.byteLength(failOutput), "fixture must contain multi-byte chars so byte-unit semantics diverge");
    assert.notEqual(okOutput.length, Buffer.byteLength(okOutput), "fixture must contain multi-byte chars so byte-unit semantics diverge");
    writeRollout(root, {
      lines: [
        rec("session_meta", { id: "sess-custom-status", cwd: "/Users/erin/proj", originator: "codex-tui", cli_version: "0.60.0", model_provider: "openai" }, T(0)),
        rec("turn_context", { cwd: "/Users/erin/proj", model: "gpt-5.5" }, T(1)),
        rec("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "run two custom tools" }] }, T(2)),
        rec("response_item", { type: "custom_tool_call", call_id: "cfail", name: "some_custom_tool", input: "" }, T(3)),
        rec("response_item", { type: "custom_tool_call_output", call_id: "cfail", status: "failed", output: failOutput }, T(4)),
        rec("response_item", { type: "custom_tool_call", call_id: "cok", name: "some_custom_tool", input: "" }, T(5)),
        rec("response_item", { type: "custom_tool_call_output", call_id: "cok", status: "completed", output: okOutput }, T(6)),
        rec("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "done both" }] }, T(7)),
      ],
    });

    const parsed = readCodex(root);
    const results = parsed.sessions[0].messages.flatMap((m) => m.toolResults);
    const rFail = results.find((r) => r.forId === "cfail");
    const rOk = results.find((r) => r.forId === "cok");
    assert.ok(rFail, "expected a toolResult for cfail");
    assert.ok(rOk, "expected a toolResult for cok");
    assert.equal(rFail.isError, true, "status: failed should be an error");
    assert.equal(rOk.isError, false, "status: completed should not be an error");
    assert.equal(rFail.bytes, failOutput.length, "bytes is the UTF-16 code-unit length (.length), not Buffer.byteLength");
    assert.equal(rOk.bytes, okOutput.length, "bytes is the UTF-16 code-unit length (.length), not Buffer.byteLength");
  });
});

test("tool mapping: exec_command/shell_command -> Bash, update_plan -> TodoWrite, request_user_input -> AskUserQuestion (q extracted), unknown falls back to mcp__server__tool", () => {
  withRoot((root) => {
    writeRollout(root, {
      lines: [
        rec("session_meta", { id: "sess-map", cwd: "/Users/frank/proj", originator: "codex-tui", cli_version: "0.60.0", model_provider: "openai" }, T(0)),
        rec("turn_context", { cwd: "/Users/frank/proj", model: "gpt-5.5" }, T(1)),
        rec("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "do several things" }] }, T(2)),
        rec("response_item", { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "pwd" }), call_id: "c1" }, T(3)),
        rec("response_item", { type: "function_call_output", call_id: "c1", output: "Exit code: 0\nOutput:\n/x" }, T(4)),
        rec("response_item", { type: "function_call", name: "shell_command", arguments: JSON.stringify({ command: "echo hi" }), call_id: "c2" }, T(5)),
        rec("response_item", { type: "function_call_output", call_id: "c2", output: "Exit code: 0\nOutput:\nhi" }, T(6)),
        rec("response_item", { type: "function_call", name: "update_plan", arguments: JSON.stringify({ plan: [{ status: "pending", step: "do it" }] }), call_id: "c3" }, T(7)),
        rec("response_item", { type: "function_call_output", call_id: "c3", output: "ok" }, T(8)),
        rec("response_item", { type: "function_call", name: "request_user_input", arguments: JSON.stringify({ questions: [{ id: "q1", question: "Which approach?" }] }), call_id: "c4" }, T(9)),
        rec("response_item", { type: "function_call_output", call_id: "c4", output: "ok" }, T(10)),
        rec("response_item", { type: "function_call", name: "myserver_mytool", arguments: JSON.stringify({}), call_id: "c5" }, T(11)),
        rec("response_item", { type: "function_call_output", call_id: "c5", output: "ok" }, T(12)),
        rec("event_msg", { type: "web_search_call", call_id: "c6", action: { type: "search", query: "how to redact secrets" } }, T(13)),
        rec("event_msg", { type: "web_search_call", action: { type: "search", query: "no call id here" } }, T(14)),
        rec("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "all done" }] }, T(15)),
      ],
    });

    const parsed = readCodex(root);
    const toolUses = parsed.sessions[0].messages.flatMap((m) => m.toolUses);
    const byId = Object.fromEntries(toolUses.map((u) => [u.id, u]));
    assert.equal(byId.c1.name, "Bash");
    assert.equal(byId.c1.cmd, "pwd");
    assert.equal(byId.c2.name, "Bash");
    assert.equal(byId.c2.cmd, "echo hi");
    assert.equal(byId.c3.name, "TodoWrite");
    assert.equal(byId.c4.name, "AskUserQuestion");
    assert.equal(byId.c4.q, "Which approach?");
    assert.equal(byId.c5.name, "mcp__myserver__mytool", `got: ${byId.c5.name}`);

    // web_search_call must be shaped like every other toolUse in this adapter
    // ({id, name, path, cmd, q}), not the bare {name, q?} it used to be.
    const search1 = byId.c6;
    assert.ok(search1, "expected a toolUse keyed by the web_search_call's call_id");
    assert.equal(search1.name, "WebSearch");
    assert.equal(search1.q, "how to redact secrets");
    assert.equal(search1.path, "");
    assert.equal(search1.cmd, "");
    assert.deepEqual(Object.keys(search1).sort(), ["cmd", "id", "name", "path", "q"]);

    const search2 = toolUses.find((u) => u.name === "WebSearch" && u.q === "no call id here");
    assert.ok(search2, "expected the second web_search_call toolUse");
    assert.equal(search2.id, undefined, "absent call_id/id should leave id undefined, same convention as other toolUse builders");
    assert.deepEqual(Object.keys(search2).sort(), ["cmd", "id", "name", "path", "q"]);
  });
});

test("reasoning: summary text length lands in thinkingChars, encrypted_content length in signatureChars, neither string stored", () => {
  withRoot((root) => {
    writeRollout(root, {
      lines: [
        rec("session_meta", { id: "sess-reason", cwd: "/Users/gina/proj", originator: "codex-tui", cli_version: "0.60.0", model_provider: "openai" }, T(0)),
        rec("turn_context", { cwd: "/Users/gina/proj", model: "gpt-5.5" }, T(1)),
        rec("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "think about this" }] }, T(2)),
        rec("response_item", { type: "reasoning", summary: [{ type: "summary_text", text: "SECRET_REASONING_SUMMARY_TEXT" }], encrypted_content: "ENC_BLOB_SECRET_XYZ" }, T(3)),
        rec("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "here you go" }] }, T(4)),
      ],
    });

    const parsed = readCodex(root);
    const asst = parsed.sessions[0].messages.find((m) => m.role === "assistant");
    assert.equal(asst.thinkingChars, "SECRET_REASONING_SUMMARY_TEXT".length);
    assert.equal(asst.signatureChars, "ENC_BLOB_SECRET_XYZ".length);

    const bundleJson = JSON.stringify(parsed);
    assert.ok(!bundleJson.includes("SECRET_REASONING_SUMMARY_TEXT"), "reasoning summary text leaked");
    assert.ok(!bundleJson.includes("ENC_BLOB_SECRET_XYZ"), "encrypted_content leaked");
  });
});

test("usage: two token_count events in one turn sum deltas; cacheRead from cached_input_tokens; cacheCreate stays 0", () => {
  withRoot((root) => {
    writeRollout(root, {
      lines: [
        rec("session_meta", { id: "sess-usage", cwd: "/Users/hank/proj", originator: "codex-tui", cli_version: "0.60.0", model_provider: "openai" }, T(0)),
        rec("turn_context", { cwd: "/Users/hank/proj", model: "gpt-5.5" }, T(1)),
        rec("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] }, T(2)),
        rec("event_msg", { type: "token_count", last_token_usage: { input_tokens: 50, cached_input_tokens: 5, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 60 } }, T(3)),
        rec("event_msg", { type: "token_count", last_token_usage: { input_tokens: 30, cached_input_tokens: 2, output_tokens: 8, reasoning_output_tokens: 0, total_tokens: 38 } }, T(4)),
        rec("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "went" }] }, T(5)),
      ],
    });

    const parsed = readCodex(root);
    const asst = parsed.sessions[0].messages.find((m) => m.role === "assistant");
    assert.ok(asst.usage, "usage should be present");
    assert.equal(asst.usage.input, 80);
    assert.equal(asst.usage.output, 18);
    assert.equal(asst.usage.cacheRead, 7);
    assert.equal(asst.usage.cacheCreate, 0);
  });
});

test("isError: Exit code 1 -> true, Exit code 0 -> false; output text absent from bundle, bytes correct", () => {
  withRoot((root) => {
    const failOutput = "Exit code: 1\nWall time: 0.2 seconds\nOutput:\nboom SECRET_OUTPUT_TEXT_FAIL — fatto ✅ è ok";
    const okOutput = "Exit code: 0\nWall time: 0.1 seconds\nOutput:\nok SECRET_OUTPUT_TEXT_OK — fatto ✅ è ok";
    // Hard guard: these fixtures must contain multi-byte UTF-8 characters so
    // `.length` (UTF-16 code units) and `Buffer.byteLength` (UTF-8 bytes)
    // actually diverge. Without this, the bytes assertions below pass under
    // BOTH the old Buffer.byteLength code and the new .length code, and pin
    // nothing. If someone edits these fixtures back to pure ASCII, this
    // guard fails loudly instead of the test silently going toothless.
    assert.notEqual(failOutput.length, Buffer.byteLength(failOutput), "fixture must contain multi-byte chars so byte-unit semantics diverge");
    assert.notEqual(okOutput.length, Buffer.byteLength(okOutput), "fixture must contain multi-byte chars so byte-unit semantics diverge");
    writeRollout(root, {
      lines: [
        rec("session_meta", { id: "sess-err", cwd: "/Users/ivan/proj", originator: "codex-tui", cli_version: "0.60.0", model_provider: "openai" }, T(0)),
        rec("turn_context", { cwd: "/Users/ivan/proj", model: "gpt-5.5" }, T(1)),
        rec("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "run two commands" }] }, T(2)),
        rec("response_item", { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "false" }), call_id: "cA" }, T(3)),
        rec("response_item", { type: "function_call_output", call_id: "cA", output: failOutput }, T(4)),
        rec("response_item", { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "true" }), call_id: "cB" }, T(5)),
        rec("response_item", { type: "function_call_output", call_id: "cB", output: okOutput }, T(6)),
        rec("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "ran both" }] }, T(7)),
      ],
    });

    const parsed = readCodex(root);
    const results = parsed.sessions[0].messages.flatMap((m) => m.toolResults);
    const rA = results.find((r) => r.forId === "cA");
    const rB = results.find((r) => r.forId === "cB");
    assert.equal(rA.isError, true);
    assert.equal(rA.bytes, failOutput.length, "bytes is the UTF-16 code-unit length (.length), not Buffer.byteLength");
    assert.equal(rB.isError, false);
    assert.equal(rB.bytes, okOutput.length, "bytes is the UTF-16 code-unit length (.length), not Buffer.byteLength");

    const bundleJson = JSON.stringify(parsed);
    assert.ok(!bundleJson.includes("SECRET_OUTPUT_TEXT_FAIL"), "tool output text leaked");
    assert.ok(!bundleJson.includes("SECRET_OUTPUT_TEXT_OK"), "tool output text leaked");
  });
});

test("malformed JSON line increments files[].malformed; the rest of the session still parses", () => {
  withRoot((root) => {
    writeRollout(root, {
      lines: [
        rec("session_meta", { id: "sess-malformed", cwd: "/Users/jane/proj", originator: "codex-tui", cli_version: "0.60.0", model_provider: "openai" }, T(0)),
        rec("turn_context", { cwd: "/Users/jane/proj", model: "gpt-5.5" }, T(1)),
        rec("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }, T(2)),
        "{this is not valid json,,,",
        rec("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi there" }] }, T(3)),
      ],
    });

    const parsed = readCodex(root);
    assert.equal(parsed.files.length, 1);
    assert.equal(parsed.files[0].malformed, 1);
    assert.equal(parsed.stats.malformedLines, 1);
    assert.equal(parsed.sessions.length, 1);
    assert.equal(parsed.sessions[0].messages.length, 2);
    assert.equal(parsed.sessions[0].messages[1].textRedacted.trim(), "hi there");
  });
});

test("function_call with invalid arguments JSON (the line itself is valid): toolUse still emitted with the name mapped and empty extraction, no throw, and malformedLines is NOT incremented (that counter is for unparseable LINES, not unparseable nested arguments)", () => {
  withRoot((root) => {
    writeRollout(root, {
      lines: [
        rec("session_meta", { id: "sess-bad-args", cwd: "/Users/nina/proj", originator: "codex-tui", cli_version: "0.60.0", model_provider: "openai" }, T(0)),
        rec("turn_context", { cwd: "/Users/nina/proj", model: "gpt-5.5" }, T(1)),
        rec("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "run something" }] }, T(2)),
        // `arguments` is a string field on an otherwise perfectly valid JSON
        // line — JSON.stringify below escapes it correctly, so the LINE
        // parses fine; only the nested arguments string is malformed JSON.
        rec("response_item", { type: "function_call", name: "exec_command", arguments: "{not valid json", call_id: "call-bad-args" }, T(3)),
        rec("response_item", { type: "function_call_output", call_id: "call-bad-args", output: "Exit code: 0\nOutput:\nok" }, T(4)),
        rec("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }, T(5)),
      ],
    });

    assert.doesNotThrow(() => readCodex(root));
    const parsed = readCodex(root);
    assert.equal(parsed.sessions.length, 1);
    const toolUses = parsed.sessions[0].messages.flatMap((m) => m.toolUses);
    const use = toolUses.find((u) => u.id === "call-bad-args");
    assert.ok(use, "toolUse must still be emitted despite the malformed arguments string");
    assert.equal(use.name, "Bash", "name mapping (exec_command -> Bash) still applies");
    assert.equal(use.cmd, "", "malformed arguments degrade to {} so no cmd can be extracted");
    assert.equal(use.path, "");
    assert.equal(use.q, "");

    // The LINE parsed fine — this is a different failure mode from a
    // malformed JSONL line, and must not be counted as one.
    assert.equal(parsed.stats.malformedLines, 0, "malformedLines counts unparseable LINES, not unparseable nested arguments JSON");
    assert.equal(parsed.files[0].malformed, 0);
  });
});

test("session file with no session_meta line: sessionId falls back to the filename uuid, projectLabel stays project-unknown, the session still parses", () => {
  withRoot((root) => {
    const uuid = "22222222-3333-7444-8555-666666666666";
    writeRollout(root, {
      uuid,
      lines: [
        // no session_meta record at all
        rec("turn_context", { model: "gpt-5.5" }, T(0)),
        rec("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "hello with no header" }] }, T(1)),
        rec("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi, no session_meta seen" }] }, T(2)),
      ],
    });

    const parsed = readCodex(root);
    assert.equal(parsed.sessions.length, 1);
    const s = parsed.sessions[0];
    assert.equal(s.sessionId, uuid, "sessionId must fall back to the uuid pulled from the filename");
    assert.equal(s.projectLabel, "project-unknown", "no session_meta means no cwd, so projectLabel stays the default");
    assert.equal(s.messages.length, 2, "the session must still parse fully despite the missing header");
    assert.equal(s.messages[0].textRedacted.trim(), "hello with no header");
    assert.equal(s.messages[1].textRedacted.trim(), "hi, no session_meta seen");
  });
});

test("stats.originatorCounts: counts originators correctly across two synthetic sessions with different originators", () => {
  withRoot((root) => {
    writeRollout(root, {
      date: "2026/01/15",
      uuid: "33333333-4444-7555-8666-777777777777",
      lines: [
        rec("session_meta", { id: "sess-orig-a", cwd: "/Users/omar/proj-a", originator: "codex-tui", cli_version: "0.60.0", model_provider: "openai" }, T(0)),
        rec("turn_context", { cwd: "/Users/omar/proj-a", model: "gpt-5.5" }, T(1)),
        rec("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "hi from tui" }] }, T(2)),
        rec("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] }, T(3)),
      ],
    });
    writeRollout(root, {
      date: "2026/01/16",
      uuid: "44444444-5555-7666-8777-888888888888",
      lines: [
        rec("session_meta", { id: "sess-orig-b", cwd: "/Users/omar/proj-b", originator: "vscode-extension", cli_version: "0.60.0", model_provider: "openai" }, T(0)),
        rec("turn_context", { cwd: "/Users/omar/proj-b", model: "gpt-5.5" }, T(1)),
        rec("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "hi from vscode" }] }, T(2)),
        rec("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello there" }] }, T(3)),
      ],
    });

    const parsed = readCodex(root);
    assert.equal(parsed.sessions.length, 2);
    assert.deepEqual(parsed.stats.originatorCounts, { "codex-tui": 1, "vscode-extension": 1 });
  });
});

test("absent root returns an EMPTY bundle, never throws", () => {
  const missing = join(tmpdir(), "codex-does-not-exist-" + Math.random().toString(36).slice(2));
  const parsed = readCodex(missing);
  assert.equal(parsed.source, "codex");
  assert.deepEqual(parsed.sessions, []);
  assert.deepEqual(parsed.files, []);
  assert.deepEqual(parsed.compactionSummaries, []);
  assert.deepEqual(parsed.redaction, { hits: 0, charsRemoved: 0 });
  assert.equal(parsed.stats.malformedLines, 0);
});

test("smoke: bundle flows through buildDigest + computeAgenticLiteracy + computeIntensity without throwing, session is counted", () => {
  withRoot((root) => {
    writeRollout(root, {
      lines: [
        rec("session_meta", { id: "sess-smoke", cwd: "/Users/kim/product", originator: "codex-tui", cli_version: "0.60.0", model_provider: "openai" }, T(0)),
        rec("turn_context", { cwd: "/Users/kim/product", model: "gpt-5.5" }, T(1)),
        rec("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "fix the bug in app.py" }] }, T(2)),
        rec("response_item", { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "pytest" }), call_id: "c1" }, T(3)),
        rec("response_item", { type: "function_call_output", call_id: "c1", output: "Exit code: 0\nOutput:\nall green" }, T(4)),
        rec("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "fixed it, tests pass" }] }, T(5)),
      ],
    });

    const parsed = mergeSources(readCodex(root));
    assert.doesNotThrow(() => buildDigest(parsed));
    assert.doesNotThrow(() => computeAgenticLiteracy(parsed));
    assert.doesNotThrow(() => computeIntensity(parsed));

    const digest = buildDigest(parsed);
    assert.equal(digest.projects.length, 1);
    assert.equal(digest.projects[0].sessions, 1);

    const intensity = computeIntensity(parsed);
    assert.ok(intensity !== null);
    assert.ok(intensity.activeDays >= 1, "session should be counted as an active day, not silently dropped");
  });
});

test("models: turn_context model prefixed with session_meta model_provider, accumulated once per distinct value (Set semantics)", () => {
  withRoot((root) => {
    writeRollout(root, {
      lines: [
        rec("session_meta", { id: "sess-models", cwd: "/Users/liam/proj", originator: "codex-tui", cli_version: "0.60.0", model_provider: "openai" }, T(0)),
        rec("turn_context", { cwd: "/Users/liam/proj", model: "gpt-5.5" }, T(1)),
        rec("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "one" }] }, T(2)),
        rec("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "one answer" }] }, T(3)),
        rec("turn_context", { cwd: "/Users/liam/proj", model: "gpt-5.5" }, T(4)),
        rec("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "two" }] }, T(5)),
        rec("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "two answer" }] }, T(6)),
      ],
    });

    const parsed = readCodex(root);
    const s = parsed.sessions[0];
    assert.deepEqual(s.models, ["openai/gpt-5.5"]);
    for (const m of s.messages) assert.equal(m.model, "openai/gpt-5.5");
  });
});

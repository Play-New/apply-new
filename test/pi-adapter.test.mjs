// pi (pi.dev) adapter: verifies the per-record message model (pi carries real
// ids/parentIds so there is NO turn synthesis, unlike codex), the header-cwd-
// over-dir-name-decode precedence, the model_change stamping/Set semantics,
// the model-path privacy rule (local model ids can be a full filesystem path
// carrying the OS username — it must never survive into the bundle), the pi
// tool vocabulary (bash/edit/read/write/ls + the observed-but-argument-array
// "Validation" tool), the usage cacheWrite->cacheCreate rename, the
// thinking/thinkingSignature -> length-only lenses, the compaction
// noise-floor/slice mirrored from opencode, and the toolResult
// content-never-stored contract. Also smoke-runs the bundle through digest,
// agentic-literacy, and intensity like the codex/opencode adapter tests do.
//
// Every fixture here is fully synthetic, built under mkdtempSync(tmpdir()) —
// no test may read the real ~/.pi/agent/sessions (64 real sessions live there
// on this machine).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readPi } from "../src/adapters/pi.mjs";
import { redactText } from "../src/redact.mjs";
import { mergeSources } from "../src/adapters/opencode.mjs";
import { buildDigest } from "../src/digest.mjs";
import { computeAgenticLiteracy } from "../src/agentic-literacy.mjs";
import { computeIntensity } from "../src/intensity.mjs";
import { computeFingerprint } from "../src/fingerprint.mjs";

function makePiRoot() {
  return mkdtempSync(join(tmpdir(), "pi-sessions-"));
}

// Mirrors pi's real on-disk encoding: cwd with "/" replaced by "-", wrapped
// in a leading/trailing "--" (e.g. "/Users/x/proj" -> "--Users-x-proj--").
function encodeDir(cwd) {
  return `--${cwd.slice(1).replace(/\//g, "-")}--`;
}

// Write one session file (sessions/<encoded-dir>/<iso-ts>_<uuid>.jsonl).
// `lines` is an array of record objects (JSON stringified) OR raw strings
// (to inject malformed JSON verbatim). `dirCwd` picks the encoded directory
// name; pass `dirName` directly to force a mismatched/arbitrary directory.
function writeSession(root, { dirCwd = "/Users/synthetic/default-project", dirName, uuid = "019f0000-1111-7222-8333-444444444444", lines }) {
  const dir = join(root, "sessions", dirName || encodeDir(dirCwd));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `2026-01-02T03-04-05-000Z_${uuid}.jsonl`);
  const body = lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n";
  writeFileSync(file, body);
  return file;
}

const T = (n) => `2026-01-02T03:04:${String(n).padStart(2, "0")}.000Z`;

const sessionHeader = (id, cwd, ts, version = 3) => ({ type: "session", id, timestamp: ts, version, cwd });
const modelChange = (id, parentId, provider, modelId, ts) => ({ type: "model_change", id, parentId, provider, modelId, timestamp: ts });
const userMsg = (id, parentId, text, ts) => ({
  type: "message", id, parentId, timestamp: ts,
  message: { role: "user", content: [{ type: "text", text }], timestamp: ts },
});
const assistantMsg = (id, parentId, ts, { content = [], usage } = {}) => ({
  type: "message", id, parentId, timestamp: ts,
  message: { role: "assistant", content, usage, model: undefined, provider: undefined, timestamp: ts },
});
const toolResultMsg = (id, parentId, toolCallId, toolName, text, isError, ts) => ({
  type: "message", id, parentId, timestamp: ts,
  message: { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError, timestamp: ts },
});
const compactionRec = (id, parentId, summary, ts) => ({ type: "compaction", id, parentId, summary, timestamp: ts });
// Multi-block user message (userMsg only supports a single text block) —
// needed for the mixed injected-block + human-block filtering tests below.
const userMsgBlocks = (id, parentId, texts, ts) => ({
  type: "message", id, parentId, timestamp: ts,
  message: { role: "user", content: texts.map((text) => ({ type: "text", text })), timestamp: ts },
});

function withRoot(fn) {
  const root = makePiRoot();
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── 1. Header cwd preferred over dir name; dir-name fallback when header missing ──

test("cwd: header line wins over a dir name that encodes a DIFFERENT path", () => {
  withRoot((root) => {
    writeSession(root, {
      dirCwd: "/Users/decoy/wrong-project",
      lines: [
        sessionHeader("sess-1", "/Users/alice/real-project", T(0)),
        userMsg("m1", null, "hello", T(1)),
      ],
    });
    const parsed = readPi(join(root, "sessions"));
    assert.equal(parsed.sessions.length, 1);
    const s = parsed.sessions[0];
    assert.equal(s.cwdRaw, "/Users/alice/real-project", "header cwd must win over the dir-name encoding");
    assert.ok(!s.cwdRedacted.includes("decoy"), "the decoy dir-encoded path must not leak into cwdRedacted");
  });
});

test("cwd: dir-name decode used as fallback when the session header line is missing", () => {
  withRoot((root) => {
    // Hyphen-free path segments deliberately: the dir-name encoding is LOSSY
    // around literal hyphens (documented in pi.mjs) since "/" and "-" both
    // collapse to "-" — that lossiness is a known, accepted edge case, not
    // what this test is checking. This test only checks that the fallback
    // decode path activates and round-trips a plain path correctly.
    writeSession(root, {
      dirCwd: "/Users/bob/fallbackproject",
      lines: [
        // no "session" header record at all
        userMsg("m1", null, "hi there", T(1)),
      ],
    });
    const parsed = readPi(join(root, "sessions"));
    assert.equal(parsed.sessions.length, 1);
    const s = parsed.sessions[0];
    assert.equal(s.cwdRaw, "/Users/bob/fallbackproject");
  });
});

// ── 2. model_change mid-session stamping ──

test("model_change mid-session: both models land in session.models; assistant messages stamped with the model current at their position", () => {
  withRoot((root) => {
    writeSession(root, {
      lines: [
        sessionHeader("sess-models", "/Users/carol/proj", T(0)),
        modelChange("mc1", null, "openrouter", "openai/gpt-5.6", T(1)),
        assistantMsg("a1", "mc1", T(2), { content: [{ type: "text", text: "first answer" }] }),
        modelChange("mc2", "a1", "zai", "glm-5.2", T(3)),
        assistantMsg("a2", "mc2", T(4), { content: [{ type: "text", text: "second answer" }] }),
      ],
    });
    const parsed = readPi(join(root, "sessions"));
    const s = parsed.sessions[0];
    assert.deepEqual([...s.models].sort(), ["openrouter/openai/gpt-5.6", "zai/glm-5.2"].sort());
    const [firstA, secondA] = s.messages.filter((m) => m.role === "assistant");
    assert.equal(firstA.model, "openrouter/openai/gpt-5.6");
    assert.equal(secondA.model, "zai/glm-5.2");
  });
});

// ── 3. PRIVACY: model-path username must never leak ──

test("PRIVACY: a local model id that is a full filesystem path never leaks the username into the bundle", () => {
  withRoot((root) => {
    writeSession(root, {
      lines: [
        sessionHeader("sess-privacy", "/Users/dana/proj", T(0)),
        modelChange("mc1", null, "mlx-local", "/Users/leakname/.cache/mlx/SomeModel-4bit", T(1)),
        assistantMsg("a1", "mc1", T(2), { content: [{ type: "text", text: "using the local model" }] }),
      ],
    });
    const parsed = readPi(join(root, "sessions"));
    const bundleJson = JSON.stringify(parsed);
    assert.ok(!bundleJson.includes("leakname"), "username from a local model path leaked into the bundle");
    const s = parsed.sessions[0];
    assert.ok([...s.models][0].includes("⟨user⟩") || ![...s.models][0].includes("/Users/"), `model string should be redacted: ${[...s.models]}`);
  });
});

// ── 4. Tool mapping ──

test("tool mapping: bash/edit/read/write/ls -> canonical names; Validation with arguments: [] does not throw and stays unmapped", () => {
  withRoot((root) => {
    writeSession(root, {
      lines: [
        sessionHeader("sess-tools", "/Users/erin/proj", T(0)),
        userMsg("u1", null, "do several things", T(1)),
        assistantMsg("a1", "u1", T(2), {
          content: [
            { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls -la" } },
            { type: "toolCall", id: "c2", name: "edit", arguments: { path: "src/x.js" } },
            { type: "toolCall", id: "c3", name: "read", arguments: { path: "src/y.js" } },
            { type: "toolCall", id: "c4", name: "write", arguments: { path: "src/z.js" } },
            { type: "toolCall", id: "c5", name: "ls", arguments: { path: "src" } },
            { type: "toolCall", id: "c6", name: "Validation", arguments: [] },
          ],
        }),
      ],
    });
    assert.doesNotThrow(() => readPi(join(root, "sessions")));
    const parsed = readPi(join(root, "sessions"));
    const toolUses = parsed.sessions[0].messages.flatMap((m) => m.toolUses);
    const byId = Object.fromEntries(toolUses.map((u) => [u.id, u]));
    assert.equal(byId.c1.name, "Bash");
    assert.equal(byId.c1.cmd, "ls -la");
    assert.equal(byId.c2.name, "Edit");
    assert.equal(byId.c2.path, "src/x.js");
    assert.equal(byId.c3.name, "Read");
    assert.equal(byId.c4.name, "Write");
    assert.equal(byId.c5.name, "Read", "ls should map to Read, matching opencode's list->Read precedent");
    assert.equal(byId.c6.name, "Validation", "unmapped tool falls through fallbackToolName unchanged");
  });
});

// ── 5. usage rename ──

test("usage: cacheWrite renames to cacheCreate; absent usage on an assistant message is null", () => {
  withRoot((root) => {
    writeSession(root, {
      lines: [
        sessionHeader("sess-usage", "/Users/frank/proj", T(0)),
        userMsg("u1", null, "go", T(1)),
        assistantMsg("a1", "u1", T(2), {
          content: [{ type: "text", text: "went" }],
          usage: { input: 100, output: 20, cacheRead: 10, cacheWrite: 5 },
        }),
        userMsg("u2", "a1", "go again", T(3)),
        assistantMsg("a2", "u2", T(4), { content: [{ type: "text", text: "went again" }] }),
      ],
    });
    const parsed = readPi(join(root, "sessions"));
    const [a1, a2] = parsed.sessions[0].messages.filter((m) => m.role === "assistant");
    assert.deepEqual(a1.usage, { input: 100, output: 20, cacheRead: 10, cacheCreate: 5 });
    assert.equal(a2.usage, null, "absent usage must be null, not undefined or {}");
  });
});

// ── 6. thinking / thinkingSignature lenses ──

test("thinking: thinking/thinkingSignature lengths land in thinkingChars/signatureChars; neither text is stored", () => {
  withRoot((root) => {
    writeSession(root, {
      lines: [
        sessionHeader("sess-thinking", "/Users/gina/proj", T(0)),
        userMsg("u1", null, "think about it", T(1)),
        assistantMsg("a1", "u1", T(2), {
          content: [
            { type: "thinking", thinking: "SECRET_THINKING_TEXT_ABC", thinkingSignature: "SECRET_SIGNATURE_XYZ" },
            { type: "text", text: "the answer" },
          ],
        }),
      ],
    });
    const parsed = readPi(join(root, "sessions"));
    const a1 = parsed.sessions[0].messages.find((m) => m.role === "assistant");
    assert.equal(a1.thinkingChars, "SECRET_THINKING_TEXT_ABC".length);
    assert.equal(a1.signatureChars, "SECRET_SIGNATURE_XYZ".length);
    const bundleJson = JSON.stringify(parsed);
    assert.ok(!bundleJson.includes("SECRET_THINKING_TEXT_ABC"), "thinking text leaked");
    assert.ok(!bundleJson.includes("SECRET_SIGNATURE_XYZ"), "thinkingSignature text leaked");
  });
});

// ── 7. compaction noise floor + slice ──

test("compaction: a long summary lands (redacted) in compactionSummaries; a sub-noise-floor one does not", () => {
  withRoot((root) => {
    const longSummary = "S".repeat(500) + " /Users/harold/proj secret-ish text";
    const shortSummary = "too short to count";
    writeSession(root, {
      lines: [
        sessionHeader("sess-compaction", "/Users/harold/proj", T(0)),
        compactionRec("comp1", null, longSummary, T(1)),
        compactionRec("comp2", "comp1", shortSummary, T(2)),
      ],
    });
    const parsed = readPi(join(root, "sessions"));
    assert.equal(parsed.compactionSummaries.length, 1, `expected exactly one surviving summary, got ${parsed.compactionSummaries.length}`);
    assert.ok(parsed.compactionSummaries[0].startsWith("S".repeat(50)));
    assert.ok(!parsed.compactionSummaries[0].includes("harold"), "username in compaction summary must be redacted");
    assert.ok(!parsed.compactionSummaries.some((c) => c.includes(shortSummary)), "sub-noise-floor summary must not land");
    const bundleJson = JSON.stringify(parsed);
    assert.ok(!bundleJson.includes(shortSummary), "sub-noise-floor summary leaked anywhere in the bundle");
  });
});

test("compaction threshold ordering: a summary whose PRE-redaction length clears the noise floor but whose POST-redaction length does not is NOT included (pins the post-redaction gate)", () => {
  withRoot((root) => {
    // Repeated emails collapse hard under redaction (~18 raw chars ->
    // "⟨email⟩ " = 8 redacted chars per repeat), so a run long enough to
    // clear the 200-char floor raw shrinks well under it once redacted.
    const rawSummary = "user@example.com ".repeat(15);
    const redactedPreview = redactText(rawSummary);
    assert.ok(rawSummary.length > 200, `fixture must exceed the noise floor pre-redaction, got ${rawSummary.length}`);
    assert.ok(redactedPreview.length < 200, `fixture must fall under the noise floor post-redaction, got ${redactedPreview.length}`);

    writeSession(root, {
      lines: [sessionHeader("sess-compaction-gate", "/Users/quinn/proj", T(0)), compactionRec("comp1", null, rawSummary, T(1))],
    });

    const parsed = readPi(join(root, "sessions"));
    assert.equal(
      parsed.compactionSummaries.length,
      0,
      "a summary that only clears the noise floor BEFORE redaction must not land — the gate checks the redacted length, not the raw one",
    );
    const bundleJson = JSON.stringify(parsed);
    assert.ok(!bundleJson.includes("user@example.com"), "the raw email text must never leak, gated out or not");
  });
});

// ── 8. toolResult: forId/bytes correct; content text never stored ──

test("toolResult: forId/bytes/isError correct; the result content text never appears in the serialized bundle", () => {
  withRoot((root) => {
    writeSession(root, {
      lines: [
        sessionHeader("sess-toolresult", "/Users/ivy/proj", T(0)),
        userMsg("u1", null, "run a command", T(1)),
        assistantMsg("a1", "u1", T(2), {
          content: [{ type: "toolCall", id: "call1", name: "bash", arguments: { command: "false" } }],
        }),
        toolResultMsg("tr1", "a1", "call1", "bash", "SECRET_TOOL_OUTPUT_TEXT boom", true, T(3)),
      ],
    });
    const parsed = readPi(join(root, "sessions"));
    const results = parsed.sessions[0].messages.flatMap((m) => m.toolResults);
    assert.equal(results.length, 1);
    const r = results[0];
    assert.equal(r.forId, "call1");
    assert.equal(r.isError, true);
    assert.equal(r.bytes, "SECRET_TOOL_OUTPUT_TEXT boom".length);
    const bundleJson = JSON.stringify(parsed);
    assert.ok(!bundleJson.includes("SECRET_TOOL_OUTPUT_TEXT"), "toolResult content text leaked");
  });
});

// ── 9. malformed JSON line ──

test("malformed JSON line increments files[].malformed; the rest of the session still parses", () => {
  withRoot((root) => {
    writeSession(root, {
      lines: [
        sessionHeader("sess-malformed", "/Users/jack/proj", T(0)),
        userMsg("u1", null, "hello", T(1)),
        "{not valid json,,,",
        assistantMsg("a1", "u1", T(2), { content: [{ type: "text", text: "hi there" }] }),
      ],
    });
    const parsed = readPi(join(root, "sessions"));
    assert.equal(parsed.files.length, 1);
    assert.equal(parsed.files[0].malformed, 1);
    assert.equal(parsed.stats.malformedLines, 1);
    assert.equal(parsed.sessions.length, 1);
    const s = parsed.sessions[0];
    assert.equal(s.messages.length, 2, `expected the user + assistant message to still parse, got ${JSON.stringify(s.messages.map((m) => m.role))}`);
    assert.equal(s.messages[1].textRedacted.trim(), "hi there");
  });
});

// ── 10. Absent root ──

test("absent root returns an EMPTY bundle, never throws", () => {
  const missing = join(tmpdir(), "pi-does-not-exist-" + Math.random().toString(36).slice(2));
  const parsed = readPi(missing);
  assert.equal(parsed.source, "pi");
  assert.deepEqual(parsed.sessions, []);
  assert.deepEqual(parsed.files, []);
  assert.deepEqual(parsed.compactionSummaries, []);
  assert.deepEqual(parsed.redaction, { hits: 0, charsRemoved: 0 });
  assert.equal(parsed.stats.malformedLines, 0);
  assert.equal(parsed.stats.projectDirCount, 0);
});

// ── 11. chain / ISO timestamps ──

test("chain: uuid/parentUuid/ts match the record's own id/parentId/timestamp; ISO ts survives Date.parse", () => {
  withRoot((root) => {
    writeSession(root, {
      lines: [
        sessionHeader("sess-chain", "/Users/kelly/proj", T(0)),
        userMsg("u1", null, "one", T(1)),
        assistantMsg("a1", "u1", T(2), { content: [{ type: "text", text: "one answer" }] }),
        userMsg("u2", "a1", "two", T(3)),
        assistantMsg("a2", "u2", T(4), { content: [{ type: "text", text: "two answer" }] }),
      ],
    });
    const parsed = readPi(join(root, "sessions"));
    const s = parsed.sessions[0];
    assert.equal(s.chain.length, 4);
    assert.deepEqual(s.chain.map((c) => c.uuid), ["u1", "a1", "u2", "a2"]);
    assert.deepEqual(s.chain.map((c) => c.parentUuid), [null, "u1", "a1", "u2"]);
    assert.deepEqual(s.messages.map((m) => m.uuid), s.chain.map((c) => c.uuid));
    assert.deepEqual(s.messages.map((m) => m.parentUuid), s.chain.map((c) => c.parentUuid));
    for (const m of s.messages) {
      assert.equal(typeof m.ts, "string");
      assert.ok(Number.isFinite(Date.parse(m.ts)), `ts not ISO: ${m.ts}`);
    }
    // firstTs also picks up the session-header timestamp (T(0)), not just
    // message records — same broad "any record with a ts" convention
    // claude-code.mjs uses. intensity.mjs already documents and handles a
    // session whose firstTs predates its first message.
    assert.equal(s.firstTs, T(0));
    assert.equal(s.lastTs, T(4));
  });
});

// ── 11b. <file name="...">...</file> injected user text is filtered ──

test('<file name="..."> injected turns are filtered: a whole message wrapped entirely in the tag is dropped, text never surfaces, userMessages count unaffected', () => {
  withRoot((root) => {
    writeSession(root, {
      dirCwd: "/Users/mona/skillproj",
      lines: [
        sessionHeader("sess-filetag", "/Users/mona/skillproj", T(0)),
        userMsg("u1", null, "please help me run the planner skill", T(1)),
        assistantMsg("a1", "u1", T(2), { content: [{ type: "text", text: "sure, here is the plan" }] }),
        userMsg(
          "u2",
          "a1",
          '<file name="/Users/mona/.pi/agent/skills/poc-p0-factory/prompts/01-planner.md">\nMARKER_FILETAG_TEXT stage 1 planner instructions\n</file>',
          T(3),
        ),
        userMsg("u3", "u2", "real follow-up question", T(4)),
      ],
    });

    const parsed = readPi(join(root, "sessions"));
    const s = parsed.sessions[0];
    const roles = s.messages.map((m) => m.role);
    assert.equal(roles.filter((r) => r === "user").length, 2, `expected exactly 2 real user messages, got roles ${JSON.stringify(roles)}`);
    assert.ok(!s.messages.some((m) => m.textRedacted.includes("MARKER_FILETAG_TEXT")), "file-tag dump text must not surface on any message");

    const bundleJson = JSON.stringify(parsed);
    assert.ok(!bundleJson.includes("MARKER_FILETAG_TEXT"), "file-tag dump text leaked anywhere in the bundle");

    const digest = buildDigest(mergeSources(parsed));
    assert.equal(digest.projects[0].userMessages, 2, "the injected file-tag dump must not inflate the userMessages count");
    assert.ok(
      !digest.projects[0].promptSamples.some((p) => p.includes("MARKER_FILETAG_TEXT")),
      "file-tag dump text must not surface in promptSamples",
    );
  });
});

test('<file name="..."> filtering is per block: mixing a file-tag block with a real block in the same message keeps only the real block', () => {
  withRoot((root) => {
    writeSession(root, {
      lines: [
        sessionHeader("sess-filetag-mixed", "/Users/mona/skillproj", T(0)),
        userMsgBlocks(
          "u1",
          null,
          [
            '<file name="/Users/mona/.pi/agent/skills/poc-p0-factory/prompts/01-planner.md">\nMARKER_MIXED_FILETAG_TEXT\n</file>',
            "MARKER_MIXED_REAL_TEXT actual human question",
          ],
          T(1),
        ),
        assistantMsg("a1", "u1", T(2), { content: [{ type: "text", text: "answering the mixed message" }] }),
      ],
    });

    const parsed = readPi(join(root, "sessions"));
    const s = parsed.sessions[0];
    assert.equal(s.messages.length, 2, `expected the mixed message to survive as one user turn, got roles ${JSON.stringify(s.messages.map((m) => m.role))}`);
    const [user, asst] = s.messages;
    assert.equal(user.role, "user");
    assert.ok(user.textRedacted.includes("MARKER_MIXED_REAL_TEXT"), "the real block must survive");
    assert.ok(!user.textRedacted.includes("MARKER_MIXED_FILETAG_TEXT"), "the file-tag-wrapped block must be dropped, not the whole message");
    assert.equal(asst.role, "assistant");

    const bundleJson = JSON.stringify(parsed);
    assert.ok(!bundleJson.includes("MARKER_MIXED_FILETAG_TEXT"), "file-tag dump text leaked anywhere in the bundle");
  });
});

test('guard: a real user message that merely mentions a <file name="..."> tag inline (not wrapping the whole block) survives', () => {
  withRoot((root) => {
    writeSession(root, {
      lines: [
        sessionHeader("sess-filetag-mention", "/Users/mona/skillproj", T(0)),
        userMsg("u1", null, 'why does my prompt include a <file name="x.md">...</file> block? is that expected?', T(1)),
        assistantMsg("a1", "u1", T(2), { content: [{ type: "text", text: "yes, that's the skill machinery re-injecting file contents" }] }),
      ],
    });

    const parsed = readPi(join(root, "sessions"));
    const s = parsed.sessions[0];
    assert.equal(s.messages.length, 2, 'a message that merely mentions a <file name="..."> tag inline (not wrapping the whole block) must survive');
    assert.equal(s.messages[0].role, "user");
    assert.ok(s.messages[0].textRedacted.includes('<file name="x.md">'));
  });
});

// ── 12. Smoke-run through the shared lenses ──

test("smoke: bundle flows through buildDigest + computeAgenticLiteracy + computeIntensity without throwing, session is counted", () => {
  withRoot((root) => {
    writeSession(root, {
      lines: [
        sessionHeader("sess-smoke", "/Users/liam/product", T(0)),
        modelChange("mc1", null, "openrouter", "openai/gpt-5.6", T(1)),
        userMsg("u1", "mc1", "fix the bug in app.py", T(2)),
        assistantMsg("a1", "u1", T(3), {
          content: [
            { type: "toolCall", id: "call1", name: "bash", arguments: { command: "pytest" } },
            { type: "text", text: "fixed it, tests pass" },
          ],
        }),
        toolResultMsg("tr1", "a1", "call1", "bash", "all green", false, T(4)),
      ],
    });

    const parsed = mergeSources(readPi(join(root, "sessions")));
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

// ── 12b. session with only unrecognized record types (plus the header) ──

test("session with only unrecognized record types (plus the header): messages stay empty, firstTs/lastTs come only from the recognized (header) timestamp, lenses don't throw", () => {
  withRoot((root) => {
    writeSession(root, {
      lines: [
        sessionHeader("sess-unrecognized", "/Users/petra/proj", T(0)),
        { type: "totally_unknown_type_a", id: "u1", parentId: null, timestamp: T(1) },
        { type: "totally_unknown_type_b", id: "u2", parentId: "u1", timestamp: T(5) },
      ],
    });

    const parsed = readPi(join(root, "sessions"));
    assert.equal(parsed.sessions.length, 1);
    const s = parsed.sessions[0];
    assert.equal(s.messages.length, 0, "no `message` records means no messages, regardless of the other record types present");
    assert.equal(s.firstTs, T(0), "only the header's timestamp is a recognized session-ts source here");
    assert.equal(s.lastTs, T(0), "unrecognized record types must never call stampSessionTs, despite carrying a timestamp field");

    const merged = mergeSources(parsed);
    assert.doesNotThrow(() => buildDigest(merged));
    assert.doesNotThrow(() => computeAgenticLiteracy(merged));
    assert.doesNotThrow(() => computeIntensity(merged));
  });
});

// ── 13. fingerprint totals.messages must not count pi's toolResult rows ──

test("fingerprint: totals.messages counts only user/assistant rows, not pi's toolResult rows", () => {
  withRoot((root) => {
    writeSession(root, {
      lines: [
        sessionHeader("sess-fp", "/Users/nora/proj", T(0)),
        userMsg("u1", null, "run the tests", T(1)),
        assistantMsg("a1", "u1", T(2), {
          content: [{ type: "toolCall", id: "call1", name: "bash", arguments: { command: "pytest" } }],
        }),
        toolResultMsg("tr1", "a1", "call1", "bash", "all green", false, T(3)),
        userMsg("u2", "tr1", "thanks", T(4)),
        assistantMsg("a2", "u2", T(5), { content: [{ type: "text", text: "you're welcome" }] }),
      ],
    });
    const parsed = mergeSources(readPi(join(root, "sessions")));
    const s = parsed.sessions[0];
    const toolResultRows = s.messages.filter((m) => m.role === "toolResult").length;
    assert.equal(toolResultRows, 1, "fixture must actually contain a toolResult row for this assertion to be meaningful");
    const fp = computeFingerprint(parsed);
    const conversationTurns = s.messages.filter((m) => m.role === "user" || m.role === "assistant").length;
    assert.equal(conversationTurns, 4, "2 user + 2 assistant rows");
    assert.equal(fp.totals.messages, conversationTurns, "totals.messages must count only user/assistant rows, excluding the toolResult row");
  });
});

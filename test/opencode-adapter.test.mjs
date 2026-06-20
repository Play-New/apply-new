// opencode adapter: verifies the JSON storage is normalised into the shared
// session model, that opencode's tool vocabulary is mapped onto the canonical
// names the lenses speak, that subagent child-sessions roll up to their parent
// product, and that nothing private (tool output, reasoning text, secrets in
// commands) leaks. Drives the REAL adapter against a synthetic storage tree,
// then runs the result through the digest, agentic-literacy, and intensity
// lenses (intensity specifically because the timestamp bug — epoch numbers
// stored where ISO strings are expected — silently drops every opencode
// session from activeDays/streak on realistic data).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readOpencode, mergeSources } from "../src/adapters/opencode.mjs";
import { buildDigest } from "../src/digest.mjs";
import { computeAgenticLiteracy } from "../src/agentic-literacy.mjs";
import { computeIntensity } from "../src/intensity.mjs";

const PARENT_CWD = "C:\\Users\\alice\\Documents\\proj\\my-product";
const CHILD_CWD = "C:\\Users\\alice\\Documents\\proj\\other-thing";

// Build a minimal opencode storage tree on disk and return its root.
function makeStorage() {
  const root = join(mkdtempSync(join(tmpdir(), "oc-")), "storage");
  const w = (rel, obj) => {
    const p = join(root, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, JSON.stringify(obj));
  };

  // sessions (child links to parent via parentID)
  w("session/projA/ses_parent.json", {
    id: "ses_parent", version: "1.1.51", projectID: "projA",
    directory: PARENT_CWD, title: "build api", time: { created: 1, updated: 9 },
  });
  w("session/projA/ses_child.json", {
    id: "ses_child", version: "1.1.51", projectID: "projA", parentID: "ses_parent",
    directory: CHILD_CWD, title: "subagent", time: { created: 2, updated: 8 },
  });

  // parent messages
  w("message/ses_parent/msg_u.json", { id: "msg_u", sessionID: "ses_parent", role: "user", time: { created: 1000 } });
  w("message/ses_parent/msg_a.json", {
    id: "msg_a", sessionID: "ses_parent", role: "assistant", parentID: "msg_u",
    providerID: "qwen", modelID: "qwen-coder", time: { created: 2000 },
  });
  w("part/msg_u/prt_1.json", { id: "prt_1", type: "text", text: "build the api and run it" });
  w("part/msg_a/prt_reason.json", { id: "prt_reason", type: "reasoning", text: "SECRET_REASONING_TEXT_should_not_be_stored" });
  w("part/msg_a/prt_edit.json", {
    id: "prt_edit", type: "tool", callID: "c1", tool: "edit",
    state: { status: "completed", input: { filePath: "C:\\Users\\alice\\Documents\\proj\\my-product\\api\\main.py", newString: "x" }, output: "OK" },
  });
  w("part/msg_a/prt_bash.json", {
    id: "prt_bash", type: "tool", callID: "c2", tool: "bash",
    state: { status: "completed", input: { command: "API_KEY=supersecretvalue123 uvicorn api.main:app --reload" }, output: "running on 8000" },
  });
  w("part/msg_a/prt_task.json", {
    id: "prt_task", type: "tool", callID: "c3", tool: "task",
    state: { status: "completed", input: { subagent_type: "general", description: "run tests", prompt: "test it" } },
  });
  w("part/msg_a/prt_mcp.json", {
    id: "prt_mcp", type: "tool", callID: "c4", tool: "render_list_logs",
    state: { status: "completed", input: { serviceId: "abc" }, output: "logs" },
  });
  w("part/msg_a/prt_step.json", {
    id: "prt_step", type: "step-finish", tokens: { input: 1200, output: 80, reasoning: 40, cache: { read: 300, write: 0 } },
  });

  // child (subagent) message — edits within its own dir
  w("message/ses_child/msg_c.json", {
    id: "msg_c", sessionID: "ses_child", role: "assistant",
    providerID: "qwen", modelID: "qwen-coder", time: { created: 3000 },
  });
  w("part/msg_c/prt_e.json", {
    id: "prt_e", type: "tool", callID: "c5", tool: "write",
    state: { status: "completed", input: { filePath: "C:\\Users\\alice\\Documents\\proj\\other-thing\\worker.py", content: "y" }, output: "OK" },
  });

  return root;
}

function withStorage(fn) {
  const root = makeStorage();
  try { return fn(root); } finally { rmSync(join(root, ".."), { recursive: true, force: true }); }
}

test("adapter normalises sessions, paths, timestamps, and model", () => {
  withStorage((root) => {
    const parsed = readOpencode(root);
    assert.equal(parsed.sessions.length, 2);
    const parent = parsed.sessions.find((s) => s.sessionId === "ses_parent");
    assert.ok(!parent.cwdRedacted.includes("\\"), `cwd not POSIX: ${parent.cwdRedacted}`);
    assert.ok(parent.cwdRedacted.includes("⟨user⟩"), "username should be redacted");
    const asst = parent.messages.find((m) => m.role === "assistant");
    assert.equal(typeof asst.ts, "string");
    assert.ok(asst.ts.includes("T") && asst.ts.endsWith("Z"), `ts not ISO: ${asst.ts}`);
    assert.equal(asst.model, "qwen/qwen-coder");
    assert.ok(asst.usage && asst.usage.input === 1200 && asst.usage.cacheRead === 300);
  });
});

test("opencode tool vocabulary maps onto canonical names (incl. MCP)", () => {
  withStorage((root) => {
    const parsed = readOpencode(root);
    const names = parsed.sessions
      .flatMap((s) => s.messages).flatMap((m) => m.toolUses).map((u) => u.name);
    assert.ok(names.includes("Edit"));
    assert.ok(names.includes("Bash"));
    assert.ok(names.includes("Task"));
    assert.ok(names.includes("mcp__render__list_logs"), `got: ${names.join(",")}`);
  });
});

test("privacy: tool output dropped, reasoning text not stored, secrets redacted", () => {
  withStorage((root) => {
    const parsed = readOpencode(root);
    const all = JSON.stringify(parsed.sessions);
    assert.ok(!all.includes("SECRET_REASONING_TEXT"), "reasoning text leaked");
    assert.ok(!all.includes("supersecretvalue123"), "secret in command leaked");
    assert.ok(!all.includes("running on 8000"), "tool output leaked");
    // reasoning still counted as a depth proxy
    const reasoned = parsed.sessions.flatMap((s) => s.messages).some((m) => m.thinkingChars > 0);
    assert.ok(reasoned, "reasoning length not captured");
  });
});

test("subagent child-sessions roll up to the parent product", () => {
  withStorage((root) => {
    const parsed = readOpencode(root);
    assert.equal(parsed.stats.rolledUpSubagentSessions, 1);
    const child = parsed.sessions.find((s) => s.sessionId === "ses_child");
    const parent = parsed.sessions.find((s) => s.sessionId === "ses_parent");
    assert.equal(child.cwdRedacted, parent.cwdRedacted, "child should inherit parent cwd");
  });
});

test("end-to-end: digest + agentic-literacy recover areas, tech, and delegations", () => {
  withStorage((root) => {
    const parsed = mergeSources(readOpencode(root));
    const digest = buildDigest(parsed);
    // child rolled into parent → a single product, both sessions counted.
    assert.equal(digest.projects.length, 1);
    const proj = digest.projects[0];
    assert.equal(proj.repo, "my-product");
    assert.equal(proj.sessions, 2);
    assert.ok(Object.keys(proj.topAreas).includes("api/main.py"), JSON.stringify(proj.topAreas));
    assert.ok(proj.tech.includes("Python"), JSON.stringify(proj.tech));
    assert.ok(proj.tech.includes("FastAPI"), JSON.stringify(proj.tech));

    const a = computeAgenticLiteracy(parsed);
    assert.ok(a.uses.subagentDelegations >= 1, "Task delegation not counted");
    assert.ok(a.uses.customMcp.calls + a.uses.publicMcp.calls >= 1, "MCP call not counted");
  });
});

test("session-level firstTs/lastTs are ISO strings (intensity expects them, not epoch numbers)", () => {
  // downstream lenses (intensity.mjs:43-44) do Date.parse(s.firstTs). If the
  // opencode adapter stored epoch-ms numbers, Date.parse coerces to
  // "1748772000000" which is not a valid ISO date → NaN → sessions contribute
  // 0 active days.
  withStorage((root) => {
    const parsed = readOpencode(root);
    for (const s of parsed.sessions) {
      assert.equal(typeof s.firstTs, "string", `firstTs should be string, got ${typeof s.firstTs} (${s.firstTs}) for ${s.sessionId}`);
      assert.equal(typeof s.lastTs, "string", `lastTs should be string, got ${typeof s.lastTs} (${s.lastTs}) for ${s.sessionId}`);
      assert.ok(Number.isFinite(Date.parse(s.firstTs)), `firstTs not parseable: ${s.firstTs}`);
      assert.ok(Number.isFinite(Date.parse(s.lastTs)), `lastTs not parseable: ${s.lastTs}`);
    }
  });
});

test("end-to-end: intensity picks up opencode sessions on realistic timestamps (not silently dropped)", () => {
  // The shared fixture uses small epoch values (1000-3000 ms) which Date.parse
  // happens to interpret as AD years 1000-3000 — so the bug only fires on
  // realistic timestamps. Build a separate storage tree with realistic
  // 2025-era epoch ms and verify intensity picks the sessions up.
  const root = join(mkdtempSync(join(tmpdir(), "oc-real-")), "storage");
  const w = (rel, obj) => {
    const p = join(root, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, JSON.stringify(obj));
  };
  const DAY1 = Date.UTC(2025, 5, 1, 10, 0, 0); // 2025-06-01
  const DAY2 = Date.UTC(2025, 5, 2, 11, 0, 0); // 2025-06-02
  w("session/projA/ses_one.json", {
    id: "ses_one", version: "1.1.51", projectID: "projA",
    directory: "C:\\Users\\alice\\proj", time: { created: DAY1, updated: DAY1 + 1000 },
  });
  w("session/projA/ses_two.json", {
    id: "ses_two", version: "1.1.51", projectID: "projA",
    directory: "C:\\Users\\alice\\proj", time: { created: DAY2, updated: DAY2 + 1000 },
  });
  w("message/ses_one/m.json", { id: "m1", sessionID: "ses_one", role: "assistant", time: { created: DAY1 } });
  w("message/ses_two/m.json", { id: "m2", sessionID: "ses_two", role: "assistant", time: { created: DAY2 } });
  try {
    const parsed = mergeSources(readOpencode(root));
    const intensity = computeIntensity(parsed);
    assert.ok(intensity !== null, "intensity should be non-null when there are sessions");
    assert.equal(intensity.activeDays, 2, `expected 2 active days, got ${intensity.activeDays} (sessions dropped silently)`);
  } finally {
    rmSync(join(root, ".."), { recursive: true, force: true });
  }
});
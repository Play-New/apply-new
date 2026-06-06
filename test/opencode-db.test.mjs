// opencode sqlite backend: builds a minimal opencode.db mirroring the real
// schema, then asserts readOpencodeDb produces the same normalised session
// model as the JSON path (vocabulary mapping, tokens, subagent rollup). Skips
// cleanly on Node < 22.5 where node:sqlite is unavailable, so CI there stays
// green and the JSON path remains the covered backend.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { readOpencodeDb } from "../src/adapters/opencode.mjs";

const require = createRequire(import.meta.url);
let sqlite = null;
try { sqlite = require("node:sqlite"); } catch { /* Node < 22.5 */ }

const PARENT_CWD = "C:\\Users\\alice\\Documents\\proj\\my-product";

function makeDb() {
  const dir = mkdtempSync(join(tmpdir(), "oc-db-"));
  const path = join(dir, "opencode.db");
  const db = new sqlite.DatabaseSync(path);
  db.exec(`
    CREATE TABLE session (id TEXT, parent_id TEXT, directory TEXT, version TEXT);
    CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
  `);
  const sess = db.prepare("INSERT INTO session VALUES (?,?,?,?)");
  sess.run("ses_parent", null, PARENT_CWD, "1.1.51");
  sess.run("ses_child", "ses_parent", "C:\\Users\\alice\\Documents\\proj\\other-thing", "1.1.51");

  const msg = db.prepare("INSERT INTO message VALUES (?,?,?,?)");
  msg.run("msg_a", "ses_parent", 2000, JSON.stringify({ role: "assistant", providerID: "qwen", modelID: "qwen-coder", parentID: "msg_u", time: { created: 2000 } }));
  msg.run("msg_c", "ses_child", 3000, JSON.stringify({ role: "assistant", providerID: "qwen", modelID: "qwen-coder", time: { created: 3000 } }));

  const part = db.prepare("INSERT INTO part VALUES (?,?,?,?,?)");
  const P = (id, mid, t, obj) => part.run(id, mid, "ses_parent", t, JSON.stringify(obj));
  P("p1", "msg_a", 1, { type: "reasoning", text: "SECRET_REASONING" });
  P("p2", "msg_a", 2, { type: "tool", callID: "c1", tool: "edit", state: { status: "completed", input: { filePath: PARENT_CWD + "\\api\\main.py" }, output: "OK" } });
  P("p3", "msg_a", 3, { type: "tool", callID: "c2", tool: "bash", state: { status: "completed", input: { command: "API_KEY=supersecretvalue123 uvicorn api.main:app" }, output: "up" } });
  P("p4", "msg_a", 4, { type: "tool", callID: "c3", tool: "task", state: { status: "completed", input: { subagent_type: "general", prompt: "go" } } });
  P("p5", "msg_a", 5, { type: "tool", callID: "c4", tool: "render_list_logs", state: { status: "completed", input: {}, output: "logs" } });
  P("p6", "msg_a", 6, { type: "step-finish", tokens: { input: 1200, output: 80, cache: { read: 300, write: 0 } } });
  part.run("p7", "msg_c", "ses_child", 1, JSON.stringify({ type: "tool", callID: "c5", tool: "write", state: { status: "completed", input: { filePath: "C:\\Users\\alice\\Documents\\proj\\other-thing\\worker.py" }, output: "OK" } }));
  db.close();
  return { dir, path };
}

test("sqlite backend normalises sessions, tools, tokens, and rolls up subagents", { skip: sqlite ? false : "node:sqlite unavailable" }, () => {
  const { dir, path } = makeDb();
  try {
    const parsed = readOpencodeDb(path);
    assert.equal(parsed.sessions.length, 2);
    const parent = parsed.sessions.find((s) => s.sessionId === "ses_parent");
    assert.ok(!parent.cwdRedacted.includes("\\") && parent.cwdRedacted.includes("⟨user⟩"));
    const asst = parent.messages.find((m) => m.role === "assistant");
    assert.equal(asst.model, "qwen/qwen-coder");
    assert.ok(asst.ts.endsWith("Z"));
    assert.ok(asst.usage && asst.usage.input === 1200 && asst.usage.cacheRead === 300);

    const names = parsed.sessions.flatMap((s) => s.messages).flatMap((m) => m.toolUses).map((u) => u.name);
    assert.ok(names.includes("Edit") && names.includes("Bash") && names.includes("Task"));
    assert.ok(names.includes("mcp__render__list_logs"), names.join(","));

    const dump = JSON.stringify(parsed.sessions);
    assert.ok(!dump.includes("SECRET_REASONING") && !dump.includes("supersecretvalue123") && !dump.includes('"up"'));

    assert.equal(parsed.stats.rolledUpSubagentSessions, 1);
    const child = parsed.sessions.find((s) => s.sessionId === "ses_child");
    assert.equal(child.cwdRedacted, parent.cwdRedacted);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Follow-up fixes from the PR #3 review:
//  - public MCP servers recorded by opencode (bare lowercase ids) are classified
//    public, not custom/proprietary;
//  - the JSON backend reconstructs messages in creation-time order (matching the
//    sqlite ORDER BY time_created), not reverse-chronological filename order;
//  - the sqlite session read is deterministic (ORDER BY id);
//  - a subagent child whose parent is absent from the read set is disclosed in
//    stats instead of silently standing as an extra product.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { readOpencode, readOpencodeJson, readOpencodeDb } from "../src/adapters/opencode.mjs";
import { computeAgenticLiteracy } from "../src/agentic-literacy.mjs";

const require = createRequire(import.meta.url);
let sqlite = null;
try { sqlite = require("node:sqlite"); } catch { /* Node < 22.5 */ }

const mkStorage = () => join(mkdtempSync(join(tmpdir(), "oc-fu-")), "storage");
const writer = (root) => (rel, obj) => {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(obj));
};
const session = (source, toolNames) => ({
  source,
  messages: [{ role: "assistant", ts: "2026-05-01T10:00:00.000Z", textRedacted: "",
    toolUses: toolNames.map((name) => ({ name, path: "", cmd: "", q: "" })) }],
});

test("opencode-style public MCP (bare lowercase id) is classified public, not custom", () => {
  // opencode's mapTool emits mcp__github__create_issue; the whitelist is
  // claude_ai_GitHub-shaped. Normalised matching must bucket it public.
  const a = computeAgenticLiteracy({ sessions: [
    session("opencode", ["mcp__github__create_issue", "mcp__supabase__query", "mcp__acme_internal__deploy"]),
  ]});
  assert.equal(a.uses.publicMcp.calls, 2, "github + supabase should be public");
  assert.equal(a.uses.publicMcp.servers, 2);
  assert.equal(a.uses.customMcp.calls, 1, "only acme_internal is custom");
  assert.equal(a.uses.customMcp.servers, 1);
});

test("Claude-Code-shaped public MCP still classifies public (no regression)", () => {
  const a = computeAgenticLiteracy({ sessions: [
    session("claude-code", ["mcp__claude_ai_GitHub__create_issue", "mcp__plugin_supabase_supabase__query"]),
  ]});
  assert.equal(a.uses.publicMcp.calls, 2);
  assert.equal(a.uses.customMcp.calls, 0);
});

test("JSON backend reconstructs messages in creation-time order (not filename order)", () => {
  const root = mkStorage();
  const w = writer(root);
  // Filename sort puts m_aaa before m_bbb, but m_aaa is the NEWER message.
  // After the fix, ingestion order follows time.created (ascending).
  w("session/p/ses.json", { id: "ses", directory: "C:\\Users\\alice\\proj", time: { created: 1000 } });
  w("message/ses/m_aaa.json", { id: "m_aaa", sessionID: "ses", role: "assistant", time: { created: 5000 } });
  w("message/ses/m_bbb.json", { id: "m_bbb", sessionID: "ses", role: "user", time: { created: 1000 } });
  try {
    const parsed = readOpencodeJson(root);
    const msgs = parsed.sessions[0].messages;
    assert.equal(msgs.length, 2);
    assert.ok(Date.parse(msgs[0].ts) < Date.parse(msgs[1].ts),
      `messages out of chronological order: ${msgs.map((m) => m.ts).join(", ")}`);
    assert.equal(msgs[0].uuid, "m_bbb", "the earlier message must be ingested first");
  } finally {
    rmSync(join(root, ".."), { recursive: true, force: true });
  }
});

test("subagent child with an absent parent is disclosed in stats (orphaned), not silently a product", () => {
  const root = mkStorage();
  const w = writer(root);
  w("session/p/ses_child.json", { id: "ses_child", parentID: "ses_GONE",
    directory: "C:\\Users\\alice\\proj\\sub", time: { created: 2 } });
  w("message/ses_child/m.json", { id: "mc", sessionID: "ses_child", role: "assistant", time: { created: 3000 } });
  try {
    const parsed = readOpencode(root);
    assert.equal(parsed.stats.rolledUpSubagentSessions, 0);
    assert.equal(parsed.stats.orphanedSubagentSessions, 1,
      "a child whose parent is absent should be counted as orphaned");
    assert.equal(parsed.sessions.length, 1);
  } finally {
    rmSync(join(root, ".."), { recursive: true, force: true });
  }
});

test("sqlite session read is deterministic (ORDER BY id, not physical row order)", { skip: sqlite ? false : "node:sqlite unavailable" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-fu-db-"));
  const path = join(dir, "opencode.db");
  const db = new sqlite.DatabaseSync(path);
  db.exec(`
    CREATE TABLE session (id TEXT, parent_id TEXT, directory TEXT, version TEXT);
    CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
  `);
  const sess = db.prepare("INSERT INTO session VALUES (?,?,?,?)");
  // Inserted OUT of id order on purpose.
  sess.run("ses_c", null, "C:\\Users\\alice\\proj\\c", "1");
  sess.run("ses_a", null, "C:\\Users\\alice\\proj\\a", "1");
  sess.run("ses_b", null, "C:\\Users\\alice\\proj\\b", "1");
  db.close();
  try {
    const parsed = readOpencodeDb(path);
    assert.deepEqual(parsed.sessions.map((s) => s.sessionId), ["ses_a", "ses_b", "ses_c"],
      "sessions must come back in deterministic id order");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

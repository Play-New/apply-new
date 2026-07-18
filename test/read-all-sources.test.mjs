// Source-resolution flags: verifies the boolean flags --no-opencode and
// --opencode-json do what PRIVACY.md promises. Both are the privacy escape
// hatches and the backend selector — getting them wrong is a silent feature
// break, so each is exercised end-to-end against a synthetic storage tree.
//
// Every fixture's `sources` object explicitly disables every source not under
// test (including cursor and kimi, once registered below) — this machine (and
// any contributor's) can have real ~/.claude, ~/.codex, ~/.pi, ~/.cursor, and
// ~/.kimi-code data on disk, and a test that forgets to opt one of them out
// would silently pick up whatever real logs happen to exist there.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readAllSources } from "../src/sources.mjs";

const require = createRequire(import.meta.url);
// node:sqlite is experimental and only present on Node >= 22.5 — same gate as
// test/opencode-db.test.mjs and test/cursor-adapter.test.mjs. The cursor
// fixture below needs it to build a store.db; when unavailable, the whole
// cursor merge-case block skips cleanly so the Node-20 CI leg stays green.
let sqlite = null;
try {
  sqlite = require("node:sqlite");
} catch {
  /* Node < 22.5 */
}

// Build a minimal codex sessions tree on disk: one rollout file (= one
// session) with a session_meta line + one user + one assistant response_item,
// mirroring test/codex-adapter.test.mjs's helper but trimmed to the minimum
// readAllSources needs to prove a session merged in.
function makeCodexSessions() {
  const root = join(mkdtempSync(join(tmpdir(), "cx-")), "sessions");
  const dir = join(root, "2026", "01", "02");
  mkdirSync(dir, { recursive: true });
  const lines = [
    { timestamp: "2026-01-02T03:04:05.000Z", type: "session_meta", payload: { id: "cx-one", cwd: "/Users/dee/proj", originator: "codex-tui", cli_version: "0.60.0", model_provider: "openai" } },
    { timestamp: "2026-01-02T03:04:06.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] } },
    { timestamp: "2026-01-02T03:04:07.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi there" }] } },
  ];
  writeFileSync(
    join(dir, "rollout-2026-01-02T03-04-05-11111111-1111-1111-1111-111111111111.jsonl"),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
  return root;
}

// Build a minimal pi sessions tree on disk: one project dir containing one
// session file (= one session) with a session header + one user + one
// assistant message, mirroring test/pi-adapter.test.mjs's helper but trimmed
// to the minimum readAllSources needs to prove a session merged in. Returned
// root is the "sessions" dir itself, matching what defaultPiRoot() resolves to.
function makePiSessions() {
  const root = join(mkdtempSync(join(tmpdir(), "pi-")), "sessions");
  const dir = join(root, "--Users-dee-proj--");
  mkdirSync(dir, { recursive: true });
  const lines = [
    { type: "session", id: "pi-one", timestamp: "2026-01-02T03:04:05.000Z", version: 3, cwd: "/Users/dee/proj" },
    { type: "message", id: "m1", parentId: null, timestamp: "2026-01-02T03:04:06.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: "2026-01-02T03:04:06.000Z" } },
    { type: "message", id: "m2", parentId: "m1", timestamp: "2026-01-02T03:04:07.000Z", message: { role: "assistant", content: [{ type: "text", text: "hi there" }], timestamp: "2026-01-02T03:04:07.000Z" } },
  ];
  writeFileSync(
    join(dir, "2026-01-02T03-04-05-000Z_11111111-1111-1111-1111-111111111111.jsonl"),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
  return root;
}

// ── Minimal hand-rolled protobuf ENCODER (mirrors what pbFields in
// src/adapters/cursor.mjs reads), trimmed to just what a root blob needs:
// field 1 (repeated message hashes) and field 9 (cwd, as a file:// URI).
// test/cursor-adapter.test.mjs has a fuller version of this encoder plus its
// own makeCursorSession helper, but neither is exported, so this is an
// independent, deliberately minimal, inline copy.
function encodeVarint(n) {
  let v = typeof n === "bigint" ? n : BigInt(n);
  const bytes = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    bytes.push(b);
  } while (v > 0n);
  return Buffer.from(bytes);
}
function encodeTag(fieldNo, wireType) {
  return encodeVarint((fieldNo << 3) | wireType);
}
function fieldBytes(fieldNo, buf) {
  return Buffer.concat([encodeTag(fieldNo, 2), encodeVarint(buf.length), buf]);
}
function fieldString(fieldNo, str) {
  return fieldBytes(fieldNo, Buffer.from(str, "utf8"));
}

// Build a minimal cursor chats tree on disk: <root>/<hexDir>/<uuidDir>/store.db
// with the real two-table schema (meta, blobs), one user-query message blob,
// a root blob referencing it via field 1 + a cwd via field 9, and a meta row
// pointing at that root. Mirrors test/cursor-adapter.test.mjs's
// makeCursorSession but trimmed to the minimum readAllSources needs to prove
// a session merged in. Requires node:sqlite — only call behind the sqlite gate.
function makeCursorSessions() {
  const root = mkdtempSync(join(tmpdir(), "cu-"));
  const hexDir = "abc123hexdir00000000000000000000";
  const uuidDir = "11111111-1111-1111-1111-111111111111";
  const dir = join(root, hexDir, uuidDir);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "store.db");
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE meta (key TEXT, value TEXT);
    CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);
  `);
  const insBlob = db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)");

  const userMsg = {
    role: "user",
    content: [{ type: "text", text: "<timestamp>Saturday, Jul 18, 2026, 6:16 AM (UTC)</timestamp>\n<user_query>\nhello\n</user_query>" }],
  };
  const msgData = Buffer.from(JSON.stringify(userMsg), "utf8");
  const msgHash = createHash("sha256").update(msgData).digest();
  insBlob.run(msgHash.toString("hex"), msgData);

  const rootBuf = Buffer.concat([fieldBytes(1, msgHash), fieldString(9, "file:///Users/dee/proj")]);
  const rootId = createHash("sha256").update(rootBuf).digest("hex");
  insBlob.run(rootId, rootBuf);

  const metaObj = { agentId: "cu-one", latestRootBlobId: rootId, name: "ignored", createdAt: Date.parse("2026-01-02T03:04:05.000Z") };
  const metaHex = Buffer.from(JSON.stringify(metaObj), "utf8").toString("hex");
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("0", metaHex);
  db.close();
  return root;
}

// Build a minimal kimi sessions tree on disk: one wd_*/session_* dir with a
// state.json (workDir only — title/lastPrompt are irrelevant here) and one
// agents/main/wire.jsonl containing a single user message, mirroring
// test/kimi-adapter.test.mjs's helper but trimmed to the minimum
// readAllSources needs to prove a session merged in. Returned root is the
// "sessions" dir itself, matching what defaultKimiRoot() resolves to.
function makeKimiSessions() {
  const root = join(mkdtempSync(join(tmpdir(), "ki-")), "sessions");
  const sessionDir = join(root, "wd_proj_abcdef123456", "session_ki-one");
  const agentDir = join(sessionDir, "agents", "main");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(sessionDir, "state.json"), JSON.stringify({
    createdAt: "2026-01-02T03:04:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
    title: "ignored", isCustomTitle: false,
    agents: { main: { type: "main", parentAgentId: null } },
    custom: {}, workDir: "/Users/dee/proj", lastPrompt: "ignored",
  }));
  const lines = [
    { type: "context.append_message", time: Date.parse("2026-01-02T03:04:06.000Z"), message: { role: "user", content: [{ type: "text", text: "hello" }], toolCalls: [], origin: { kind: "user" } } },
  ];
  writeFileSync(join(agentDir, "wire.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return root;
}

// Build a minimal opencode JSON storage tree on disk.
function makeOpencodeStorage() {
  const root = join(mkdtempSync(join(tmpdir(), "oc-")), "storage");
  const w = (rel, obj) => {
    const p = join(root, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, JSON.stringify(obj));
  };
  w("session/projA/ses_one.json", {
    id: "ses_one", version: "1.1.51", projectID: "projA",
    directory: "C:\\Users\\alice\\proj", title: "first session",
    time: { created: 1000, updated: 2000 },
  });
  w("message/ses_one/msg_u.json", { id: "msg_u", sessionID: "ses_one", role: "user", time: { created: 1000 } });
  w("message/ses_one/msg_a.json", { id: "msg_a", sessionID: "ses_one", role: "assistant", parentID: "msg_u", time: { created: 2000 } });
  return root;
}

// Empty claude-code root — readClaudeCode returns zero sessions, zero files.
function emptyClaudeRoot() {
  return mkdtempSync(join(tmpdir(), "cc-"));
}

test("--no-opencode produces a claude-code-only bundle (privacy escape hatch)", () => {
  const ocRoot = makeOpencodeStorage();
  const claudeRoot = emptyClaudeRoot();
  try {
    const parsed = readAllSources({
      claudeRoot,
      // codex explicitly disabled so this doesn't pick up whatever real
      // codex data happens to exist on the machine running the suite.
      sources: { opencode: { root: ocRoot, disabled: true, json: false }, codex: { disabled: true }, pi: { disabled: true }, cursor: { disabled: true }, kimi: { disabled: true } },
    });
    // The opencode storage tree on disk has 1 session; with --no-opencode it
    // must NOT appear in the bundle.
    assert.equal(parsed.sessions.length, 0, `expected 0 sessions, got ${parsed.sessions.length}: ${JSON.stringify(parsed.sessions.map(s => s.sessionId))}`);
  } finally {
    rmSync(join(ocRoot, ".."), { recursive: true, force: true });
    rmSync(claudeRoot, { recursive: true, force: true });
  }
});

test("without --no-opencode, opencode sessions are included in the bundle", () => {
  const ocRoot = makeOpencodeStorage();
  const claudeRoot = emptyClaudeRoot();
  try {
    const parsed = readAllSources({
      claudeRoot,
      sources: { opencode: { root: ocRoot, disabled: false, json: false }, codex: { disabled: true }, pi: { disabled: true }, cursor: { disabled: true }, kimi: { disabled: true } },
    });
    assert.equal(parsed.sessions.length, 1, `expected 1 session, got ${parsed.sessions.length}`);
    assert.equal(parsed.sessions[0].sessionId, "ses_one");
    assert.equal(parsed.sessions[0].source, "opencode");
  } finally {
    rmSync(join(ocRoot, ".."), { recursive: true, force: true });
    rmSync(claudeRoot, { recursive: true, force: true });
  }
});

test("--no-opencode=true takes precedence over a present opencode root", () => {
  // Same as the first test, but phrased with the flag explicitly true. Catches
  // a future refactor where the default flips or the check is removed.
  const ocRoot = makeOpencodeStorage();
  const claudeRoot = emptyClaudeRoot();
  try {
    const parsed = readAllSources({
      claudeRoot,
      sources: { opencode: { root: ocRoot, disabled: true, json: false }, codex: { disabled: true }, pi: { disabled: true }, cursor: { disabled: true }, kimi: { disabled: true } },
    });
    for (const s of parsed.sessions) {
      assert.notEqual(s.source, "opencode", `opencode session leaked despite noOpencode=true: ${s.sessionId}`);
    }
  } finally {
    rmSync(join(ocRoot, ".."), { recursive: true, force: true });
    rmSync(claudeRoot, { recursive: true, force: true });
  }
});

test("sources.opencode.root: null falls back to defaultOpencodeRoot() (not silently null)", () => {
  // The bin passes `flag("opencode-root")` which returns null when the flag is
  // absent. Default-parameter syntax doesn't fire for null (only undefined),
  // so the helper must fall back explicitly via nullish coalescing. Without
  // this fix, an absent --opencode-root would skip opencode entirely and the
  // user would see "0 sessions" with no explanation.
  const ocRoot = makeOpencodeStorage();
  const claudeRoot = emptyClaudeRoot();
  // Pin OPENCODE_DATA so defaultOpencodeRoot() resolves to THIS fixture
  // instead of whatever the developer machine happens to have on disk.
  const prev = process.env.OPENCODE_DATA;
  process.env.OPENCODE_DATA = ocRoot; // expected to look at {OPENCODE_DATA}/storage
  // defaultOpencodeRoot() joins "storage" onto OPENCODE_DATA, so the fixture
  // root must be the parent of the storage dir.
  const ocParent = join(ocRoot, "..");
  process.env.OPENCODE_DATA = ocParent;
  try {
    const parsed = readAllSources({
      claudeRoot,
      // root: null <-- this is what the bin actually passes when --opencode-root is absent
      sources: { opencode: { root: null, disabled: false, json: false }, codex: { disabled: true }, pi: { disabled: true }, cursor: { disabled: true }, kimi: { disabled: true } },
    });
    assert.equal(parsed.sessions.length, 1, `expected root:null to fall back to defaultOpencodeRoot() and find the on-disk storage; got ${parsed.sessions.length} sessions`);
    assert.equal(parsed.sessions[0].source, "opencode");
  } finally {
    rmSync(ocParent, { recursive: true, force: true });
    rmSync(claudeRoot, { recursive: true, force: true });
    if (prev === undefined) delete process.env.OPENCODE_DATA;
    else process.env.OPENCODE_DATA = prev;
  }
});

test("without --no-codex, codex sessions are included in the bundle", () => {
  const cxRoot = makeCodexSessions();
  const claudeRoot = emptyClaudeRoot();
  try {
    const parsed = readAllSources({
      claudeRoot,
      // opencode explicitly disabled so this doesn't pick up whatever real
      // opencode data happens to exist on the machine running the suite.
      sources: { opencode: { disabled: true }, codex: { root: cxRoot, disabled: false }, pi: { disabled: true }, cursor: { disabled: true }, kimi: { disabled: true } },
    });
    assert.equal(parsed.sessions.length, 1, `expected 1 session, got ${parsed.sessions.length}`);
    assert.equal(parsed.sessions[0].sessionId, "cx-one");
    assert.equal(parsed.sessions[0].source, "codex");
  } finally {
    rmSync(join(cxRoot, ".."), { recursive: true, force: true });
    rmSync(claudeRoot, { recursive: true, force: true });
  }
});

test("--no-codex produces a claude-code-only bundle (privacy escape hatch)", () => {
  const cxRoot = makeCodexSessions();
  const claudeRoot = emptyClaudeRoot();
  try {
    const parsed = readAllSources({
      claudeRoot,
      sources: { opencode: { disabled: true }, codex: { root: cxRoot, disabled: true }, pi: { disabled: true }, cursor: { disabled: true }, kimi: { disabled: true } },
    });
    // The codex sessions tree on disk has 1 session; with --no-codex it must
    // NOT appear in the bundle.
    assert.equal(parsed.sessions.length, 0, `expected 0 sessions, got ${parsed.sessions.length}: ${JSON.stringify(parsed.sessions.map(s => s.sessionId))}`);
  } finally {
    rmSync(join(cxRoot, ".."), { recursive: true, force: true });
    rmSync(claudeRoot, { recursive: true, force: true });
  }
});

test("absent codex source key or an empty codex root leaves the claude-code-only bundle unchanged", () => {
  // Pin CODEX_HOME to a fixture dir with no sessions/ subdirectory, so
  // defaultCodexRoot() resolves to a path that doesn't exist on THIS
  // machine's real ~/.codex — otherwise a developer machine with actual
  // codex logs would make this test's "absent" case nondeterministic.
  const claudeRoot = emptyClaudeRoot();
  const emptyCodexRoot = mkdtempSync(join(tmpdir(), "cx-empty-"));
  const prevHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), "cx-home-"));
  try {
    const noCodexKey = readAllSources({ claudeRoot, sources: { opencode: { disabled: true }, pi: { disabled: true }, cursor: { disabled: true }, kimi: { disabled: true } } }); // no sources.codex at all
    const withEmptyRoot = readAllSources({
      claudeRoot,
      sources: { opencode: { disabled: true }, codex: { root: emptyCodexRoot, disabled: false }, pi: { disabled: true }, cursor: { disabled: true }, kimi: { disabled: true } },
    });
    assert.equal(noCodexKey.source, "claude-code");
    assert.equal(noCodexKey.sessions.length, 0);
    assert.deepEqual(withEmptyRoot, noCodexKey, "an empty/absent codex source must leave the claude-code-only bundle unchanged");
  } finally {
    rmSync(claudeRoot, { recursive: true, force: true });
    rmSync(emptyCodexRoot, { recursive: true, force: true });
    rmSync(process.env.CODEX_HOME, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevHome;
  }
});

test("without --no-pi, pi sessions are included in the bundle", () => {
  const piRoot = makePiSessions();
  const claudeRoot = emptyClaudeRoot();
  try {
    const parsed = readAllSources({
      claudeRoot,
      // opencode and codex explicitly disabled so this doesn't pick up
      // whatever real opencode/codex data happens to exist on the machine.
      sources: { opencode: { disabled: true }, codex: { disabled: true }, pi: { root: piRoot, disabled: false }, cursor: { disabled: true }, kimi: { disabled: true } },
    });
    assert.equal(parsed.sessions.length, 1, `expected 1 session, got ${parsed.sessions.length}`);
    assert.equal(parsed.sessions[0].sessionId, "pi-one");
    assert.equal(parsed.sessions[0].source, "pi");
  } finally {
    rmSync(join(piRoot, ".."), { recursive: true, force: true });
    rmSync(claudeRoot, { recursive: true, force: true });
  }
});

test("--no-pi produces a claude-code-only bundle (privacy escape hatch)", () => {
  const piRoot = makePiSessions();
  const claudeRoot = emptyClaudeRoot();
  try {
    const parsed = readAllSources({
      claudeRoot,
      sources: { opencode: { disabled: true }, codex: { disabled: true }, pi: { root: piRoot, disabled: true }, cursor: { disabled: true }, kimi: { disabled: true } },
    });
    // The pi sessions tree on disk has 1 session; with --no-pi it must NOT
    // appear in the bundle.
    assert.equal(parsed.sessions.length, 0, `expected 0 sessions, got ${parsed.sessions.length}: ${JSON.stringify(parsed.sessions.map(s => s.sessionId))}`);
  } finally {
    rmSync(join(piRoot, ".."), { recursive: true, force: true });
    rmSync(claudeRoot, { recursive: true, force: true });
  }
});

test("absent pi source key or an empty pi root leaves the claude-code-only bundle unchanged", () => {
  // pi documents no env-var override for its sessions root (unlike codex's
  // CODEX_HOME or opencode's XDG chain) — defaultPiRoot() is hardcoded to
  // homedir()/.pi/agent/sessions. To exercise the "absent key" branch (which
  // falls through to defaultPiRoot()) without touching THIS machine's real
  // ~/.pi (64 real sessions live there), HOME and USERPROFILE are both pinned
  // to an empty fixture dir for the duration of this test — os.homedir()
  // honors $HOME on POSIX but reads %USERPROFILE% on Windows, so both must
  // be pinned to stay hermetic on every CI leg and on contributors' machines.
  const claudeRoot = emptyClaudeRoot();
  const emptyPiRoot = mkdtempSync(join(tmpdir(), "pi-empty-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-home-"));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  try {
    const noPiKey = readAllSources({ claudeRoot, sources: { opencode: { disabled: true }, codex: { disabled: true }, cursor: { disabled: true }, kimi: { disabled: true } } }); // no sources.pi at all
    const withEmptyRoot = readAllSources({
      claudeRoot,
      sources: { opencode: { disabled: true }, codex: { disabled: true }, pi: { root: emptyPiRoot, disabled: false }, cursor: { disabled: true }, kimi: { disabled: true } },
    });
    assert.equal(noPiKey.source, "claude-code");
    assert.equal(noPiKey.sessions.length, 0);
    assert.deepEqual(withEmptyRoot, noPiKey, "an empty/absent pi source must leave the claude-code-only bundle unchanged");
  } finally {
    rmSync(claudeRoot, { recursive: true, force: true });
    rmSync(emptyPiRoot, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
  }
});

// ── cursor: same merge/opt-out/absent-root contract as opencode/codex/pi
// above, but the fixture needs node:sqlite to build a store.db, so this whole
// block skips cleanly on Node < 22.5 (no JSON fallback exists for cursor —
// see src/adapters/cursor.mjs's header comment).

test("without --no-cursor, cursor sessions are included in the bundle", { skip: sqlite ? false : "node:sqlite unavailable" }, () => {
  const cuRoot = makeCursorSessions();
  const claudeRoot = emptyClaudeRoot();
  try {
    const parsed = readAllSources({
      claudeRoot,
      // opencode/codex/pi explicitly disabled so this doesn't pick up
      // whatever real opencode/codex/pi data happens to exist on the machine.
      sources: { opencode: { disabled: true }, codex: { disabled: true }, pi: { disabled: true }, cursor: { root: cuRoot, disabled: false }, kimi: { disabled: true } },
    });
    assert.equal(parsed.sessions.length, 1, `expected 1 session, got ${parsed.sessions.length}`);
    assert.equal(parsed.sessions[0].sessionId, "cu-one");
    assert.equal(parsed.sessions[0].source, "cursor");
  } finally {
    rmSync(cuRoot, { recursive: true, force: true });
    rmSync(claudeRoot, { recursive: true, force: true });
  }
});

test("--no-cursor produces a claude-code-only bundle (privacy escape hatch)", { skip: sqlite ? false : "node:sqlite unavailable" }, () => {
  const cuRoot = makeCursorSessions();
  const claudeRoot = emptyClaudeRoot();
  try {
    const parsed = readAllSources({
      claudeRoot,
      sources: { opencode: { disabled: true }, codex: { disabled: true }, pi: { disabled: true }, cursor: { root: cuRoot, disabled: true }, kimi: { disabled: true } },
    });
    // The cursor chats tree on disk has 1 session; with --no-cursor it must
    // NOT appear in the bundle.
    assert.equal(parsed.sessions.length, 0, `expected 0 sessions, got ${parsed.sessions.length}: ${JSON.stringify(parsed.sessions.map(s => s.sessionId))}`);
  } finally {
    rmSync(cuRoot, { recursive: true, force: true });
    rmSync(claudeRoot, { recursive: true, force: true });
  }
});

test("absent cursor source key or an empty cursor root leaves the claude-code-only bundle unchanged", { skip: sqlite ? false : "node:sqlite unavailable" }, () => {
  // cursor-agent documents no env-var override for the chats root (unlike
  // codex's CODEX_HOME) — defaultCursorRoot() is hardcoded to
  // homedir()/.cursor/chats. To exercise the "absent key" branch (which falls
  // through to defaultCursorRoot()) without touching THIS machine's real
  // ~/.cursor/chats, HOME and USERPROFILE are both pinned to an empty fixture
  // dir for the duration of this test, same as the pi case above.
  const claudeRoot = emptyClaudeRoot();
  const emptyCursorRoot = mkdtempSync(join(tmpdir(), "cu-empty-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "cu-home-"));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  try {
    const noCursorKey = readAllSources({ claudeRoot, sources: { opencode: { disabled: true }, codex: { disabled: true }, pi: { disabled: true }, kimi: { disabled: true } } }); // no sources.cursor at all
    const withEmptyRoot = readAllSources({
      claudeRoot,
      sources: { opencode: { disabled: true }, codex: { disabled: true }, pi: { disabled: true }, cursor: { root: emptyCursorRoot, disabled: false }, kimi: { disabled: true } },
    });
    assert.equal(noCursorKey.source, "claude-code");
    assert.equal(noCursorKey.sessions.length, 0);
    assert.deepEqual(withEmptyRoot, noCursorKey, "an empty/absent cursor source must leave the claude-code-only bundle unchanged");
  } finally {
    rmSync(claudeRoot, { recursive: true, force: true });
    rmSync(emptyCursorRoot, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
  }
});

// ── kimi: same merge/opt-out/absent-root contract as opencode/codex/pi/cursor
// above. No sqlite dependency (unlike cursor), so this block runs unskipped
// on every Node version.

test("without --no-kimi, kimi sessions are included in the bundle", () => {
  const kiRoot = makeKimiSessions();
  const claudeRoot = emptyClaudeRoot();
  try {
    const parsed = readAllSources({
      claudeRoot,
      // opencode/codex/pi/cursor explicitly disabled so this doesn't pick up
      // whatever real opencode/codex/pi/cursor data happens to exist on the
      // machine.
      sources: { opencode: { disabled: true }, codex: { disabled: true }, pi: { disabled: true }, cursor: { disabled: true }, kimi: { root: kiRoot, disabled: false } },
    });
    assert.equal(parsed.sessions.length, 1, `expected 1 session, got ${parsed.sessions.length}`);
    assert.equal(parsed.sessions[0].sessionId, "ki-one");
    assert.equal(parsed.sessions[0].source, "kimi");
  } finally {
    rmSync(join(kiRoot, ".."), { recursive: true, force: true });
    rmSync(claudeRoot, { recursive: true, force: true });
  }
});

test("--no-kimi produces a claude-code-only bundle (privacy escape hatch)", () => {
  const kiRoot = makeKimiSessions();
  const claudeRoot = emptyClaudeRoot();
  try {
    const parsed = readAllSources({
      claudeRoot,
      sources: { opencode: { disabled: true }, codex: { disabled: true }, pi: { disabled: true }, cursor: { disabled: true }, kimi: { root: kiRoot, disabled: true } },
    });
    // The kimi sessions tree on disk has 1 session; with --no-kimi it must
    // NOT appear in the bundle.
    assert.equal(parsed.sessions.length, 0, `expected 0 sessions, got ${parsed.sessions.length}: ${JSON.stringify(parsed.sessions.map(s => s.sessionId))}`);
  } finally {
    rmSync(join(kiRoot, ".."), { recursive: true, force: true });
    rmSync(claudeRoot, { recursive: true, force: true });
  }
});

test("absent kimi source key or an empty kimi root leaves the claude-code-only bundle unchanged", () => {
  // kimi-code documents no env-var override for the sessions root (same as
  // pi/cursor) — defaultKimiRoot() is hardcoded to homedir()/.kimi-code/
  // sessions. To exercise the "absent key" branch (which falls through to
  // defaultKimiRoot()) without touching THIS machine's real ~/.kimi-code
  // (real sessions live there), HOME and USERPROFILE are both pinned to an
  // empty fixture dir for the duration of this test, same as the pi/cursor
  // cases above.
  const claudeRoot = emptyClaudeRoot();
  const emptyKimiRoot = mkdtempSync(join(tmpdir(), "ki-empty-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "ki-home-"));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  try {
    const noKimiKey = readAllSources({ claudeRoot, sources: { opencode: { disabled: true }, codex: { disabled: true }, pi: { disabled: true }, cursor: { disabled: true } } }); // no sources.kimi at all
    const withEmptyRoot = readAllSources({
      claudeRoot,
      sources: { opencode: { disabled: true }, codex: { disabled: true }, pi: { disabled: true }, cursor: { disabled: true }, kimi: { root: emptyKimiRoot, disabled: false } },
    });
    assert.equal(noKimiKey.source, "claude-code");
    assert.equal(noKimiKey.sessions.length, 0);
    assert.deepEqual(withEmptyRoot, noKimiKey, "an empty/absent kimi source must leave the claude-code-only bundle unchanged");
  } finally {
    rmSync(claudeRoot, { recursive: true, force: true });
    rmSync(emptyKimiRoot, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
  }
});

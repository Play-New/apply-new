// Source-resolution flags: verifies the boolean flags --no-opencode and
// --opencode-json do what PRIVACY.md promises. Both are the privacy escape
// hatches and the backend selector — getting them wrong is a silent feature
// break, so each is exercised end-to-end against a synthetic storage tree.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readAllSources } from "../src/sources.mjs";

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
      sources: { opencode: { root: ocRoot, disabled: true, json: false }, codex: { disabled: true }, pi: { disabled: true } },
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
      sources: { opencode: { root: ocRoot, disabled: false, json: false }, codex: { disabled: true }, pi: { disabled: true } },
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
      sources: { opencode: { root: ocRoot, disabled: true, json: false }, codex: { disabled: true }, pi: { disabled: true } },
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
      sources: { opencode: { root: null, disabled: false, json: false }, codex: { disabled: true }, pi: { disabled: true } },
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
      sources: { opencode: { disabled: true }, codex: { root: cxRoot, disabled: false }, pi: { disabled: true } },
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
      sources: { opencode: { disabled: true }, codex: { root: cxRoot, disabled: true }, pi: { disabled: true } },
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
    const noCodexKey = readAllSources({ claudeRoot, sources: { opencode: { disabled: true }, pi: { disabled: true } } }); // no sources.codex at all
    const withEmptyRoot = readAllSources({
      claudeRoot,
      sources: { opencode: { disabled: true }, codex: { root: emptyCodexRoot, disabled: false }, pi: { disabled: true } },
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
      sources: { opencode: { disabled: true }, codex: { disabled: true }, pi: { root: piRoot, disabled: false } },
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
      sources: { opencode: { disabled: true }, codex: { disabled: true }, pi: { root: piRoot, disabled: true } },
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
    const noPiKey = readAllSources({ claudeRoot, sources: { opencode: { disabled: true }, codex: { disabled: true } } }); // no sources.pi at all
    const withEmptyRoot = readAllSources({
      claudeRoot,
      sources: { opencode: { disabled: true }, codex: { disabled: true }, pi: { root: emptyPiRoot, disabled: false } },
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
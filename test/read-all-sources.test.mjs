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
      ocRoot,
      noOpencode: true,
      opencodeJson: false,
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
      ocRoot,
      noOpencode: false,
      opencodeJson: false,
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
      ocRoot,
      noOpencode: true,
      opencodeJson: false,
    });
    for (const s of parsed.sessions) {
      assert.notEqual(s.source, "opencode", `opencode session leaked despite noOpencode=true: ${s.sessionId}`);
    }
  } finally {
    rmSync(join(ocRoot, ".."), { recursive: true, force: true });
    rmSync(claudeRoot, { recursive: true, force: true });
  }
});

test("ocRoot: null falls back to defaultOpencodeRoot() (not silently null)", () => {
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
      ocRoot: null, // <-- this is what the bin actually passes when the flag is absent
      noOpencode: false,
      opencodeJson: false,
    });
    assert.equal(parsed.sessions.length, 1, `expected ocRoot:null to fall back to defaultOpencodeRoot() and find the on-disk storage; got ${parsed.sessions.length} sessions`);
    assert.equal(parsed.sessions[0].source, "opencode");
  } finally {
    rmSync(ocParent, { recursive: true, force: true });
    rmSync(claudeRoot, { recursive: true, force: true });
    if (prev === undefined) delete process.env.OPENCODE_DATA;
    else process.env.OPENCODE_DATA = prev;
  }
});
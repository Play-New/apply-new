import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { redactText, countRedactions } from "../src/redact.mjs";

test("removes emails", () => {
  assert.equal(redactText("ping me at jane.doe@acme.io please"), "ping me at ⟨email⟩ please");
});

test("strips home-dir username but keeps path shape", () => {
  assert.equal(redactText("/Users/giulia/Github/secret-client"), "/Users/⟨user⟩/Github/secret-client");
  assert.equal(redactText("/home/giulia/work"), "/home/⟨user⟩/work");
  assert.equal(redactText("C:\\Users\\Giulia\\proj"), "C:\\Users\\⟨user⟩\\proj");
});

test("redacts known secret shapes", () => {
  assert.match(redactText("sk-ant-api03-AAAABBBBCCCCDDDDEEEE1234"), /⟨anthropic-key⟩/);
  assert.match(redactText("token ghp_abcdefghijklmnopqrstuvwxyz0123"), /⟨gh-token⟩/);
  assert.match(redactText("AKIAIOSFODNN7EXAMPLE"), /⟨aws-key⟩/);
});

test("keeps env var name, drops the value", () => {
  assert.equal(redactText('OPENAI_API_KEY="abc123def456"'), 'OPENAI_API_KEY=⟨secret⟩"');
});

test("redacts IPv4 but not semver", () => {
  assert.equal(redactText("connect to 192.168.0.1"), "connect to ⟨ip⟩");
  assert.equal(redactText("claude-code version 2.1.138"), "claude-code version 2.1.138");
});

test("leaves ordinary prose untouched", () => {
  const s = "I refactored the parser and added a test for the edge case.";
  assert.equal(redactText(s), s);
  assert.equal(countRedactions(s), 0);
});

// --- dash-encoded home paths (Claude Code encodes project/scratchpad dirs this way) ---

test("strips the username out of dash-encoded home paths, keeps the shape", () => {
  const out = redactText(
    "saved at /private/tmp/claude-501/-Users-leakuser-Projects-Work-x/scratch",
  );
  assert.match(out, /-Users-⟨user⟩-/);
  assert.doesNotMatch(out, /leakuser/i);
});

test("strips the username out of a bare dash-encoded home token", () => {
  const out = redactText("-home-leakuser-vaults-x");
  assert.match(out, /-home-⟨user⟩-/);
  assert.doesNotMatch(out, /leakuser/i);
});

test("countRedactions counts the dash-encoded home path hit", () => {
  assert.equal(countRedactions("-Users-leakuser-Projects-Work-x"), 1);
});

// --- the local account name, wherever it shows up in prose (no structural shape) ---
//
// This machine's real username is derived at runtime via os.userInfo() — it is
// NEVER written as a literal in this file. Short names (<4 chars) are exempted
// from the literal-redaction rule (see src/redact.mjs), so this test asserts
// the behavior that actually applies to whatever account runs it.

test("redacts a bare mention of the local account name in prose (or documents the short-name guard)", () => {
  const u = os.userInfo().username;
  if (u.length >= 4) {
    const lower = redactText(`logged in as ${u}`);
    const upper = redactText(`logged in as ${u.toUpperCase()}`);
    assert.ok(!lower.toLowerCase().includes(u.toLowerCase()), "lowercase mention survived redaction");
    assert.ok(!upper.toLowerCase().includes(u.toLowerCase()), "uppercase mention survived redaction");
    assert.match(lower, /⟨user⟩/);
    assert.match(upper, /⟨user⟩/);
  } else {
    // Short-name guard: names under 4 chars are never turned into a literal
    // rule (too likely to clobber ordinary words), so the string passes
    // through unchanged.
    const s = `logged in as ${u}`;
    assert.equal(redactText(s), s);
  }
});

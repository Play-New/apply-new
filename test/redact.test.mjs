import { test } from "node:test";
import assert from "node:assert/strict";
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

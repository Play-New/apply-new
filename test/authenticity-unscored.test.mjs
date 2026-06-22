// The authenticity screen must not emit a positive score when there is no
// full-capture source to screen. computeForensics filters to FULL_CAPTURE_SOURCES
// up front (claude-code); if that slice is empty (an opencode-only bundle, or a
// sparse ~/.claude alongside opencode) every session-based check passes
// vacuously on the empty set. Returning 100 there would assert a clean tamper
// screen over ZERO verified sessions — a forgery-shaped structural session would
// "pass". The screen must be UNSCORED (null) instead, like the groundedness gate.

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeForensics } from "../src/forensics.mjs";
import { assembleProfile, renderMarkdown } from "../src/profile.mjs";

const claudeSession = () => ({
  source: "claude-code",
  chain: [
    { uuid: "u1", parentUuid: null, ts: "2026-05-01T10:00:00.000Z" },
    { uuid: "u2", parentUuid: "u1", ts: "2026-05-01T10:00:01.000Z" },
  ],
  messages: [
    { role: "assistant", model: "claude", messageId: "msg_1", requestId: "req_1",
      usage: { cacheRead: 0, cacheCreate: 10 }, toolUses: [{ id: "t1" }],
      toolResults: [{ forId: "t1" }] },
  ],
});

// A deliberately forgery-shaped opencode session: impossible token accounting
// (cache read with zero cache write) and an unmatched tool_use. If these were
// screened they would FLAG; because opencode is structural, they must not be.
const forgedOpencodeSession = () => ({
  source: "opencode",
  chain: [{ uuid: "m1", parentUuid: null, ts: "2026-05-01T10:00:00.000Z" }],
  messages: [
    { role: "assistant", model: "qwen", messageId: "m1", requestId: null,
      usage: { cacheRead: 999, cacheCreate: 0 }, toolUses: [{ id: "x1" }],
      toolResults: [] },
  ],
});

test("no full-capture source => authenticity score is null, not a vacuous 100", () => {
  const f = computeForensics({ files: [], sessions: [forgedOpencodeSession()] });
  assert.equal(f.score, null, `expected null (unscored), got ${f.score} — forgery-shaped structural session scored a pass`);
});

test("a full-capture session still scores normally (null path does not over-fire)", () => {
  const f = computeForensics({ files: [], sessions: [claudeSession()] });
  assert.equal(typeof f.score, "number", `expected a numeric score, got ${f.score}`);
  assert.ok(f.score >= 0 && f.score <= 100);
});

test("a claude+opencode mix still scores (>=1 full-capture session present)", () => {
  const f = computeForensics({ files: [], sessions: [claudeSession(), forgedOpencodeSession()] });
  assert.equal(typeof f.score, "number");
});

test("profile renders 'n/a' (not 'null/100') and discloses the reason when unscored", () => {
  const forensics = computeForensics({ files: [], sessions: [forgedOpencodeSession()] });
  const profile = assembleProfile({
    contact: { name: "X" },
    projects: [],
    narrative: null,
    fingerprint: { manifest: { bundleHash: "abc" } },
    forensics,
    manifestHash: "abc",
    sources: [{ source: "opencode", captureLevel: "structural", sessions: 1, backend: "json" }],
  });
  assert.equal(profile.authenticity.score, null);
  assert.match(profile.authenticity.note, /no full-capture source/i);
  const md = renderMarkdown(profile);
  assert.match(md, /Log consistency screen: n\/a/);
  assert.ok(!md.includes("null/100"), "must not render null/100");
});

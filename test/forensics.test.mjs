import { test } from "node:test";
import assert from "node:assert/strict";
import { computeForensics } from "../src/forensics.mjs";

const statusOf = (report, id) => report.checks.find((c) => c.id === id)?.status;

// A GENUINE session that trips every naive check:
//  - sidechain interleaving: file order (u1, u3, u2) is NOT timestamp order,
//    but every parent→child edge is causally sound;
//  - a resume: the first assistant reads cache it didn't create in-session,
//    while a later message does create cache (so the dataset is consistent);
//  - a <synthetic> harness message whose id is a bare UUID, not msg_….
const GENUINE = {
  source: "claude-code",
  files: [{ relPath: "a.jsonl", sha256: "aa", bytes: 10, lines: 5, malformed: 0 }],
  sessions: [
    {
      chain: [
        { uuid: "u1", parentUuid: null, ts: "2026-01-10T10:00:00.000Z" },
        { uuid: "u3", parentUuid: "u1", ts: "2026-01-10T10:00:05.000Z" },
        { uuid: "u2", parentUuid: "u1", ts: "2026-01-10T10:00:02.000Z" },
      ],
      messages: [
        { role: "user", ts: "2026-01-10T10:00:00.000Z", model: null, messageId: null, requestId: null, toolUses: [], toolResults: [], usage: null },
        { role: "assistant", ts: "2026-01-10T10:00:02.000Z", model: "claude-opus-4-7", messageId: "msg_a", requestId: "req_a", toolUses: [{ id: "t1", name: "Read" }], toolResults: [], usage: { input: 5, output: 50, cacheRead: 1000, cacheCreate: 0 } },
        { role: "user", ts: "2026-01-10T10:00:03.000Z", model: null, messageId: null, requestId: null, toolUses: [], toolResults: [{ forId: "t1", isError: false, bytes: 100 }], usage: null },
        { role: "assistant", ts: "2026-01-10T10:00:05.000Z", model: "claude-opus-4-7", messageId: "msg_b", requestId: "req_b", toolUses: [], toolResults: [], usage: { input: 5, output: 80, cacheRead: 2000, cacheCreate: 500 } },
        { role: "assistant", ts: "2026-01-10T10:00:06.000Z", model: "<synthetic>", messageId: "5b2e-bare-uuid", requestId: "req_c", toolUses: [], toolResults: [], usage: null },
      ],
    },
  ],
};

test("genuine interleaved/resumed/synthetic session is not flagged", () => {
  const r = computeForensics(GENUINE);
  for (const id of ["malformed_lines", "uuid_chain", "ts_causal", "ts_future", "id_format", "token_accounting", "tool_pairing"]) {
    assert.equal(statusOf(r, id), "pass", `${id} should pass on genuine logs`);
  }
  assert.equal(r.score, 100);
});

// A TAMPERED session that should trip the checks it actually violates.
const TAMPERED = {
  source: "claude-code",
  files: [{ relPath: "b.jsonl", sha256: "bb", bytes: 10, lines: 9, malformed: 2 }],
  sessions: [
    {
      chain: [
        { uuid: "b1", parentUuid: null, ts: "2026-01-10T10:00:00.000Z" },
        { uuid: "b2", parentUuid: "ghost", ts: "2026-01-10T10:00:01.000Z" }, // orphan
        { uuid: "b3", parentUuid: "b1", ts: "2026-01-10T09:00:00.000Z" }, // predates parent
        { uuid: "b4", parentUuid: "b1", ts: "2099-01-01T00:00:00.000Z" }, // future
      ],
      messages: [
        { role: "assistant", ts: "2026-01-10T10:00:00.000Z", model: "claude-opus-4-7", messageId: "oops", requestId: "req_a", toolUses: [{ id: "x1", name: "Edit" }], toolResults: [], usage: { input: 5, output: 10, cacheRead: 9000, cacheCreate: 0 } },
      ],
    },
  ],
};

test("tampered session trips the relevant checks", () => {
  const r = computeForensics(TAMPERED);
  assert.equal(statusOf(r, "malformed_lines"), "flag");
  assert.equal(statusOf(r, "uuid_chain"), "flag");
  assert.equal(statusOf(r, "ts_causal"), "flag");
  assert.equal(statusOf(r, "ts_future"), "flag");
  assert.equal(statusOf(r, "id_format"), "flag");
  assert.equal(statusOf(r, "token_accounting"), "flag");
  assert.equal(statusOf(r, "tool_pairing"), "flag");
  assert.equal(r.score, 0);
});

// At scale, months of genuine sessions accumulate a few sub-2s clock corrections
// past tolerance. A handful of causal violations among many edges must NOT flag
// (it did at first: 2/153542 dropped a real run to 75/100).
test("a few causal violations among many edges do not flag", () => {
  const chain = [{ uuid: "r", parentUuid: null, ts: "2026-01-01T00:00:00.000Z" }];
  for (let i = 1; i <= 400; i++) {
    chain.push({ uuid: "n" + i, parentUuid: "r", ts: `2026-01-01T00:${String(i % 60).padStart(2, "0")}:10.000Z` });
  }
  chain.push({ uuid: "skew", parentUuid: "r", ts: "2025-12-31T23:00:00.000Z" }); // 1 clock-skew violation
  const parsed = {
    source: "claude-code",
    files: [{ relPath: "x.jsonl", sha256: "x", bytes: 1, lines: 1, malformed: 0 }],
    sessions: [{ chain, messages: [] }],
  };
  const r = computeForensics(parsed);
  assert.equal(statusOf(r, "ts_causal"), "pass", "1 violation in 401 edges must pass");
});

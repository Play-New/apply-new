import { test } from "node:test";
import assert from "node:assert/strict";
import { computeIntensity } from "../src/intensity.mjs";
import { computeFingerprint } from "../src/fingerprint.mjs";

function sess(sid, firstTs, lastTs, toolCallsPerMessage = []) {
  return {
    sessionId: sid,
    firstTs,
    lastTs,
    messages: toolCallsPerMessage.map((n) => ({
      role: "assistant",
      ts: firstTs,
      toolUses: Array.from({ length: n }, (_, i) => ({ id: `t${i}`, name: "Read" })),
    })),
  };
}

test("returns null on empty input", () => {
  assert.equal(computeIntensity({ sessions: [] }), null);
});

test("daily driver: high active-days ratio + streaks", () => {
  // 30 sessions across 28 days with one streak of 10
  const sessions = [];
  for (let day = 0; day < 28; day++) {
    const ts = `2026-01-${String(day + 1).padStart(2, "0")}T10:00:00Z`;
    sessions.push(sess(`s${day}`, ts, ts, [40, 40]));
  }
  const i = computeIntensity({ sessions });
  assert.ok(i.activeDaysRatio >= 0.9, `ratio ${i.activeDaysRatio}`);
  assert.equal(i.cadence, "daily driver");
  assert.ok(i.longestStreak >= 10);
});

test("occasional: low active-days ratio + short sessions", () => {
  const sessions = [
    sess("a", "2026-01-01T10:00:00Z", "2026-01-01T10:05:00Z", [3]),
    sess("b", "2026-01-20T10:00:00Z", "2026-01-20T10:05:00Z", [2]),
    sess("c", "2026-02-15T10:00:00Z", "2026-02-15T10:05:00Z", [4]),
  ];
  const i = computeIntensity({ sessions });
  assert.ok(i.activeDaysRatio < 0.1, `ratio ${i.activeDaysRatio}`);
  assert.equal(i.cadence, "occasional");
  assert.equal(i.sessionShape, "short bursts");
});

test("peak day captures the busiest single day", () => {
  const sessions = [
    sess("a", "2026-01-01T10:00:00Z", "2026-01-01T11:00:00Z", [10]),
    sess("b", "2026-01-02T10:00:00Z", "2026-01-02T11:00:00Z", [100, 100]),
    sess("c", "2026-01-03T10:00:00Z", "2026-01-03T11:00:00Z", [10]),
  ];
  const i = computeIntensity({ sessions });
  assert.equal(i.peakDayToolCalls, 200);
});

test("longest streak counts consecutive active days correctly", () => {
  const days = ["01-01", "01-02", "01-03", "01-04", "01-05", "01-10", "01-11", "01-12"];
  const sessions = days.map((d) => sess(d, `2026-${d}T10:00:00Z`, `2026-${d}T10:00:00Z`, [10]));
  const i = computeIntensity({ sessions });
  assert.equal(i.longestStreak, 5);
});

// --- shared active-day definition (converges with the fingerprint) ----------

// A session usable by BOTH lenses: real per-message timestamps, the fields the
// fingerprint reads, and a `files` array so the manifest step doesn't throw.
function pmsg(ts) {
  return { role: "user", ts, textRedacted: "hello there friend", thinkingChars: 0, signatureChars: 0, toolUses: [], usage: null };
}
function psess(sid, isoList) {
  const sorted = [...isoList].sort();
  return {
    sessionId: sid, projectLabel: "proj", models: [], cliVersions: [],
    firstTs: sorted[0], lastTs: sorted.at(-1), messages: isoList.map(pmsg),
  };
}

test("activeDays matches the fingerprint definition for the same logs and tz", () => {
  const parsed = {
    source: "test", files: [],
    sessions: [
      psess("a", ["2026-01-01T10:00:00Z", "2026-01-02T09:00:00Z"]),
      psess("b", ["2026-01-05T12:00:00Z"]),
    ],
  };
  const i = computeIntensity(parsed);
  const fp = computeFingerprint(parsed);
  assert.equal(i.activeDays, fp.totals.activeDays); // converged
  assert.equal(i.activeDays, 3); // Jan 1, 2, 5
});

test("a continued session marks the days it had message activity, with no interpolation", () => {
  // Opened Jan 1, continued Jan 3. Jan 2 had no message and must stay idle.
  const parsed = { source: "test", files: [], sessions: [psess("x", ["2026-01-01T10:00:00Z", "2026-01-03T09:00:00Z"])] };
  assert.equal(computeIntensity(parsed).activeDays, 2); // Jan 1 + Jan 3, not Jan 2
});

test("records the timezone used, and buckets in an explicit zone (not host-local)", () => {
  const parsed = { source: "test", files: [], sessions: [psess("a", ["2026-01-01T23:30:00Z"])] };
  assert.equal(computeIntensity(parsed).timezone, "UTC");
  const rome = computeIntensity(parsed, { tz: "Europe/Rome" });
  assert.equal(rome.timezone, "Europe/Rome");
  assert.equal(rome.activeDays, 1);
});

test("a timestamped session with NO messages contributes zero active days (converges)", () => {
  // firstTs is set (a system / file-history record carries a timestamp) but the
  // message list is empty. The fingerprint reads message timestamps only, so
  // intensity must count zero active days here too — no session-open fallback.
  const parsed = {
    source: "test", files: [],
    sessions: [{
      sessionId: "empty", projectLabel: "p", models: [], cliVersions: [],
      firstTs: "2026-01-01T10:00:00Z", lastTs: "2026-01-01T10:00:00Z", messages: [],
    }],
  };
  const i = computeIntensity(parsed);
  const fp = computeFingerprint(parsed);
  assert.equal(i.activeDays, fp.totals.activeDays); // both 0 — no divergence
  assert.equal(i.activeDays, 0);
  assert.equal(i.medianSessionsPerActiveDay, 0); // no phantom 1-session day
});

test("activeDays never exceeds observedDays (midnight-straddling session)", () => {
  // ~60-minute session crossing midnight UTC: two active day-keys inside a
  // sub-day ms window. observedDays is day-bucketed too, so the ratio is <= 100%.
  const parsed = { source: "test", files: [], sessions: [psess("x", ["2026-01-01T23:30:00Z", "2026-01-02T00:30:00Z"])] };
  const i = computeIntensity(parsed);
  assert.equal(i.activeDays, 2);
  assert.ok(i.observedDays >= i.activeDays, `observedDays ${i.observedDays} < activeDays ${i.activeDays}`);
  assert.ok(i.activeDaysRatio <= 1, `ratio ${i.activeDaysRatio} > 1`);
});

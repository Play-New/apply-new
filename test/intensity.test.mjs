import { test } from "node:test";
import assert from "node:assert/strict";
import { computeIntensity } from "../src/intensity.mjs";

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

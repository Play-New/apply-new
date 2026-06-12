// Practice intensity: how deeply Claude is embedded in the candidate's daily
// workflow. Pure counts from session timestamps and message volumes — no PII.
//
// Five signals, all deterministic:
//   - activeDays / observedDays / activeDaysRatio
//   - medianSessionsPerActiveDay
//   - medianSessionToolCalls (proxy for session depth)
//   - longestStreak (consecutive active days)
//   - peakDayToolCalls
//
// A daily-driver candidate ends up around: ≥60% active days, ≥1 session/day
// median, ≥30 tool calls median session, ≥10 day streak. An occasional user
// looks the opposite on all five.
//
// activeDays uses the SHARED definition in src/days.mjs (message-activity days,
// no interpolation) so it can never diverge from the fingerprint. The timezone
// the days are bucketed in is recorded on the result so the count reproduces.

import { activeDayKeys, dayKeyFor, DEFAULT_TZ } from "./days.mjs";

const DAY_MS = 86_400_000;
const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export function computeIntensity(parsed, { tz = DEFAULT_TZ } = {}) {
  const sessions = parsed?.sessions ?? [];
  if (sessions.length === 0) return null;

  const dayKey = dayKeyFor(tz);

  // Per-session aggregates
  const perSession = [];
  const perDaySessions = new Map(); // active day → # sessions active that day
  const perDayToolCalls = new Map(); // session-open day → tool calls
  const allMsgTs = []; // every message timestamp — the active-day source, shared with the fingerprint
  let firstTs = Infinity;
  let lastTs = -Infinity;

  for (const s of sessions) {
    const start = s.firstTs ? Date.parse(s.firstTs) : null;
    const end = s.lastTs ? Date.parse(s.lastTs) : start;
    if (!Number.isFinite(start)) continue;
    let toolCalls = 0;
    // A session is "active" on every day it actually had a message — this
    // recovers days spent only continuing an existing session, while leaving
    // genuinely idle days idle (no interpolation across a resume gap).
    const dayHits = new Set();
    for (const m of s.messages ?? []) {
      toolCalls += (m.toolUses?.length ?? 0);
      const mt = m.ts ? Date.parse(m.ts) : NaN;
      if (Number.isFinite(mt)) { allMsgTs.push(mt); dayHits.add(dayKey(mt)); }
    }
    perSession.push({ start, end, toolCalls });
    // NO session-open fallback. firstTs can come from a non-message record
    // (system row, file-history snapshot), but the fingerprint counts message
    // timestamps only — so a timestamped, message-empty session must contribute
    // zero active days here too, or the two diverge.
    for (const d of dayHits) perDaySessions.set(d, (perDaySessions.get(d) ?? 0) + 1);
    // Tool-call volume is attributed to the day the session opened (peak-day proxy).
    const openDay = dayKey(start);
    perDayToolCalls.set(openDay, (perDayToolCalls.get(openDay) ?? 0) + toolCalls);
    if (start < firstTs) firstTs = start;
    if (end > lastTs) lastTs = end;
  }
  if (!perSession.length) return null;

  // activeDays via the SHARED definition: the exact call the fingerprint makes,
  // over message timestamps. The two cannot diverge.
  const activeDayKeySet = activeDayKeys(allMsgTs, tz);
  const activeDaysCount = activeDayKeySet.size;

  // observedDays from inclusive day KEYS in the same recorded zone — not a raw-ms
  // window, which can round below the day-bucket count (a 90-min session across
  // midnight is 2 active days in 1 rounded ms-day -> 200%). This makes
  // activeDays <= observedDays hold by construction in every zone.
  const dayCount = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / DAY_MS) + 1;
  const observedDays = Math.max(1, dayCount(dayKey(firstTs), dayKey(lastTs)));
  const activeDaysRatio = +(activeDaysCount / observedDays).toFixed(2);

  // Median sessions per active day (NOT per observed day — we want the cadence
  // on the days they actually showed up).
  const sessionsPerActiveDay = [...perDaySessions.values()];
  const medianSessionsPerActiveDay = median(sessionsPerActiveDay);

  // Median session tool calls (proxy for session depth).
  const toolCallsPerSession = perSession.map((s) => s.toolCalls);
  const medianSessionToolCalls = median(toolCallsPerSession);

  // Longest consecutive-active-days streak.
  const dayStamps = [...activeDayKeySet].sort();
  let longestStreak = 0;
  let currentStreak = 0;
  let prev = null;
  for (const d of dayStamps) {
    const t = Date.parse(d + "T00:00:00Z");
    if (prev != null && (t - prev) === DAY_MS) currentStreak++;
    else currentStreak = 1;
    if (currentStreak > longestStreak) longestStreak = currentStreak;
    prev = t;
  }

  // Peak day by tool calls.
  let peakDayToolCalls = 0;
  for (const v of perDayToolCalls.values()) if (v > peakDayToolCalls) peakDayToolCalls = v;

  // Cadence band — purely for the LLM narrative, not a grade.
  let cadence = "occasional";
  if (activeDaysRatio >= 0.6) cadence = "daily driver";
  else if (activeDaysRatio >= 0.3) cadence = "heavy regular";
  else if (activeDaysRatio >= 0.1) cadence = "weekly";

  let sessionShape = "short bursts";
  if (medianSessionToolCalls >= 200) sessionShape = "marathon sessions";
  else if (medianSessionToolCalls >= 50) sessionShape = "deep sessions";
  else if (medianSessionToolCalls >= 20) sessionShape = "focused sessions";

  return {
    observedDays,
    activeDays: activeDaysCount,
    activeDaysRatio,
    medianSessionsPerActiveDay,
    medianSessionToolCalls,
    longestStreak,
    peakDayToolCalls,
    cadence,
    sessionShape,
    timezone: tz, // recorded so activeDays/streak reproduce on any machine
  };
}

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

const DAY_MS = 86_400_000;
const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);
const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export function computeIntensity(parsed) {
  const sessions = parsed?.sessions ?? [];
  if (sessions.length === 0) return null;

  // Per-session aggregates
  const perSession = [];
  const perDaySessions = new Map(); // day → count of sessions opened that day
  const perDayToolCalls = new Map();
  let firstTs = Infinity;
  let lastTs = -Infinity;

  for (const s of sessions) {
    const start = s.firstTs ? Date.parse(s.firstTs) : null;
    const end = s.lastTs ? Date.parse(s.lastTs) : start;
    if (!Number.isFinite(start)) continue;
    let toolCalls = 0;
    for (const m of s.messages ?? []) toolCalls += (m.toolUses?.length ?? 0);
    perSession.push({ start, end, toolCalls });
    const d = dayKey(start);
    perDaySessions.set(d, (perDaySessions.get(d) ?? 0) + 1);
    perDayToolCalls.set(d, (perDayToolCalls.get(d) ?? 0) + toolCalls);
    if (start < firstTs) firstTs = start;
    if (end > lastTs) lastTs = end;
  }
  if (!perSession.length) return null;

  // Observed window in days, inclusive.
  const observedDays = Math.max(1, Math.round((lastTs - firstTs) / DAY_MS) + 1);
  const activeDays = perDaySessions.size;
  const activeDaysRatio = +(activeDays / observedDays).toFixed(2);

  // Median sessions per active day (NOT per observed day — we want the cadence
  // on the days they actually showed up).
  const sessionsPerActiveDay = [...perDaySessions.values()];
  const medianSessionsPerActiveDay = median(sessionsPerActiveDay);

  // Median session tool calls (proxy for session depth).
  const toolCallsPerSession = perSession.map((s) => s.toolCalls);
  const medianSessionToolCalls = median(toolCallsPerSession);

  // Longest consecutive-active-days streak.
  const dayStamps = [...perDaySessions.keys()].sort();
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
    activeDays,
    activeDaysRatio,
    medianSessionsPerActiveDay,
    medianSessionToolCalls,
    longestStreak,
    peakDayToolCalls,
    cadence,
    sessionShape,
  };
}

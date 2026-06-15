// Shared active-day definition.
//
// One definition, used by BOTH the fingerprint (src/fingerprint.mjs) and the
// practice-intensity lens (src/intensity.mjs), so the two can never drift apart
// again. A day is "active" when it carries REAL message activity; days are
// bucketed in a fixed, recorded timezone so the count re-derives identically on
// any machine (CONTRIBUTING: determinism — record the offset used). There is NO
// interpolation across gaps: a long-lived or resumed session marks only the days
// it actually had a message on, never the idle days between first and last.

// Default to UTC: machine-independent, and identical to the historical
// `new Date(t).toISOString().slice(0,10)` bucketing. A caller may pass an IANA
// zone (e.g. "Europe/Rome") for a candidate-local count; whatever zone is used
// is recorded in the profile so the number stays reproducible.
export const DEFAULT_TZ = "UTC";

// Day key (YYYY-MM-DD) in an explicit timezone. Uses Intl with an explicit
// `timeZone`, so it does NOT depend on the host machine's TZ env or locale.
export function dayKeyFor(tz = DEFAULT_TZ) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz });
  return (ts) => fmt.format(new Date(ts));
}

// The set of day keys (in `tz`) that carry real activity. `timestamps` is a
// flat list of epoch-ms values (one per message); non-finite values are ignored.
export function activeDayKeys(timestamps, tz = DEFAULT_TZ) {
  const key = dayKeyFor(tz);
  const days = new Set();
  for (const t of timestamps) if (Number.isFinite(t)) days.add(key(t));
  return days;
}

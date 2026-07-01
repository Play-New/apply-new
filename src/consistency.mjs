// Pre-submit consistency: the profile's deterministic claims, re-checked.
//
// Groundedness (groundedness.mjs) checks that the PROSE tracks the structured
// data. It cannot catch a coherent tamper: edit the structured numbers AND the
// prose together and groundedness still passes. These checks close that gap
// with two layers:
//
//  1. STRUCTURE (no logs needed): internal invariants that any honestly
//     generated profile satisfies exactly — projects + otherProjects sum to
//     volume, scores stay in range. The same invariants are re-checked
//     server-side at intake, so editing them client-side buys nothing.
//  2. LOGS: re-read the logs at submit time and re-derive the facts. The logs
//     are the ground truth the profile claims to describe, and they only ever
//     grow between generation and submission (until retention pruning kicks
//     in). A profile that claims MORE than the logs contain is either tampered
//     or describes logs that were since pruned. Either way: regenerate.
//
// Honest limit, stated plainly: everything here runs on the candidate's
// machine, on the candidate's data. It is a screen, not proof — the same
// stance as the authenticity score. The durable backstop is the intake
// re-computing groundedness and structure on the received JSON.

export function assessStructure(profile) {
  const issues = [];
  const projects = profile?.projects ?? [];
  const others = profile?.otherProjects ?? [];
  const vol = profile?.volume ?? {};

  const products = projects.length + others.length;
  if (vol.products != null && products !== vol.products) {
    issues.push(`volume.products is ${vol.products} but the profile lists ${products} projects (${projects.length} representative + ${others.length} inventory)`);
  }

  const sessions = [...projects, ...others].reduce((n, p) => n + (Number(p.sessions) || 0), 0);
  if (vol.sessions != null && sessions !== vol.sessions) {
    issues.push(`volume.sessions is ${vol.sessions} but per-project sessions sum to ${sessions}`);
  }

  // Coverage invariant: the profile cannot contain more sessions than its
  // sources captured (capture counts include ephemeral sessions the digest
  // later drops, so capture is an upper bound on volume).
  if (Array.isArray(profile?.sources) && profile.sources.length) {
    const captured = profile.sources.reduce((n, s) => n + (Number(s.sessions) || 0), 0);
    if (vol.sessions != null && vol.sessions > captured) {
      issues.push(`volume.sessions is ${vol.sessions} but the sources block records only ${captured} sessions read`);
    }
  }

  // Day-count invariant: a day cannot be active outside the observed window.
  // Both counts bucket in the same recorded timezone since #8, so this holds
  // by construction in honest output — a violation means a hand-edit.
  const it = profile?.intensity;
  if (it?.activeDays != null && it?.observedDays != null && Number(it.activeDays) > Number(it.observedDays)) {
    issues.push(`intensity.activeDays is ${it.activeDays} but the observed window is only ${it.observedDays} days`);
  }

  // Orchestration invariants (per project, when the block is present). The
  // orchestration counts are citable in prose (groundedness pools them), so
  // they need the same tamper posture as sessions: every one re-derives from
  // data already in the profile, and an edit that inflates one breaks an
  // equality it cannot also fix. Per-CLI session counts sum to the project's
  // sessions (each session is tagged exactly once), toolCount re-derives from
  // the split ("unknown" is not a distinct CLI), and the two delegation
  // copies agree.
  for (const p of projects) {
    const o = p?.metrics?.orchestration;
    if (!o) continue;
    const tools = o.tools ?? {};
    const toolSum = Object.values(tools).reduce((n, v) => n + (Number(v) || 0), 0);
    if (p.sessions != null && toolSum !== Number(p.sessions)) {
      issues.push(`${p.id}: orchestration.tools sums to ${toolSum} sessions but the project claims ${p.sessions}`);
    }
    // A tools entry with no sessions never touched the product — it can only
    // exist to pad toolCount into a phantom fan-out claim (the sum invariant
    // alone tolerates a smuggled zero).
    for (const [tool, v] of Object.entries(tools)) {
      if (!(Number(v) >= 1)) {
        issues.push(`${p.id}: orchestration.tools.${tool} is ${v} — a CLI with no sessions cannot have touched the product`);
      }
    }
    const knownTools = Object.keys(tools).filter((k) => k !== "unknown").length;
    const derivedCount = Math.max(knownTools, 1);
    if (o.toolCount != null && Number(o.toolCount) !== derivedCount) {
      issues.push(`${p.id}: orchestration.toolCount is ${o.toolCount} but the tools split re-derives ${derivedCount}`);
    }
    if (o.delegation != null && p.metrics?.delegation != null && Number(o.delegation) !== Number(p.metrics.delegation)) {
      issues.push(`${p.id}: metrics.delegation is ${p.metrics.delegation} but orchestration.delegation says ${o.delegation}`);
    }
  }

  const auth = profile?.authenticity?.score;
  if (auth != null && (auth < 0 || auth > 100)) issues.push(`authenticity.score out of range: ${auth}`);
  const ground = profile?.groundedness?.score;
  if (ground != null && (ground < 0 || ground > 100)) issues.push(`groundedness.score out of range: ${ground}`);

  return { issues };
}

// The submit gate, as one pure function so every consumer (submit --yes,
// submit --dry-run) blocks on exactly the same conditions. An UNSCORED
// groundedness (fewer than 4 checkable anchors in the prose) blocks like a
// low one: prose the screen cannot check at all must not pass the gate that
// exists to check prose — the intake flags the same case server-side.
export function submitBlockers({ issues = [], groundedness = null, force = false } = {}) {
  if (force) return [];
  const blockers = [];
  if (issues.length) blockers.push({ kind: "consistency", count: issues.length });
  const score = groundedness?.score;
  if (score == null) blockers.push({ kind: "groundedness-unscored" });
  else if (score < 60) blockers.push({ kind: "groundedness-low", score });
  return blockers;
}

// digestProjects: the per-repo clusters re-derived from the logs right now
// (buildDigest(readClaudeCode(root)).projects). Profile projects are matched
// by repoLabel — present locally until submit strips it from the payload. A
// project whose repoLabel was removed by hand is reported as unverifiable
// (warning), not as a violation.
//
// opts.intensity: the practice-intensity block re-derived from the logs in the
// profile's RECORDED timezone (computeIntensity(parsed, { tz: profile.intensity
// .timezone })) — never the machine zone, or a candidate who generated with
// --tz Europe/Rome and submits from a CI box would be flagged for the bucketing
// difference, not for any real excess.
export function assessAgainstLogs(profile, digestProjects, opts = {}) {
  const issues = [];
  const warnings = [];
  const byRepo = new Map((digestProjects ?? []).map((p) => [p.repo, p]));

  // The gate is one-directional: claims must not EXCEED the logs. Ongoing use
  // only grows the logs, so excess claims have exactly two causes — the logs
  // were pruned after generation (Claude Code's cleanup ages out old
  // sessions), or the file was inflated by hand. Counting them separately
  // lets submit name the common, innocent cause and prescribe the fix.
  let excessClaims = 0;
  const excess = (msg) => { issues.push(msg); excessClaims++; };

  const vol = profile?.volume ?? {};
  const totalSessions = (digestProjects ?? []).reduce((n, p) => n + (p.sessions || 0), 0);
  const totalInstructions = (digestProjects ?? []).reduce((n, p) => n + (p.userMessages || 0), 0);
  if (vol.products != null && vol.products > (digestProjects?.length ?? 0)) {
    excess(`profile claims ${vol.products} products but the logs contain ${digestProjects?.length ?? 0}`);
  }
  if (vol.sessions != null && vol.sessions > totalSessions) {
    excess(`profile claims ${vol.sessions} sessions but the logs contain ${totalSessions}`);
  }
  if (vol.instructions != null && vol.instructions > totalInstructions) {
    excess(`profile claims ${vol.instructions} instructions but the logs contain ${totalInstructions}`);
  }

  for (const p of profile?.projects ?? []) {
    if (!p.repoLabel) {
      warnings.push(`${p.id}: repoLabel removed, cannot re-verify against the logs`);
      continue;
    }
    const d = byRepo.get(p.repoLabel);
    if (!d) {
      issues.push(`${p.id} (${p.repoLabel}): no such project in the logs`);
      continue;
    }
    if ((Number(p.sessions) || 0) > (d.sessions || 0)) {
      excess(`${p.id} (${p.repoLabel}): claims ${p.sessions} sessions, logs show ${d.sessions}`);
    }
    if ((Number(p.landing?.commits) || 0) > (d.landing?.commits || 0)) {
      excess(`${p.id} (${p.repoLabel}): claims ${p.landing.commits} commits, logs show ${d.landing?.commits ?? 0}`);
    }
    // Orchestration counts, same one-directional gate: per-CLI session counts
    // and dispatch counts only grow with ongoing use, so a claim above the
    // re-derivation is pruning or inflation — the numbers groundedness lets
    // the prose cite must also survive re-derivation. dispatchCommands has a
    // third innocent cause the others don't: it is matcher-derived, so a tool
    // update that tightens dispatch detection shrinks the re-derivation on
    // unchanged logs. The message names it; the remedy is the same either
    // way: regenerate.
    const co = p.metrics?.orchestration;
    const dor = d.orchestration;
    if (co && dor) {
      if ((Number(co.dispatchCommands) || 0) > (dor.dispatchCommands || 0)) {
        excess(`${p.id} (${p.repoLabel}): claims ${co.dispatchCommands} agent dispatches, logs re-derive ${dor.dispatchCommands ?? 0} (dispatch detection may also have changed in an update — regenerate)`);
      }
      for (const [tool, n] of Object.entries(co.tools ?? {})) {
        if ((Number(n) || 0) > (dor.tools?.[tool] || 0)) {
          excess(`${p.id} (${p.repoLabel}): claims ${n} sessions via ${tool}, logs show ${dor.tools?.[tool] ?? 0}`);
        }
      }
      if ((Number(co.delegation) || 0) > (dor.delegation || 0)) {
        excess(`${p.id} (${p.repoLabel}): claims ${co.delegation} sub-agent delegations, logs show ${dor.delegation ?? 0}`);
      }
      // toolOverlap is one-directional too: ongoing use can only flip it
      // false -> true, and the flip is exactly what turns "migration" prose
      // into "concurrent fan-out" — a hand-edit worth its own gate.
      if (co.toolOverlap === true && dor.toolOverlap === false) {
        excess(`${p.id} (${p.repoLabel}): claims concurrent multi-CLI use (toolOverlap true) but the logs re-derive disjoint eras`);
      }
    }
  }

  // Day-based intensity claims, same one-directional gate: pruning ages whole
  // days out of the logs, so the re-derived count can only be SMALLER than an
  // honest claim when sessions were pruned — and ongoing use only adds days.
  const claimed = profile?.intensity;
  const derived = opts.intensity;
  if (claimed && derived) {
    if ((Number(claimed.activeDays) || 0) > (derived.activeDays || 0)) {
      excess(`profile claims ${claimed.activeDays} active days but the logs re-derive ${derived.activeDays} (timezone ${derived.timezone ?? "UTC"})`);
    }
    if ((Number(claimed.longestStreak) || 0) > (derived.longestStreak || 0)) {
      excess(`profile claims a ${claimed.longestStreak}-day streak but the logs re-derive ${derived.longestStreak}`);
    }
  }

  return { issues, warnings, excessClaims };
}

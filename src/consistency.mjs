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

  const auth = profile?.authenticity?.score;
  if (auth != null && (auth < 0 || auth > 100)) issues.push(`authenticity.score out of range: ${auth}`);
  const ground = profile?.groundedness?.score;
  if (ground != null && (ground < 0 || ground > 100)) issues.push(`groundedness.score out of range: ${ground}`);

  return { issues };
}

// digestProjects: the per-repo clusters re-derived from the logs right now
// (buildDigest(readClaudeCode(root)).projects). Profile projects are matched
// by repoLabel — present locally until submit strips it from the payload. A
// project whose repoLabel was removed by hand is reported as unverifiable
// (warning), not as a violation.
export function assessAgainstLogs(profile, digestProjects) {
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
  }

  return { issues, warnings, excessClaims };
}

// playnew-profile/v1: one source of truth (JSON) + a deterministic Markdown
// render. Structured facts come from the digest/fingerprint/forensics; the
// prose fields come from the narrative step. The Markdown is just a view, so
// human and agent never diverge.

// --- representative selection: significance leads, diversity breaks ties -----
//
// The pick is driven by how SIGNIFICANT the work is, not by how many chat
// sessions a repo accumulated. Each signal is normalised against the
// candidate's own portfolio (scale-free: a light user and a heavy user are
// scored on the same 0..1 axis), then weighted. Recency and type diversity are
// bounded nudges that can break a near-tie but never outweigh real substance.

// Relative significance weights. The point of taring lives here: if real-data
// selection looks skewed, adjust these, not the structure.
const W = { sessions: 0.30, commits: 0.25, mutations: 0.20, span: 0.10, type: 0.15 };
const CHECKS_BONUS = 0.05;   // verification discipline
const CHURN_PENALTY = 0.05;  // high revert churn
const RECENCY_BONUS = 0.15;  // within the last 2 months of the window
const DIVERSITY_NUDGE = 0.10; // a primary type the picks don't cover yet

// How much each project TYPE counts toward significance. Shipping a product
// outweighs an exploratory poke even at equal volume.
const TYPE_WEIGHT = {
  "product-build": 1.0, "ai-platform": 1.0, "product": 1.0,
  "feature-work": 0.6, "data-migration": 0.6, "audit-research": 0.6,
  "agent-tooling": 0.6, "static-site": 0.5, "testing": 0.5,
  "exploration": 0.2,
};
const primary = (p) => p.type?.[0] || "exploration";
const typeWeight = (p) => TYPE_WEIGHT[primary(p)] ?? 0.5;

// "Recent" = last 2 months of the candidate's own window, not a fixed date.
// Returns a "YYYY-MM" cutoff or null if the projects don't carry a usable end.
function recencyCutoff(projects) {
  const tos = projects.map((p) => p.to).filter(Boolean).sort();
  if (!tos.length) return null;
  const [y, m] = tos.at(-1).split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return null;
  const d = new Date(Date.UTC(y, m - 1 - 2, 1)); // 2 months before the last end
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const isRecent = (p, recentSince) => !!(recentSince && p.to && p.to >= recentSince);

// Months spanned by a project, from "YYYY-MM" bounds (inclusive, min 1).
function spanMonths(p) {
  if (!p.from || !p.to) return 1;
  const [fy, fm] = p.from.split("-").map(Number);
  const [ty, tm] = p.to.split("-").map(Number);
  if (![fy, fm, ty, tm].every(Number.isFinite)) return 1;
  return Math.max(1, (ty - fy) * 12 + (tm - fm) + 1);
}

// Build per-portfolio normalisers (the max of each signal, guarded against 0).
function normalizers(projects) {
  const max = (f) => Math.max(1, ...projects.map(f));
  return {
    sessions: max((p) => p.sessions || 0),
    commits: max((p) => p.landing?.commits || 0),
    mutations: max((p) => p.mutations || 0),
    span: max(spanMonths),
  };
}

// Composite significance in roughly [0,1]. No recency or diversity here — those
// are applied at selection time so the same score drives adaptiveCount cleanly.
function significance(p, nrm) {
  let s =
    W.sessions * ((p.sessions || 0) / nrm.sessions) +
    W.commits * ((p.landing?.commits || 0) / nrm.commits) +
    W.mutations * ((p.mutations || 0) / nrm.mutations) +
    W.span * (spanMonths(p) / nrm.span) +
    W.type * typeWeight(p);
  if (p.landing?.checksRun) s += CHECKS_BONUS;
  if (p.landing?.revertChurn === "high") s -= CHURN_PENALTY;
  return s;
}

// Adaptive count: 3 to 5, decided by the portfolio itself. Three picks always;
// a 4th and a 5th slot only when the next-ranked project EARNS it — it covers a
// primary type the picks don't, or it is nearly as significant as the 3rd pick
// (>= 60% of its significance). A concentrated, homogeneous history stays at 3;
// a spread, diverse one grows to 5.
function adaptiveCount(ranked, sig) {
  let n = Math.min(3, ranked.length);
  const types = new Set(ranked.slice(0, n).map(primary));
  const anchor = ranked[2] ? sig(ranked[2]) : 0;
  for (let i = n; i < Math.min(ranked.length, 5); i++) {
    const p = ranked[i];
    if (!types.has(primary(p)) || sig(p) >= 0.6 * anchor) {
      n++;
      types.add(primary(p));
    } else break;
  }
  return n;
}

export function selectRepresentatives(projects, n = "auto") {
  const recentSince = recencyCutoff(projects);
  const nrm = normalizers(projects);
  const sig = (p) => significance(p, nrm) + (isRecent(p, recentSince) ? RECENCY_BONUS : 0);
  // Significance drives the count; the diversity nudge is selection-only.
  const ranked = [...projects].sort((a, b) => sig(b) - sig(a));
  if (n === "auto" || n == null || !Number.isFinite(+n)) n = adaptiveCount(ranked, sig);

  // Greedy pick: at each step take the highest adjusted score, where a not-yet-
  // covered primary type gets a small nudge. Significance leads; the nudge only
  // breaks near-ties, it can't lift a marginal project over a substantial one.
  const picked = [];
  const types = new Set();
  const remaining = new Set(projects);
  while (picked.length < n && remaining.size) {
    let best = null, bestScore = -Infinity;
    for (const p of remaining) {
      const adj = sig(p) + (types.has(primary(p)) ? 0 : DIVERSITY_NUDGE);
      if (adj > bestScore) { bestScore = adj; best = p; }
    }
    picked.push(best);
    types.add(primary(best));
    remaining.delete(best);
  }
  const pickedSet = new Set(picked);
  return projects.map((p) => ({ ...p, selected: pickedSet.has(p) }));
}

// --- cognitive tags from aggregate signals -----------------------------------

function cognitiveTags(projects, fingerprint) {
  const tags = [];
  const totalCommits = projects.reduce((n, p) => n + (p.landing.commits || 0), 0);
  const totalReverts = projects.reduce((n, p) => n + (p.landing.reverts || 0), 0);
  const totalDeleg = projects.reduce((n, p) => n + (p.delegation || 0), 0);
  const checks = projects.filter((p) => p.landing.checksRun).length;
  const rms = projects.map((p) => p.researchToMutation).filter((x) => x != null);
  const avgRM = rms.length ? rms.reduce((a, b) => a + b, 0) / rms.length : 0;

  if (avgRM > 2) tags.push("research-first");
  if ((fingerprint?.style?.medianPromptWords || 0) >= 25) tags.push("decomposer");
  if (totalDeleg >= 15) tags.push("orchestrator");
  if (checks >= projects.length / 2) tags.push("verification-heavy");
  if (totalCommits > 20 && totalReverts / Math.max(totalCommits, 1) < 0.1) tags.push("risk-calibrated");
  return tags;
}

// --- sources ------------------------------------------------------------------

// Capture level per source. "full" = tamper-evident records the forensic
// screen can actually verify (request ids, signatures, usage shapes);
// "structural" = well-formed session data with no verification story.
// Unknown sources default to structural — honesty about what we can't verify.
const CAPTURE_LEVEL = { "claude-code": "full" };

// Per-source coverage summary for the profile: which sources were read, at
// what capture level, how many sessions each contributed, over which months.
// Counts here are CAPTURE counts (everything read, ephemeral included), so
// they are an upper bound on what enters the profile — and the profile's own
// window/counts stay lower bounds of the candidate's real activity, because
// logs rotate and old sessions are pruned.
export function summarizeSources(parsed) {
  if (!parsed?.sessions?.length) return null;
  const by = new Map();
  for (const s of parsed.sessions) {
    const key = s.source || "claude-code";
    const e = by.get(key) || { source: key, sessions: 0, from: null, to: null };
    e.sessions++;
    const from = typeof s.firstTs === "string" ? s.firstTs.slice(0, 7) : null;
    const to = typeof s.lastTs === "string" ? s.lastTs.slice(0, 7) : from;
    if (from && (!e.from || from < e.from)) e.from = from;
    if (to && (!e.to || to > e.to)) e.to = to;
    by.set(key, e);
  }
  return [...by.values()].map((e) => ({
    source: e.source,
    captureLevel: CAPTURE_LEVEL[e.source] ?? "structural",
    sessions: e.sessions,
    window: e.from ? { from: e.from, to: e.to } : null,
    // Which read path served this source, when it has more than one (e.g.
    // opencode's sqlite db vs its partial JSON cache). mergeSources carries it
    // out of the adapters; null for sources with a single read path.
    backend: parsed.backends?.[e.source] ?? null,
  }));
}

// --- assemble ----------------------------------------------------------------

export function assembleProfile({ contact, projects, narrative, fingerprint, forensics, manifestHash, trajectory, groundedness, aiRelationship, agenticLiteracy, intensity, distribution, sources }) {
  const froms = projects.map((p) => p.from).filter(Boolean).sort();
  const tos = projects.map((p) => p.to).filter(Boolean).sort();
  const selected = projects.filter((p) => p.selected);
  const others = projects.filter((p) => !p.selected);
  const nById = (i) => narrative?.projects?.find((x) => x.id === `p${i + 1}`) || {};

  return {
    schema: "playnew-profile/v1",
    generatedAt: new Date().toISOString(),
    // The candidate's only declared identity. No surname in v1.
    contact: contact && typeof contact === "object" ? contact : { name: contact || null },
    window: { from: froms[0] || null, to: tos.at(-1) || null },
    volume: {
      products: projects.length,
      sessions: projects.reduce((n, p) => n + p.sessions, 0),
      instructions: projects.reduce((n, p) => n + p.userMessages, 0),
    },
    // Coverage disclosure (optional; absent on profiles from older versions).
    // What was read, at what capture level — the profile's own honesty about
    // its inputs. Spread keeps the old shape byte-identical when absent.
    ...(sources?.length ? { sources } : {}),
    summary: narrative?.summary || null,
    // Aggregate fields of work, derived by the LLM from per-product evidence.
    // Counts, not names: each entry is { label, products, sessions, note? }.
    domains: narrative?.domains || [],
    projects: selected.map((p, i) => ({
      id: `p${i + 1}`,
      // Repo label: the directory name of the candidate's own repo. Lets the
      // candidate match `p1` to a concrete project they recognise during
      // curation. They can remove it from candidate.json before submitting
      // if it would leak a client name.
      repoLabel: p.repo || null,
      selected: true,
      type: p.type,
      domain: nById(i).domain || null,
      span: { from: p.from, to: p.to },
      sessions: p.sessions,
      did: nById(i).did || null,
      whyRepresentative: nById(i).why_representative || null,
      tech: p.tech,
      landing: p.landing,
      metrics: { researchToMutation: p.researchToMutation, delegation: p.delegation },
      artifact: null, // candidate opt-in
    })),
    otherProjects: others.map((p) => ({
      repoLabel: p.repo || null,
      type: p.type, span: { from: p.from, to: p.to }, sessions: p.sessions, includedBy: "tool:inventory",
    })),
    cognitive: { tags: cognitiveTags(projects, fingerprint), narrative: narrative?.cognitive?.narrative || null },
    aiRelationship: aiRelationship
      ? {
          mode: aiRelationship.mode,
          directing: aiRelationship.directing,
          coThinking: aiRelationship.coThinking,
          narrative: narrative?.ai_relationship?.narrative || null,
        }
      : null,
    agenticLiteracy: agenticLiteracy
      ? {
          ...agenticLiteracy,
          narrative: narrative?.agentic_literacy?.narrative || null,
        }
      : null,
    intensity: intensity
      ? { ...intensity, narrative: narrative?.intensity?.narrative || null }
      : null,
    distribution: distribution
      ? { ...distribution, narrative: narrative?.distribution?.narrative || null }
      : null,
    trajectory: trajectory
      ? {
          // Deterministic facts (Lot 1).
          shifts: trajectory.shifts?.available ? trajectory.shifts : null,
          topics: trajectory.topics || [],
          // ONLY the narrative's filtered pick. The raw vocabularyCandidates
          // are unfiltered late-half words and can carry client or product
          // names — they must never reach candidate.json.
          newVocabulary: narrative?.trajectory?.vocabulary_adopted ?? [],
          // LLM-derived (Lot 2). Optional — may be null if no narrative ran.
          narrative: narrative?.trajectory?.narrative || null,
          principlesAdopted: narrative?.trajectory?.principles_adopted || [],
        }
      : null,
    stackAdopted: [...new Set(projects.flatMap((p) => p.tech))],
    authenticity: {
      score: forensics?.score ?? null,
      manifestHash: manifestHash || null,
      // The forensic checks inspect tamper-evident fields only full-capture
      // sources carry; say so the moment a structural source is in the mix.
      note: sources?.some((s) => s.captureLevel !== "full")
        ? "screen, not proof; verifies full-capture sources only"
        : "screen, not proof",
    },
    groundedness: groundedness
      ? { score: groundedness.score, supported: groundedness.supported, total: groundedness.total }
      : null,
  };
}

// --- render -------------------------------------------------------------------

const land = (l) =>
  `commits ${l.commits} · reverts ${l.reverts} · churn ${l.revertChurn}${l.checksRun ? " · checks passed" : ""}`;

export function renderMarkdown(p) {
  const L = [];
  const c = p.contact || {};
  L.push(`# Agentic profile${c.name ? ` — ${c.name}` : ""}`);
  const meta = [c.email, c.city, c.status].filter(Boolean).join(" · ");
  if (meta) L.push(meta);
  L.push(
    `Window: ${p.window.from} → ${p.window.to} · ${p.volume.sessions} sessions · ${p.volume.instructions} instructions · ${p.volume.products} products`,
  );
  L.push(`Log consistency screen: ${p.authenticity.score}/100 (${p.authenticity.note})`);
  if (p.sources?.length) {
    const src = p.sources
      .map((s) => `${s.source} (${s.captureLevel} capture${s.backend ? `, ${s.backend}` : ""}) · ${s.sessions} sessions read`)
      .join(" · ");
    L.push(`Sources: ${src}`);
    L.push(`Window and counts are lower bounds: logs rotate and old sessions are pruned.`);
  }
  if (p.summary) L.push(`\n${p.summary}`);

  if (p.domains?.length) {
    L.push(`\n## Domains`);
    for (const d of p.domains) {
      const note = d.note ? ` — ${d.note}` : "";
      L.push(`- **${d.label}** · ${d.products} products · ${d.sessions} sessions${note}`);
    }
  }

  L.push(`\n## Representative projects`);
  for (const pr of p.projects) {
    const headTail = pr.repoLabel ? ` _(${pr.id} — ${pr.repoLabel})_` : ` _(${pr.id})_`;
    L.push(`\n### ${pr.domain || "(domain)"}  ·  ${pr.type.join(" · ")}${headTail}`);
    L.push(`${pr.span.from ?? "n/a"}→${pr.span.to ?? "n/a"} · ${pr.sessions} sessions · ${land(pr.landing)}`);
    if (pr.tech.length) L.push(`stack: ${pr.tech.join(", ")}`);
    if (pr.did) L.push(pr.did);
    if (pr.whyRepresentative) L.push(`_why representative:_ ${pr.whyRepresentative}`);
    L.push(`artifact: ${pr.artifact ? pr.artifact.label : "— (none attached)"}`);
  }

  if (p.otherProjects.length) {
    L.push(`\n## Other projects (inventory)`);
    for (const o of p.otherProjects) {
      const tag = o.repoLabel ? ` _(${o.repoLabel})_` : "";
      L.push(`- ${o.type.join(" · ")} · ${o.span.from ?? "n/a"}→${o.span.to ?? "n/a"} · ${o.sessions} sess${tag}`);
    }
  }

  L.push(`\n## Cognitive profile`);
  if (p.cognitive.tags.length) L.push(`tags: ${p.cognitive.tags.join(" · ")}`);
  if (p.cognitive.narrative) L.push(p.cognitive.narrative);

  if (p.aiRelationship) {
    L.push(`\n## How they work with the AI`);
    L.push(`${p.aiRelationship.directing}% directing · ${p.aiRelationship.coThinking}% co-thinking · ${p.aiRelationship.mode}`);
    if (p.aiRelationship.narrative) L.push(p.aiRelationship.narrative);
  }

  if (p.intensity) {
    const i = p.intensity;
    L.push(`\n## Practice intensity`);
    const tzNote = i.timezone && i.timezone !== "UTC" ? ` (days counted in ${i.timezone})` : "";
    L.push(`- Active days: ${i.activeDays} / ${i.observedDays} (${Math.round(i.activeDaysRatio * 100)}%)${tzNote}`);
    L.push(`- Median sessions per active day: ${i.medianSessionsPerActiveDay}`);
    L.push(`- Median session depth: ${i.medianSessionToolCalls} tool calls`);
    L.push(`- Longest streak: ${i.longestStreak} consecutive days`);
    L.push(`- Peak day: ${i.peakDayToolCalls} tool calls`);
    L.push(`Cadence: ${i.cadence} · ${i.sessionShape}`);
    if (i.narrative) L.push(`\n${i.narrative}`);
  }

  if (p.distribution) {
    const d = p.distribution;
    L.push(`\n## Work distribution`);
    L.push(`- Sessions per product: median ${d.medianSessionsPerProduct} · mean ${d.meanSessionsPerProduct}`);
    L.push(`- Top 3 products: ${Math.round(d.top3Share * 100)}% of all sessions`);
    L.push(`- Multi-month products: ${d.multiMonthProducts} / ${d.products} (${Math.round(d.multiMonthShare * 100)}%)`);
    L.push(`Shape: ${d.shape}`);
    if (d.narrative) L.push(`\n${d.narrative}`);
  }

  if (p.agenticLiteracy) {
    const a = p.agenticLiteracy;
    L.push(`\n## Agentic literacy`);
    L.push(`Uses`);
    L.push(`- Sub-agent delegations: ${a.uses.subagentDelegations}`);
    L.push(`- Task tracking events: ${a.uses.taskTrackingEvents}`);
    L.push(`- Built-in slash commands invoked: ${a.uses.builtinSlashInvocations}`);
    L.push(`- Custom skills/commands: ${a.uses.customSkillsCommands.distinct} distinct, ${a.uses.customSkillsCommands.invocations} invocations`);
    L.push(`- Public MCP servers: ${a.uses.publicMcp.servers} · ${a.uses.publicMcp.calls} calls`);
    L.push(`- Custom MCP servers: ${a.uses.customMcp.servers} · ${a.uses.customMcp.tools} tools · ${a.uses.customMcp.calls} calls`);
    L.push(`\nBuilds`);
    L.push(`- Skills authored: ${a.builds.skillsAuthored}`);
    L.push(`- Commands authored: ${a.builds.commandsAuthored}`);
    L.push(`- Agents authored: ${a.builds.agentsAuthored}`);
    L.push(`- Hooks edited: ${a.builds.hooksEdited}`);
    L.push(`- Project memory files (CLAUDE.md): ${a.builds.projectMemoryFiles}`);
    L.push(`\nDesigns`);
    L.push(`- Plans-first (ExitPlanMode): ${a.designs.plansFirst}`);
    L.push(`- Subtask tracking (TodoWrite): ${a.designs.subtaskTracking}`);
    L.push(`- Clarifies (AskUserQuestion): ${a.designs.clarifies}`);
    if (a.narrative) L.push(`\n${a.narrative}`);
  }

  // Trajectory: what changed strategically over the window. Numbers first, then
  // the LLM narrative, then the principles the candidate codified for themselves.
  if (p.trajectory) {
    L.push(`\n## Trajectory`);
    if (p.trajectory.narrative) L.push(p.trajectory.narrative);

    if (p.trajectory.shifts && p.trajectory.shifts.deltas) {
      L.push(`\nBehavioral shifts (early → late half${p.trajectory.shifts.midpoint ? `, split at ${p.trajectory.shifts.midpoint}` : ""}):`);
      for (const d of p.trajectory.shifts.deltas) {
        const arrow = d.dir === "up" ? "↑" : d.dir === "down" ? "↓" : d.dir === "stable" ? "·" : "";
        L.push(`- ${d.metric}: ${formatVal(d.early, d.format)} → ${formatVal(d.late, d.format)} ${arrow}`);
      }
    }

    if (p.trajectory.topics?.length) {
      L.push(`\nTopics explored, by quarter:`);
      for (const q of p.trajectory.topics) {
        L.push(`- ${q.quarter}: ${q.themes.map((t) => `${t.name} (${t.count})`).join(", ")}`);
      }
    }

    if (p.trajectory.newVocabulary?.length) {
      L.push(`\nNew vocabulary adopted: ${p.trajectory.newVocabulary.join(", ")}`);
    }

    if (p.trajectory.principlesAdopted?.length) {
      L.push(`\nPrinciples codified:`);
      for (const pr of p.trajectory.principlesAdopted) {
        const when = pr.when ? `_${pr.when}_ — ` : "";
        L.push(`- ${when}${pr.text}`);
      }
    }
  }

  if (p.stackAdopted?.length) {
    L.push(`\n## Stack adopted`);
    L.push(p.stackAdopted.join(", "));
    // Disclosed boundaries — detection reads package.json + touched files, never
    // .env: (1) deps reflect the repo as it stands now, not at session time;
    // (2) npm manifests only — no pyproject/requirements; (3) deps are absent if
    // the project folder no longer exists; (4) REST-only services (an API key,
    // no package) are not auto-detected.
    L.push(`_Stack as currently declared in the repo: from package.json dependencies (npm manifests only) and the files touched. Dependencies are unavailable if the project folder no longer exists, and services used only over REST (no package) are not auto-detected._`);
  }

  return L.join("\n") + "\n";
}

function formatVal(v, fmt) {
  if (v == null) return "n/a";
  if (fmt === "percent") return `${Math.round(v * 100)}%`;
  if (fmt === "ratio") return typeof v === "number" ? v.toFixed(2) : String(v);
  return String(v);
}

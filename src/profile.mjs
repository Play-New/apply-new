// playnew-profile/v1: one source of truth (JSON) + a deterministic Markdown
// render. Structured facts come from the digest/fingerprint/forensics; the
// prose fields come from the narrative step. The Markdown is just a view, so
// human and agent never diverge.

// --- representative selection: significance, then type diversity -------------

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

function score(p, recentSince) {
  let s = p.sessions + 0.1 * (p.landing.commits || 0);
  if (recentSince && p.to && p.to >= recentSince) s += 8;
  return s;
}

export function selectRepresentatives(projects, n = 4) {
  const recentSince = recencyCutoff(projects);
  const ranked = [...projects].sort((a, b) => score(b, recentSince) - score(a, recentSince));
  const picked = [];
  const types = new Set();
  const primary = (p) => p.type[0] || "exploration";
  // 1) flagships: the top half by pure significance, regardless of type.
  const core = Math.max(1, Math.floor(n / 2));
  for (const p of ranked) {
    if (picked.length >= core) break;
    picked.push(p);
    types.add(primary(p));
  }
  // 2) diversity: fill remaining slots with new primary types.
  for (const p of ranked) {
    if (picked.length >= n) break;
    if (picked.includes(p)) continue;
    if (!types.has(primary(p))) {
      picked.push(p);
      types.add(primary(p));
    }
  }
  // 3) fill any leftover slots by score.
  for (const p of ranked) {
    if (picked.length >= n) break;
    if (!picked.includes(p)) picked.push(p);
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

// --- assemble ----------------------------------------------------------------

export function assembleProfile({ contact, projects, narrative, fingerprint, forensics, manifestHash, trajectory, groundedness, aiRelationship, agenticLiteracy, intensity, distribution }) {
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
    summary: narrative?.summary || null,
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
          // The LLM filters domain/technical words out of the raw recurring
          // list; if the model didn't run, fall back to the raw candidates.
          newVocabulary:
            narrative?.trajectory?.vocabulary_adopted ?? trajectory.vocabularyCandidates ?? [],
          // LLM-derived (Lot 2). Optional — may be null if no narrative ran.
          narrative: narrative?.trajectory?.narrative || null,
          principlesAdopted: narrative?.trajectory?.principles_adopted || [],
        }
      : null,
    stackAdopted: [...new Set(projects.flatMap((p) => p.tech))],
    authenticity: { score: forensics?.score ?? null, manifestHash: manifestHash || null, note: "screen, not proof" },
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
  if (p.summary) L.push(`\n${p.summary}`);

  L.push(`\n## Representative projects`);
  for (const pr of p.projects) {
    const headTail = pr.repoLabel ? ` _(${pr.id} — ${pr.repoLabel})_` : ` _(${pr.id})_`;
    L.push(`\n### ${pr.domain || "(domain)"}  ·  ${pr.type.join(" · ")}${headTail}`);
    L.push(`${pr.span.from}→${pr.span.to} · ${pr.sessions} sessions · ${land(pr.landing)}`);
    if (pr.tech.length) L.push(`stack: ${pr.tech.join(", ")}`);
    if (pr.did) L.push(pr.did);
    if (pr.whyRepresentative) L.push(`_why representative:_ ${pr.whyRepresentative}`);
    L.push(`artifact: ${pr.artifact ? pr.artifact.label : "— (none attached)"}`);
  }

  if (p.otherProjects.length) {
    L.push(`\n## Other projects (inventory)`);
    for (const o of p.otherProjects) {
      const tag = o.repoLabel ? ` _(${o.repoLabel})_` : "";
      L.push(`- ${o.type.join(" · ")} · ${o.span.from}→${o.span.to} · ${o.sessions} sess${tag}`);
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
    L.push(`- Active days: ${i.activeDays} / ${i.observedDays} (${Math.round(i.activeDaysRatio * 100)}%)`);
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
  }

  return L.join("\n") + "\n";
}

function formatVal(v, fmt) {
  if (v == null) return "n/a";
  if (fmt === "percent") return `${Math.round(v * 100)}%`;
  if (fmt === "ratio") return typeof v === "number" ? v.toFixed(2) : String(v);
  return String(v);
}

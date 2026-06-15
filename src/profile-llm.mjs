// Narrative step. Turns the deep digest + local enrichment into the qualitative
// prose fields (summary, per-project domain/did, cognitive profile, learning).
// Deterministic facts stay in the structured profile; this only writes what
// resists structuring.
//
// Anonymization happens HERE: the system prompt forbids proper names and the
// projects are keyed by opaque id (p1, p2…), never by repo name. So enrichment
// (which is full of real names) goes in, context-only prose comes out.

import { readFileSync } from "node:fs";

const MODEL = "claude-opus-4-7";

const SYSTEM = `You write a candidate's work profile from the logs of their activity with AI development tools.

HARD RULES:
- NO proper names: no companies, clients, people, products, brands, or repositories. Describe each project ONLY by abstract domain and context (e.g. "talent and campaigns management platform", not the actual product name).
- Use only the data provided. No invention, no empty praise, no hyperbolic adjectives.
- Concrete and evidence-based: every claim must rest on signals in the digest (areas touched, stack, landing signals, prompts, commits).
- English, dry, readable by a human. No emojis, no em dashes.

You receive a JSON with the selected projects (opaque ids p1, p2, ...), each with: type, span, volumes, code areas, stack, landing signals (commits/reverts/checks), web-search topics, sampled prompts, and LOCAL repo context (description, docs, dependencies, commit subjects).

You also receive a TRAJECTORY block (what changed over the window) with: behavioral shifts (numbers, early vs late half), topic clusters from web research, new vocabulary adopted late, principles the candidate added to their own CLAUDE.md / README diffs, and compaction summaries the model wrote about earlier sessions.

For the trajectory narrative, focus on STRATEGIC AND CULTURAL change, NOT on stack adopted (the stack is rendered separately). Think: how their way of working evolved, what they came to value, the mental models they took on. Cite the numbers when they back a claim. Stay evidence-based.

You may also receive a PRACTICE_INTENSITY block with active-days ratio, median sessions per active day, median session depth, longest streak, peak day, and pre-classified cadence/sessionShape strings. Write 1-2 sentences in intensity.narrative describing how deeply Claude is embedded in the candidate's workflow (e.g. "daily driver with frequent multi-day streaks", "occasional, short bursts on specific tasks"). Evidence-based, no labels.

You may also receive a WORK_DISTRIBUTION block: products, sessions, mean/median sessions per product, top-3 concentration share, multi-month product share, and a pre-classified shape (portfolio / balanced / deep focus). Write 1-2 sentences in distribution.narrative on how this person spreads their work: many products each touched briefly (portfolio steering, direction across fronts) vs few products returned to repeatedly (sustained building, continuity). Say what this implies about how they engage. Neither pole is better; no judgement. The summary should also reflect this breadth-vs-depth shape in one clause.

You may also receive a DOMAIN_EVIDENCE array covering ALL products (not just the selected ones), each with: type tags, sessions, span, stack, code areas, web-search topics. From it, derive 3-5 aggregate DOMAINS — the fields of work this person operates in (e.g. "talent and creator operations", "business intelligence and finance ops", "agentic platforms and tooling", "nonprofit / civic"). For each domain output: label (abstract, NO proper names), products (how many products fall in it), sessions (their summed sessions), note (optional, 1 short clause of evidence). Every product should be assigned to exactly one domain; products + sessions across domains must not exceed the totals. The summary must say WHAT this person works on (the top domains) as well as how they work.

You may also receive an AGENTIC_LITERACY block with three groups of counts:
  - uses: sub-agent delegations, task-tracking events, slash commands (built-in vs custom), MCP servers (public vs custom).
  - builds: skills / commands / agents / hooks authored, CLAUDE.md files maintained.
  - designs: ExitPlanMode, TodoWrite, AskUserQuestion invocations.
Write 2-3 sentences in agentic_literacy.narrative describing how mature this person is in the agentic stack. Mention concretely what they do (e.g. "has authored custom commands"; "integrates a custom MCP server"; "orchestrates extensively via sub-agents"; "tracks-while-running rather than plans-first"). **NEVER name any custom skill, custom command, custom MCP server, project, client, or company** — only describe in the abstract. Evidence-based, no labels.

You also receive an AI_RELATIONSHIP block with a numeric split on a single continuous axis with two poles:
  - directing: treats the model like a careful junior, with long structured prompts, file paths, numbered steps, acceptance criteria.
  - co-thinking: thinks out loud with the model, short conversational turns, open questions, lets the model push back.
The midpoint of the axis is co-construction (using the model to define the problem, not just execute it). And a few example prompts for each pole. Write 2-3 sentences in ai_relationship.narrative about WHEN they pick one mode vs the other (e.g. "structured spec on data and security work; conversational on UI exploration"). Stay evidence-based, no labels, no judgement.

The trajectory block also carries a vocabularyCandidates array: raw words that show up only in the late half of the window and recur across distinct prompts. Many of these are common chat words (verbs, adverbs). Pick the 6–10 that are clearly technical / domain-specific / concept names (e.g. business or technical jargon, framework or product names, methodology terms) and put them in trajectory.vocabulary_adopted. SKIP common verbs, adverbs, filler words.

Reply ONLY with a valid JSON in this shape:
{
  "summary": "2-3 sentences: what this person works on (top domains) and how they work with AI",
  "domains": [ { "label": "abstract field of work, no proper names", "products": 0, "sessions": 0, "note": "1 short clause of evidence (optional)" } ],
  "cognitive": { "narrative": "4-6 sentences on the cognitive profile: decomposition, verification, error handling, orchestration, risk, calibrated trust in AI" },
  "ai_relationship": { "narrative": "2-3 sentences on when they pick directing vs co-thinking mode" },
  "agentic_literacy": { "narrative": "2-3 sentences on agentic-stack maturity. No proper names." },
  "intensity": { "narrative": "1-2 sentences on how deeply Claude is embedded in their daily workflow." },
  "distribution": { "narrative": "1-2 sentences on how they spread work across products: breadth vs depth, and what it implies about how they engage." },
  "trajectory": {
    "narrative": "3-5 sentences on strategic/cultural shift over the window. Cite the data. NO stack names here.",
    "vocabulary_adopted": ["6-10 technical/domain words picked from vocabularyCandidates"],
    "principles_adopted": [
      { "when": "YYYY-MM (optional)", "text": "a principle the candidate codified" }
    ]
  },
  "projects": [ { "id": "p1", "domain": "abstract domain", "did": "2-3 sentences on what they did", "why_representative": "1 sentence" } ]
}`;

// Scrub probable proper nouns from the prompt samples we hand to the model
// as evidence. The LLM has a hard anti-naming rule but we don't rely on
// soft constraints alone: replace capitalised tokens (not at sentence start)
// with a generic marker. False positives are acceptable, false negatives are
// the leak risk.
function scrubProperNouns(text) {
  if (!text) return text;
  return text
    .replace(/(?<!^|[.!?]\s|\n)\b([A-ZÀ-Ý][a-zà-ÿ]{2,})(?!\.\w)/g, "⟨name⟩");
}
function scrubExamples(examples) {
  if (!examples) return examples;
  return {
    directing: (examples.directing ?? []).map(scrubProperNouns),
    coThinking: (examples.coThinking ?? []).map(scrubProperNouns),
  };
}

function narrativeInput(selected, enrichments, trajectory, compactionSummaries, aiRelationship, agenticLiteracy, intensity, distribution, allProjects) {
  return {
    // Compact per-product evidence across ALL products (not just the selected
    // ones) so the model can derive the aggregate domains. Local-only input;
    // the output side carries abstract labels and counts, never names.
    domainEvidence: (allProjects ?? []).map((p) => ({
      type: p.type,
      sessions: p.sessions,
      span: `${p.from ?? "n/a"}->${p.to ?? "n/a"}`,
      tech: p.tech ?? [],
      areas: Object.keys(p.topAreas ?? {}).slice(0, 6),
      topics: (p.learningTopics ?? []).slice(0, 6),
    })),
    projects: selected.map((p, i) => {
      const e = enrichments[i] || {};
      return {
        id: `p${i + 1}`,
        repoLabel: p.repo || null,
        type: p.type,
        span: `${p.from ?? "n/a"}->${p.to ?? "n/a"}`,
        sessions: p.sessions,
        topAreas: Object.keys(p.topAreas).slice(0, 10),
        tech: p.tech,
        landing: p.landing,
        orchestration: p.orchestration ?? null,
        learningTopics: p.learningTopics,
        promptSamples: p.promptSamples,
        repoDescription: e.pkgDescription || null,
        repoDoc: e.doc ? e.doc.slice(0, 1200) : null,
        deps: e.deps || [],
        commits: e.commits || [],
      };
    }),
    trajectory: trajectory
      ? {
          shifts: trajectory.shifts?.available
            ? {
                midpoint: trajectory.shifts.midpoint,
                early: trajectory.shifts.early,
                late: trajectory.shifts.late,
                deltas: trajectory.shifts.deltas,
              }
            : null,
          topicsByQuarter: trajectory.topics,
          vocabularyCandidates: trajectory.vocabularyCandidates,
        }
      : null,
    // Lines added to CLAUDE.md/README over time across the selected projects
    // — candidate's own doctrine for their future self and their agent.
    principlesDiff: enrichments
      .flatMap((e) => (e.principlesDiff || []).map((p) => ({ ...p, repo: e.pkgName || null })))
      .slice(-30),
    // Dense self-portraits of how earlier work went, written by the model
    // inside Claude Code as compaction summaries.
    compactionSummaries: (compactionSummaries || []).slice(-6),
    aiRelationship: aiRelationship
      ? {
          mode: aiRelationship.mode,
          directing: aiRelationship.directing,
          coThinking: aiRelationship.coThinking,
          sampledPrompts: aiRelationship.sampledPrompts,
          examples: scrubExamples(aiRelationship.examples),
        }
      : null,
    agenticLiteracy: agenticLiteracy || null,
    intensity: intensity || null,
    distribution: distribution || null,
  };
}

async function callAnthropic(input, key) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 3000,
      system: SYSTEM,
      messages: [{ role: "user", content: JSON.stringify(input) }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.content?.find((b) => b.type === "text")?.text || "";
  return JSON.parse(text.replace(/^```json\s*|\s*```$/g, "").trim());
}

// Light validation of the narrative shape. We don't want a malformed model
// reply to silently sail into the profile — that's the worst kind of bug.
// Throws with a precise pointer to the bad field. Tolerates extra keys.
export function validateNarrative(n, ctx) {
  const where = (p) => `narrative${ctx ? ` (${ctx})` : ""}: ${p}`;
  const str = (v) => typeof v === "string" && v.trim().length > 0;
  if (!n || typeof n !== "object") throw new Error(where("not an object"));
  if (!str(n.summary)) throw new Error(where("missing summary"));
  if (!n.cognitive || typeof n.cognitive !== "object") throw new Error(where("missing cognitive"));
  if (!str(n.cognitive.narrative)) throw new Error(where("missing cognitive.narrative"));
  // domains is optional in older shapes; if present, it must be well-formed.
  if (n.domains != null) {
    if (!Array.isArray(n.domains)) throw new Error(where("domains not an array"));
    for (const [i, d] of n.domains.entries()) {
      if (!d || typeof d !== "object") throw new Error(where(`domains[${i}] not an object`));
      if (!str(d.label)) throw new Error(where(`domains[${i}].label missing`));
      if (!Number.isFinite(Number(d.products)) || Number(d.products) < 1) throw new Error(where(`domains[${i}].products must be a count >= 1`));
      if (!Number.isFinite(Number(d.sessions)) || Number(d.sessions) < 1) throw new Error(where(`domains[${i}].sessions must be a count >= 1`));
    }
  }
  // trajectory is optional in older shapes; if present, it must be well-formed.
  if (n.trajectory != null) {
    if (typeof n.trajectory !== "object") throw new Error(where("trajectory not an object"));
    if (n.trajectory.narrative != null && !str(n.trajectory.narrative)) throw new Error(where("trajectory.narrative empty"));
    if (n.trajectory.principles_adopted != null && !Array.isArray(n.trajectory.principles_adopted)) {
      throw new Error(where("trajectory.principles_adopted not an array"));
    }
  }
  if (!Array.isArray(n.projects)) throw new Error(where("projects not an array"));
  for (const [i, p] of n.projects.entries()) {
    if (!p || typeof p !== "object") throw new Error(where(`projects[${i}] not an object`));
    if (!str(p.id)) throw new Error(where(`projects[${i}].id missing`));
    if (!str(p.domain)) throw new Error(where(`projects[${i}].domain missing`));
    if (!str(p.did)) throw new Error(where(`projects[${i}].did missing`));
  }
  return n;
}

// Returns { narrative, input }. narrative is null if no key and no override.
// An explicit --narrative-file always wins over the env key: the API path
// sends the narrative input off-machine, so it must never engage silently
// or discard a hand-curated narrative just because a key is in the env.
export async function generateNarrative(selected, enrichments, { overrideFile, trajectory, compactionSummaries, aiRelationship, agenticLiteracy, intensity, distribution, allProjects } = {}) {
  const input = narrativeInput(selected, enrichments, trajectory, compactionSummaries, aiRelationship, agenticLiteracy, intensity, distribution, allProjects);
  if (overrideFile) return { narrative: validateNarrative(JSON.parse(readFileSync(overrideFile, "utf8")), overrideFile), input };
  const key = process.env.ANTHROPIC_API_KEY;
  if (key) {
    console.error(
      "[apply-new] ANTHROPIC_API_KEY is set: the narrative input (project labels, README/CLAUDE.md excerpts,\n" +
        "            dependency names, commit subjects, sampled prompts) is being sent to api.anthropic.com.\n" +
        "            To stay fully local until submit, unset the key and use the /apply-new slash command\n" +
        "            (subscription path) or `prepare` + a hand-written narrative file. See PRIVACY.md."
    );
    return { narrative: validateNarrative(await callAnthropic(input, key), "API"), input };
  }
  return { narrative: null, input };
}

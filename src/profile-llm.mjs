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

Reply ONLY with a valid JSON in this shape:
{
  "summary": "2-3 sentences: how this person works with AI",
  "cognitive": { "narrative": "4-6 sentences on the cognitive profile: decomposition, verification, error handling, orchestration, risk, calibrated trust in AI" },
  "trajectory": {
    "narrative": "3-5 sentences on strategic/cultural shift over the window. Cite the data. NO stack names here.",
    "principles_adopted": [
      { "when": "YYYY-MM (optional)", "text": "a principle the candidate codified" }
    ]
  },
  "projects": [ { "id": "p1", "domain": "abstract domain", "did": "2-3 sentences on what they did", "why_representative": "1 sentence" } ]
}`;

function narrativeInput(selected, enrichments, trajectory, compactionSummaries) {
  return {
    projects: selected.map((p, i) => {
      const e = enrichments[i] || {};
      return {
        id: `p${i + 1}`,
        type: p.type,
        span: `${p.from}->${p.to}`,
        sessions: p.sessions,
        topAreas: Object.keys(p.topAreas).slice(0, 10),
        tech: p.tech,
        landing: p.landing,
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
          newVocabulary: trajectory.newVocabulary,
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

// Returns { narrative, input }. narrative is null if no key and no override.
export async function generateNarrative(selected, enrichments, { overrideFile, trajectory, compactionSummaries } = {}) {
  const input = narrativeInput(selected, enrichments, trajectory, compactionSummaries);
  const key = process.env.ANTHROPIC_API_KEY;
  if (key) return { narrative: await callAnthropic(input, key), input };
  if (overrideFile) return { narrative: JSON.parse(readFileSync(overrideFile, "utf8")), input };
  return { narrative: null, input };
}

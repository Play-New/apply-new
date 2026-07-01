// Pre-submit groundedness check.
//
// The profile mixes deterministic fields (numbers, tags, stack) with prose
// fields written by the LLM (summary, cognitive narrative, trajectory
// narrative, did, why_representative, domain, principles_adopted). The risk
// is that the prose drifts from the data — claims numbers that aren't in the
// logs, name a technology nobody touched, invent a behaviour.
//
// We don't try to be a fact-checker. We extract verifiable ANCHORS from the
// prose (numbers, technology names, type tags, year-months) and check that
// each anchor exists somewhere in the structured data the prose was generated
// from. The score is the percentage of anchors supported.
//
// Designed to be transparent: every flagged anchor is shown to the candidate
// before submission so they can re-generate or edit if something is off.

import { labelVocabulary } from "./digest.mjs";

// Stack tokens AND AI-tooling vocabulary. A narrative that says "Claude" or
// "SDK" or "MCP" is referring to general AI/dev primitives that are part of
// the trajectory even when not listed in a project's `tech` array. We treat
// these as inherently grounded — the candidate is using them right now to
// generate this profile.
const TECH_NAMES = [
  // Web / framework stack
  "Supabase","Postgres","Inngest","Playwright","Tailwind","shadcn","Zod","Prisma","Next.js","React",
  "Stripe","Drizzle","Brevo","Resend","Vercel","TypeScript","Python","Node","Vitest","Jest","ESLint",
];

// The lexicon the prose is checked against = the hardcoded names ABOVE plus
// every label the detector can emit (src/digest.mjs labelVocabulary()),
// tokenised exactly as the support pool is (splitTech), so a token a narrative
// cites matches a token the pool carries. Deriving it from the same maps means
// detection and verification can never drift apart. A stoplist drops the generic
// English words that leak from descriptive labels ("event-driven jobs",
// "analytics") so they don't become spurious tech anchors.
const LEXICON_STOP = new Set([
  "event-driven", "jobs", "rich", "text", "analytics", "email", "headless",
  "cms", "pdf", "monorepo", "google", "motion", "hook", "form", "shell",
]);
const TECH_LEXICON = [...new Set([...TECH_NAMES, ...labelVocabulary()].flatMap(splitTech))]
  .filter((t) => t.length >= 3 && !LEXICON_STOP.has(t));

// AI-tooling vocabulary — always considered grounded, since the candidate is
// (by definition) using these tools to participate in Apply New.
const AI_TOOLING = new Set([
  "claude","claude code","claude.ai","anthropic","openai","gpt","gemini","codex",
  "sdk","api","mcp","agent","agents","subagent","sub-agent","skill","skills",
  "llm","llms","prompt","tool use","tool-use","reasoning","thinking","context window",
]);

const TYPE_TAGS = [
  "product-build","audit-research","agent-tooling","static-site","ai-platform",
  "data-migration","feature-work","testing","quality-gating","orchestrated","design-research","exploration",
];

const COGNITIVE_TAGS = [
  "research-first","decomposer","orchestrator","verification-heavy","risk-calibrated",
];

// Extract candidate ANCHORS from a chunk of prose.
function extractAnchors(text) {
  if (!text || typeof text !== "string") return [];
  const anchors = [];

  // Numbers that look meaningful (>1 digit OR followed by a unit/word).
  for (const m of text.matchAll(/\b\d{1,5}(?:[.,]\d+)?\b/g)) {
    const n = Number(m[0].replace(",", "."));
    if (Number.isFinite(n) && n >= 2) anchors.push({ kind: "number", value: n, raw: m[0] });
  }

  // Percentages.
  for (const m of text.matchAll(/(\d{1,3})\s*%/g)) {
    anchors.push({ kind: "percent", value: Number(m[1]) / 100, raw: m[0] });
  }

  // Year-months (2026-03, 2026-Q1).
  for (const m of text.matchAll(/\b20\d{2}-(?:Q[1-4]|0?[1-9]|1[0-2])\b/g)) {
    anchors.push({ kind: "period", value: m[0], raw: m[0] });
  }

  // Technology names — case-insensitive but anchored on word boundary.
  // AI-tooling words are pre-grounded (a candidate using Apply New is using
  // Claude / an SDK / an MCP server / agents by definition).
  for (const t of TECH_LEXICON) {
    const re = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(text)) anchors.push({ kind: "tech", value: t.toLowerCase(), raw: t });
  }
  for (const t of AI_TOOLING) {
    const re = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(text)) anchors.push({ kind: "ai-tooling", value: t, raw: t });
  }

  // Type tags & cognitive tags, only if they appear in prose form.
  for (const t of [...TYPE_TAGS, ...COGNITIVE_TAGS]) {
    if (text.toLowerCase().includes(t)) anchors.push({ kind: "tag", value: t, raw: t });
  }

  return anchors;
}

function collectSupportPool(profile) {
  const numbers = new Set();
  // Percent anchors get their own pool. The number pool is full of COUNTS,
  // and a count collides with a percent exactly at the fractions' edges: a 1
  // anywhere (one delegation, median 1 session/day) equals the "100%" anchor
  // value 1.0, a 0 equals "0%" — so any such profile silently grounded any
  // fabricated percentage. Only share/rate-typed fields (activeDaysRatio,
  // top3Share, multiMonthShare, percent-format trajectory shifts) may support
  // a percent claim.
  const ratios = new Set();
  const periods = new Set();
  const tech = new Set();
  const tags = new Set();

  const addNumber = (n) => {
    if (n == null) return;
    const v = Number(n);
    if (Number.isFinite(v)) numbers.add(v);
  };
  const addRatio = (n) => {
    if (n == null) return;
    const v = Number(n);
    if (Number.isFinite(v)) ratios.add(v);
  };
  const addText = (s) => {
    if (!s) return;
    for (const m of String(s).match(/\b20\d{2}-(?:Q[1-4]|0?[1-9]|1[0-2])\b/g) ?? []) periods.add(m);
  };

  // Top-level volume + window + authenticity
  addNumber(profile?.volume?.sessions);
  addNumber(profile?.volume?.products);
  addNumber(profile?.volume?.instructions);
  addNumber(profile?.authenticity?.score);
  // Per-source capture counts are citable ("941 sessions read from …")
  for (const s of profile?.sources ?? []) addNumber(s.sessions);
  addText(profile?.window?.from);
  addText(profile?.window?.to);

  // Per project structured facts
  for (const p of profile?.projects ?? []) {
    addNumber(p.sessions);
    addNumber(p?.landing?.commits);
    addNumber(p?.landing?.reverts);
    addNumber(p?.metrics?.researchToMutation);
    addNumber(p?.metrics?.delegation);
    // Orchestration counts a narrative may cite ("N dispatches across M CLIs").
    // Only values >= 2 pool: number anchors start at 2, so 0/1 buy nothing.
    // (Percent anchors no longer read this pool at all — see the ratios set —
    // so this gate is hygiene: counts that nothing can cite stay out.)
    const addCount = (n) => { if (Number(n) >= 2) addNumber(n); };
    addCount(p?.metrics?.orchestration?.dispatchCommands);
    addCount(p?.metrics?.orchestration?.toolCount);
    // The narrative is fed the per-CLI session split (orchestration.tools, e.g.
    // {"claude-code": 38, opencode: 12}); pool those counts too, so once a
    // second source lands a narrative citing "38 via Claude, 12 via opencode" is
    // grounded, not flagged. (Single-source: tools is {claude-code: p.sessions},
    // already pooled via p.sessions above — so this is inert until a 2nd source.)
    for (const v of Object.values(p?.metrics?.orchestration?.tools ?? {})) addCount(v);
    addText(p?.span?.from);
    addText(p?.span?.to);
    for (const t of p.tech ?? []) for (const w of splitTech(t)) tech.add(w);
    for (const t of p.type ?? []) tags.add(t);
  }
  for (const o of profile?.otherProjects ?? []) {
    addNumber(o.sessions);
    addText(o?.span?.from);
    addText(o?.span?.to);
    for (const t of o.type ?? []) tags.add(t);
  }

  for (const t of profile?.stackAdopted ?? []) for (const w of splitTech(t)) tech.add(w);
  for (const t of profile?.cognitive?.tags ?? []) tags.add(t);

  // Domains rollup counts (sum-checked separately in assessGroundedness; once
  // they pass that check the prose may cite them)
  for (const d of profile?.domains ?? []) {
    addNumber(d.products);
    addNumber(d.sessions);
  }

  // Practice-intensity numbers (the narrative may quote any of them, raw or
  // as %: the fraction feeds the ratios pool, the rounded percent stays a
  // citable number — "87%" extracts both a percent anchor 0.87 and a number
  // anchor 87)
  const it = profile?.intensity;
  if (it) {
    addNumber(it.observedDays);
    addNumber(it.activeDays);
    addNumber(it.longestStreak);
    addNumber(it.medianSessionsPerActiveDay);
    addNumber(it.medianSessionToolCalls);
    addNumber(it.peakDayToolCalls);
    addRatio(it.activeDaysRatio);
    if (it.activeDaysRatio != null) addNumber(Math.round(it.activeDaysRatio * 100));
  }

  // Work distribution numbers (same fraction/rounded-percent split)
  const dist = profile?.distribution;
  if (dist) {
    addNumber(dist.meanSessionsPerProduct);
    addNumber(dist.medianSessionsPerProduct);
    addNumber(dist.multiMonthProducts);
    addRatio(dist.top3Share);
    addNumber(Math.round(dist.top3Share * 100));
    addRatio(dist.multiMonthShare);
    addNumber(Math.round(dist.multiMonthShare * 100));
  }

  // Trajectory numbers. Percent-format shifts (delegation rate, verification
  // rate) hold fractions the prose cites as percents; number/ratio-format
  // shifts (prompt words, research:mutation) are cited as plain numbers.
  const s = profile?.trajectory?.shifts;
  if (s?.deltas) for (const d of s.deltas) {
    if (d.format === "percent") {
      addRatio(d.early);
      addRatio(d.late);
      if (d.early != null) addNumber(Math.round(d.early * 100));
      if (d.late != null) addNumber(Math.round(d.late * 100));
    } else {
      addNumber(d.early);
      addNumber(d.late);
    }
  }
  if (s?.midpoint) addText(s.midpoint);
  for (const q of profile?.trajectory?.topics ?? []) { addText(q.quarter); for (const th of q.themes ?? []) addNumber(th.count); }
  for (const pr of profile?.trajectory?.principlesAdopted ?? []) addText(pr.when);

  return { numbers, ratios, periods, tech, tags };
}

// "Supabase/Postgres" or "Playwright (E2E)" should make both "supabase",
// "postgres", "playwright" individually grounded.
function splitTech(label) {
  return String(label)
    .toLowerCase()
    .split(/[\s/(),]+/)
    .map((s) => s.replace(/[^a-z.+-]/g, ""))
    .filter((s) => s.length >= 3);
}

// Numbers in prose match if they equal a structured number or are within 5%
// of one (the LLM may round "153 commits" as "around 150").
function numberMatches(n, numberSet) {
  if (numberSet.has(n)) return true;
  for (const v of numberSet) {
    if (v === 0 || n === 0) continue;
    if (Math.abs((n - v) / v) <= 0.05) return true;
  }
  return false;
}

function classifyTextFields(profile) {
  // Returns a list of { where, text } prose fields to verify.
  const fields = [];
  if (profile?.summary) fields.push({ where: "summary", text: profile.summary });
  if (profile?.cognitive?.narrative) fields.push({ where: "cognitive.narrative", text: profile.cognitive.narrative });
  if (profile?.trajectory?.narrative) fields.push({ where: "trajectory.narrative", text: profile.trajectory.narrative });
  if (profile?.distribution?.narrative) fields.push({ where: "distribution.narrative", text: profile.distribution.narrative });
  if (profile?.intensity?.narrative) fields.push({ where: "intensity.narrative", text: profile.intensity.narrative });
  for (const [i, d] of (profile?.domains ?? []).entries()) {
    if (d?.note) fields.push({ where: `domains[${i}].note`, text: d.note });
  }
  for (const p of profile?.projects ?? []) {
    if (p.domain) fields.push({ where: `${p.id}.domain`, text: p.domain });
    if (p.did) fields.push({ where: `${p.id}.did`, text: p.did });
    if (p.whyRepresentative) fields.push({ where: `${p.id}.whyRepresentative`, text: p.whyRepresentative });
  }
  for (const pr of profile?.trajectory?.principlesAdopted ?? []) {
    if (pr?.text) fields.push({ where: "trajectory.principles", text: pr.text });
  }
  return fields;
}

export function assessGroundedness(profile) {
  const pool = collectSupportPool(profile);
  const fields = classifyTextFields(profile);

  let total = 0;
  let supported = 0;
  const anomalies = [];

  for (const f of fields) {
    const anchors = extractAnchors(f.text);
    for (const a of anchors) {
      total++;
      let ok = false;
      if (a.kind === "number") ok = numberMatches(a.value, pool.numbers);
      else if (a.kind === "percent") ok = numberMatches(a.value, pool.ratios);
      else if (a.kind === "period") ok = pool.periods.has(a.value);
      else if (a.kind === "tech") ok = pool.tech.has(a.value);
      else if (a.kind === "tag") ok = pool.tags.has(a.value);
      else if (a.kind === "ai-tooling") ok = true; // pre-grounded by definition
      if (ok) supported++;
      else anomalies.push({ where: f.where, anchor: a.raw, kind: a.kind });
    }
  }

  // Domains rollup: per-domain products/sessions are LLM claims. The sums must
  // not exceed the deterministic totals — an excess is an invented count.
  const domains = profile?.domains ?? [];
  if (domains.length) {
    const sumProducts = domains.reduce((n, d) => n + (Number(d.products) || 0), 0);
    const sumSessions = domains.reduce((n, d) => n + (Number(d.sessions) || 0), 0);
    total += 2;
    if (sumProducts <= (profile?.volume?.products ?? 0)) supported++;
    else anomalies.push({ where: "domains", anchor: `${sumProducts} products across domains`, kind: "number" });
    if (sumSessions <= (profile?.volume?.sessions ?? 0)) supported++;
    else anomalies.push({ where: "domains", anchor: `${sumSessions} sessions across domains`, kind: "number" });
  }

  // Soft floor: a profile with very few anchors should not be 0% just because
  // there's nothing to check. If we found < 4 anchors total, score is "n/a".
  const score = total >= 4 ? Math.round((supported / total) * 100) : null;
  return {
    score,
    supported,
    total,
    anomalies: anomalies.slice(0, 12), // cap the surfaced ones
  };
}

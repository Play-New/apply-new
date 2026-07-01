import { test } from "node:test";
import assert from "node:assert/strict";
import { assessGroundedness } from "../src/groundedness.mjs";
import { baseProfile } from "./factories.mjs";

test("prose anchored by numbers + tech + tags in the data scores 100%", () => {
  const p = baseProfile();
  p.summary = "Across 236 sessions on 30 products, the work blends product-build with research-first verification, on Inngest and Supabase.";
  p.projects[0].did = "153 commits, 0 reverts. Worked on Supabase/Postgres and Playwright.";
  const g = assessGroundedness(p);
  assert.equal(g.score, 100, `expected 100, got ${g.score} (anomalies: ${JSON.stringify(g.anomalies)})`);
  assert.equal(g.anomalies.length, 0);
});

test("unsupported numbers flag the field that contains them", () => {
  const p = baseProfile();
  p.summary = "Delivered 999 commits across the window.";
  const g = assessGroundedness(p);
  assert.ok(g.score < 100);
  assert.ok(g.anomalies.some((a) => a.where === "summary" && a.kind === "number"));
});

test("AI-tooling vocabulary is pre-grounded (Claude, SDK, MCP, agents)", () => {
  const p = baseProfile();
  p.cognitive.narrative = "Uses Claude as the main daily tool, delegates to sub-agents via the SDK and an MCP server.";
  const g = assessGroundedness(p);
  // Every anchor here is AI tooling — should not produce anomalies.
  for (const a of g.anomalies) assert.notEqual(a.kind, "ai-tooling");
});

test("non-existent technology in the prose is flagged", () => {
  const p = baseProfile();
  p.cognitive.narrative = "Built everything on Drizzle and Stripe.";
  const g = assessGroundedness(p);
  assert.ok(g.anomalies.some((a) => a.where === "cognitive.narrative" && a.kind === "tech"));
});

test("rounding tolerance: a 5% rounded number still matches", () => {
  const p = baseProfile();
  p.summary = "About 150 commits over the period."; // actual is 153 (1.96% off)
  const g = assessGroundedness(p);
  assert.equal(g.anomalies.find((a) => a.kind === "number"), undefined);
});

test("score is null when there are too few anchors to judge", () => {
  const p = baseProfile();
  // No prose fields populated — nothing to verify.
  const g = assessGroundedness(p);
  assert.equal(g.score, null);
});

test("a detector-vocabulary technology (Firebase) is verified, not invisible", () => {
  // Firebase is NOT in the hardcoded TECH_NAMES — it comes from the detector's
  // label vocabulary. Before the lexicon was shared, citing it was neither
  // supported nor flagged. Now: flagged when absent, supported when in the stack.
  const absent = baseProfile();
  absent.cognitive.narrative = "The data layer runs on Firebase.";
  assert.ok(assessGroundedness(absent).anomalies.some((a) => a.where === "cognitive.narrative" && a.kind === "tech"),
    "Firebase absent from the stack should be flagged");

  const present = baseProfile();
  present.projects[0].tech = [...present.projects[0].tech, "Firebase/Firestore"];
  present.stackAdopted = [...present.stackAdopted, "Firebase/Firestore"];
  present.cognitive.narrative = "The data layer runs on Firebase.";
  assert.ok(!assessGroundedness(present).anomalies.some((a) => a.where === "cognitive.narrative" && a.kind === "tech"),
    "Firebase in the stack should be supported, not flagged");
});

// Review follow-up on #5: orchestration counts pool into the single GLOBAL
// support set. A toolCount of 1 — present on every single-source profile —
// would pin the number 1 in the pool, and a "100%" percent anchor (value 1.0)
// matches it: every profile would silently ground any fabricated "100%".
// Counts of 0/1 are not citable as counts (number anchors start at 2), so
// they must not be pooled at all.
test("orchestration counts of 0/1 are not pooled (toolCount 1 must not ground '100%')", () => {
  const p = baseProfile();
  p.projects[0].metrics = {
    researchToMutation: null,
    delegation: 0,
    orchestration: { delegation: 0, tools: { "claude-code": 59 }, toolCount: 1, toolOverlap: null, dispatchCommands: 0 },
  };
  p.summary = "Landed 100% of migrations without incident across 236 sessions.";
  const g = assessGroundedness(p);
  assert.ok(
    g.anomalies.some((a) => a.where === "summary" && a.anchor === "100%"),
    `the fabricated "100%" must be flagged: ${JSON.stringify(g.anomalies)}`,
  );
});

// --- typed pool: counts must never support percent anchors ---------------------
// The support pool used to be one flat number set, so a COUNT of 1 anywhere in
// the data (one delegation, median 1 session per active day) matched the "100%"
// percent anchor (value 1.0), and a count of 0 matched "0%": every such profile
// silently grounded any fabricated percentage. Percent anchors now check a
// separate ratios pool that only share/rate-typed fields feed.

test("a count of 1 in the data does not ground a fabricated '100%'", () => {
  const p = baseProfile();
  p.projects[0].metrics = { researchToMutation: null, delegation: 1, orchestration: null };
  p.summary = "Landed 100% of migrations without incident across 236 sessions.";
  const g = assessGroundedness(p);
  assert.ok(
    g.anomalies.some((a) => a.where === "summary" && a.anchor === "100%"),
    `delegation: 1 must not support "100%": ${JSON.stringify(g.anomalies)}`,
  );
});

test("an intensity median of 1 does not ground a fabricated '100%'", () => {
  const p = baseProfile();
  p.intensity = {
    observedDays: 30, activeDays: 12, activeDaysRatio: 0.4, longestStreak: 3,
    medianSessionsPerActiveDay: 1, medianSessionToolCalls: 25, peakDayToolCalls: 90,
  };
  p.summary = "Shipped 100% of the planned migrations across 236 sessions.";
  const g = assessGroundedness(p);
  assert.ok(
    g.anomalies.some((a) => a.where === "summary" && a.anchor === "100%"),
    `medianSessionsPerActiveDay: 1 must not support "100%": ${JSON.stringify(g.anomalies)}`,
  );
});

test("honest share citations still ground: activeDaysRatio and a full top3Share", () => {
  const p = baseProfile();
  p.intensity = {
    observedDays: 100, activeDays: 87, activeDaysRatio: 0.87, longestStreak: 9,
    medianSessionsPerActiveDay: 3, medianSessionToolCalls: 40, peakDayToolCalls: 200,
  };
  p.intensity.narrative = "Active on 87% of observed days.";
  p.distribution = {
    products: 3, sessions: 236, meanSessionsPerProduct: 79, medianSessionsPerProduct: 80,
    top3Share: 1.0, multiMonthProducts: 2, multiMonthShare: 0.67, shape: "deep focus",
  };
  p.distribution.narrative = "The top 3 products account for 100% of all sessions.";
  const g = assessGroundedness(p);
  const pct = g.anomalies.filter((a) => a.kind === "percent");
  assert.deepEqual(pct, [], `87% and the genuine 100% must stay grounded: ${JSON.stringify(g.anomalies)}`);
});

test("percent-format trajectory shifts ground their percent citations", () => {
  const p = baseProfile();
  p.trajectory = {
    shifts: { deltas: [{ metric: "delegation rate", format: "percent", early: 0.12, late: 0.3, dir: "up" }] },
    narrative: "Delegation rate moved from 12% to 30% across the window.",
  };
  const g = assessGroundedness(p);
  const pct = g.anomalies.filter((a) => a.kind === "percent");
  assert.deepEqual(pct, [], `12% and 30% come straight from the shift deltas: ${JSON.stringify(g.anomalies)}`);
});

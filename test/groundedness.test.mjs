import { test } from "node:test";
import assert from "node:assert/strict";
import { assessGroundedness } from "../src/groundedness.mjs";

const baseProfile = () => ({
  schema: "playnew-profile/v1",
  contact: { name: "X", email: "x@y.io", city: "Milano", status: "employed" },
  window: { from: "2026-01", to: "2026-05" },
  volume: { products: 30, sessions: 236, instructions: 3800 },
  summary: null,
  cognitive: { tags: ["research-first"], narrative: null },
  projects: [
    {
      id: "p1",
      type: ["product-build"],
      domain: "Creator intelligence platform.",
      span: { from: "2026-02", to: "2026-05" },
      sessions: 59,
      did: null,
      whyRepresentative: null,
      tech: ["Inngest", "Supabase/Postgres", "Playwright (E2E)"],
      landing: { commits: 153, reverts: 0, revertChurn: "low", checksRun: true },
      artifact: null,
    },
  ],
  otherProjects: [],
  trajectory: null,
  stackAdopted: ["Inngest", "Supabase/Postgres"],
  authenticity: { score: 100, manifestHash: "abc" },
});

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

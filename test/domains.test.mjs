import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleProfile, renderMarkdown } from "../src/profile.mjs";
import { validateNarrative } from "../src/profile-llm.mjs";
import { assessGroundedness } from "../src/groundedness.mjs";

const landing = { commits: 5, reverts: 0, revertChurn: "low", checksRun: true };
const proj = (repo, sessions, selected = false) => ({
  repo, selected, type: ["feature-work"], from: "2026-05", to: "2026-05",
  sessions, userMessages: sessions * 10, topAreas: {}, tech: [], landing,
  delegation: 0, researchToMutation: 1,
});

const baseNarrative = {
  summary: "Works across talent operations and agentic platforms.",
  cognitive: { narrative: "c" },
  projects: [{ id: "p1", domain: "d", did: "x", why_representative: "y" }],
};

function profileWith(domains) {
  return assembleProfile({
    contact: { name: "X" },
    projects: [proj("a", 6, true), proj("b", 3), proj("c", 1)],
    narrative: { ...baseNarrative, domains },
  });
}

test("domains flow from narrative into the profile and the markdown", () => {
  const domains = [
    { label: "talent and creator operations", products: 2, sessions: 9, note: "admin dashboards" },
    { label: "agentic platforms and tooling", products: 1, sessions: 1 },
  ];
  const p = profileWith(domains);
  assert.deepEqual(p.domains, domains);
  const md = renderMarkdown(p);
  assert.ok(md.includes("## Domains"));
  assert.ok(md.includes("**talent and creator operations** · 2 products · 9 sessions — admin dashboards"));
});

test("profiles without domains render no Domains section", () => {
  const p = assembleProfile({ contact: { name: "X" }, projects: [proj("a", 2, true)], narrative: baseNarrative });
  assert.deepEqual(p.domains, []);
  assert.ok(!renderMarkdown(p).includes("## Domains"));
});

test("validateNarrative rejects malformed domains", () => {
  assert.throws(() => validateNarrative({ ...baseNarrative, domains: [{ label: "", products: 2, sessions: 3 }] }), /label missing/);
  assert.throws(() => validateNarrative({ ...baseNarrative, domains: [{ label: "x", products: 0, sessions: 3 }] }), /products/);
  assert.throws(() => validateNarrative({ ...baseNarrative, domains: { label: "x" } }), /not an array/);
  validateNarrative({ ...baseNarrative, domains: [{ label: "x", products: 1, sessions: 2 }] }); // ok
});

test("groundedness flags domain counts that exceed the deterministic totals", () => {
  // 3 products / 10 sessions in the profile; domains claim 5 products.
  const inflated = profileWith([{ label: "everything", products: 5, sessions: 9 }]);
  const g = assessGroundedness(inflated);
  assert.ok(g.anomalies.some((a) => a.where === "domains" && a.anchor.includes("5 products")), JSON.stringify(g.anomalies));

  const honest = profileWith([{ label: "everything", products: 3, sessions: 10 }]);
  const g2 = assessGroundedness(honest);
  assert.ok(!g2.anomalies.some((a) => a.where === "domains"), JSON.stringify(g2.anomalies));
});

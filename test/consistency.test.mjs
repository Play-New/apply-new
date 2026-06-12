// Defect-to-test: groundedness alone cannot catch a COHERENT tamper — edit
// the structured numbers and the prose together and the anchors still match.
// Found by asking "can candidate.json be doctored right before submit?".
// Answer was yes; these checks (structure invariants + log re-derivation)
// are the fix, and this file pins them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { assessStructure, assessAgainstLogs } from "../src/consistency.mjs";

const honestProfile = () => ({
  schema: "playnew-profile/v1",
  volume: { products: 2, sessions: 15, instructions: 60 },
  authenticity: { score: 88 },
  groundedness: { score: 92 },
  projects: [
    { id: "p1", repoLabel: "acme-storefront", sessions: 10, landing: { commits: 12, reverts: 0 } },
  ],
  otherProjects: [{ repoLabel: "acme-experiments", sessions: 5 }],
});

const digestProjects = () => [
  { repo: "acme-storefront", sessions: 10, userMessages: 40, landing: { commits: 12 } },
  { repo: "acme-experiments", sessions: 5, userMessages: 20, landing: { commits: 3 } },
];

test("an honestly generated profile passes both layers", () => {
  assert.deepEqual(assessStructure(honestProfile()).issues, []);
  const logs = assessAgainstLogs(honestProfile(), digestProjects());
  assert.deepEqual(logs.issues, []);
  assert.deepEqual(logs.warnings, []);
});

test("structure: per-project sessions must sum to volume.sessions exactly", () => {
  const p = honestProfile();
  p.volume.sessions = 40; // inflated total, projects untouched
  const { issues } = assessStructure(p);
  assert.ok(issues.some((i) => i.includes("volume.sessions")), issues.join("; "));
});

test("structure: project counts must sum to volume.products exactly", () => {
  const p = honestProfile();
  p.otherProjects = []; // dropped from the list but not from the count
  const { issues } = assessStructure(p);
  assert.ok(issues.some((i) => i.includes("volume.products")), issues.join("; "));
});

test("logs: a COHERENT tamper (totals and projects inflated together) is caught", () => {
  const p = honestProfile();
  // Internally consistent: structure passes...
  p.projects[0].sessions = 14;
  p.volume.sessions = 19;
  assert.deepEqual(assessStructure(p).issues, []);
  // ...but the logs are the ground truth, and they don't back it.
  const { issues } = assessAgainstLogs(p, digestProjects());
  assert.ok(issues.some((i) => i.includes("claims 19 sessions")), issues.join("; "));
  assert.ok(issues.some((i) => i.includes("claims 14 sessions")), issues.join("; "));
});

test("logs: inflated commits on a project are caught", () => {
  const p = honestProfile();
  p.projects[0].landing.commits = 200;
  const { issues } = assessAgainstLogs(p, digestProjects());
  assert.ok(issues.some((i) => i.includes("200 commits")), issues.join("; "));
});

test("logs: a project that does not exist in the logs is an issue", () => {
  const p = honestProfile();
  p.projects[0].repoLabel = "acme-invented";
  const { issues } = assessAgainstLogs(p, digestProjects());
  assert.ok(issues.some((i) => i.includes("no such project")), issues.join("; "));
});

test("logs: a hand-removed repoLabel is a warning, not a violation", () => {
  const p = honestProfile();
  p.projects[0].repoLabel = null;
  const { issues, warnings } = assessAgainstLogs(p, digestProjects());
  assert.deepEqual(issues, []);
  assert.equal(warnings.length, 1);
});

test("logs: growth since generation is fine (logs only grow until pruning)", () => {
  const grown = [...digestProjects(), { repo: "acme-new", sessions: 4, userMessages: 9, landing: { commits: 1 } }];
  grown[0] = { ...grown[0], sessions: 13, userMessages: 55, landing: { commits: 20 } };
  const { issues } = assessAgainstLogs(honestProfile(), grown);
  assert.deepEqual(issues, []);
});

// The pruning signature: claims exceeding the logs. Normal use only grows the
// logs, so excessClaims > 0 means either post-generation pruning (the common,
// innocent case submit now explains) or hand-inflation — never ongoing use.
test("logs: excessClaims counts claims-exceed-logs issues (pruning signature)", () => {
  const p = honestProfile();
  p.volume.sessions = 99; // logs were pruned (or the file inflated) after generation
  p.projects[0].sessions = 19;
  const { issues, excessClaims } = assessAgainstLogs(p, digestProjects());
  assert.equal(excessClaims, 2);
  assert.equal(issues.length, 2);
});

test("logs: excessClaims is 0 on an honest profile, and when logs merely grew", () => {
  assert.equal(assessAgainstLogs(honestProfile(), digestProjects()).excessClaims, 0);
  const grown = digestProjects();
  grown[0].sessions += 50; // logs grew since generation: one-directional gate stays green
  const { issues, excessClaims } = assessAgainstLogs(honestProfile(), grown);
  assert.equal(excessClaims, 0);
  assert.deepEqual(issues, []);
});

test("logs: a project missing from the logs is an issue but not an excess claim", () => {
  const p = honestProfile();
  p.projects[0].repoLabel = "never-existed";
  const { issues, excessClaims } = assessAgainstLogs(p, digestProjects());
  assert.ok(issues.some((i) => i.includes("no such project")));
  assert.equal(excessClaims, 0);
});

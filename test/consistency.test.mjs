// Defect-to-test: groundedness alone cannot catch a COHERENT tamper — edit
// the structured numbers and the prose together and the anchors still match.
// Found by asking "can candidate.json be doctored right before submit?".
// Answer was yes; these checks (structure invariants + log re-derivation)
// are the fix, and this file pins them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { assessStructure, assessAgainstLogs, submitBlockers } from "../src/consistency.mjs";

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

// --- day-based intensity claims (issue #10, lands on #8's recorded timezone) -

test("structure: activeDays exceeding observedDays is an invariant violation", () => {
  const p = honestProfile();
  p.intensity = { observedDays: 30, activeDays: 31, longestStreak: 5, timezone: "UTC" };
  const { issues } = assessStructure(p);
  assert.ok(issues.some((i) => i.includes("intensity.activeDays")), issues.join("; "));
  p.intensity.activeDays = 30; // every observed day active: legal
  assert.deepEqual(assessStructure(p).issues, []);
});

test("structure: a profile without an intensity block stays valid", () => {
  assert.deepEqual(assessStructure(honestProfile()).issues, []);
});

test("logs: intensity claims exceeding the re-derivation join excessClaims", () => {
  const p = honestProfile();
  p.intensity = { observedDays: 30, activeDays: 24, longestStreak: 9, timezone: "UTC" };
  // Pruning aged out old sessions: whole days fell out of the re-derivation.
  const derived = { activeDays: 20, longestStreak: 6, timezone: "UTC" };
  const { issues, excessClaims } = assessAgainstLogs(p, digestProjects(), { intensity: derived });
  assert.equal(excessClaims, 2);
  assert.ok(issues.some((i) => i.includes("24 active days")), issues.join("; "));
  assert.ok(issues.some((i) => i.includes("9-day streak")), issues.join("; "));
});

test("logs: intensity growth since generation stays green (one-directional gate)", () => {
  const p = honestProfile();
  p.intensity = { observedDays: 30, activeDays: 24, longestStreak: 9, timezone: "UTC" };
  const derived = { activeDays: 26, longestStreak: 11, timezone: "UTC" }; // kept working since
  const { issues, excessClaims } = assessAgainstLogs(p, digestProjects(), { intensity: derived });
  assert.equal(excessClaims, 0);
  assert.deepEqual(issues, []);
});

test("logs: no re-derived intensity given means no intensity checks (old call shape)", () => {
  const p = honestProfile();
  p.intensity = { observedDays: 30, activeDays: 24, longestStreak: 9, timezone: "UTC" };
  const { issues, excessClaims } = assessAgainstLogs(p, digestProjects());
  assert.equal(excessClaims, 0);
  assert.deepEqual(issues, []);
});

// --- orchestration claims (review follow-up on #5) ----------------------------
// The commit made orchestration.tools/toolCount/dispatchCommands citable
// (pooled into the groundedness support set) but nothing re-derived them: a
// hand-edited {"claude-code": 9000} plus matching prose passed every gate.
// Structure pins the free invariants; the logs layer re-checks the counts.

test("structure: orchestration.tools must sum to the project's sessions", () => {
  const p = honestProfile();
  p.projects[0].metrics = { delegation: 2, orchestration: { delegation: 2, tools: { "claude-code": 9000 }, toolCount: 1, toolOverlap: null, dispatchCommands: 0 } };
  const { issues } = assessStructure(p);
  assert.ok(issues.some((i) => i.includes("orchestration.tools")), issues.join("; "));
  p.projects[0].metrics.orchestration.tools = { "claude-code": 10 }; // = sessions
  assert.deepEqual(assessStructure(p).issues, []);
});

test("structure: toolCount must re-derive from the tools split (unknown excluded)", () => {
  const p = honestProfile();
  p.projects[0].metrics = { delegation: 0, orchestration: { delegation: 0, tools: { "claude-code": 8, unknown: 2 }, toolCount: 2, toolOverlap: null, dispatchCommands: 0 } };
  const { issues } = assessStructure(p);
  assert.ok(issues.some((i) => i.includes("toolCount")), issues.join("; "));
  p.projects[0].metrics.orchestration.toolCount = 1; // unknown is not a distinct CLI
  assert.deepEqual(assessStructure(p).issues, []);
});

test("structure: the two delegation copies must agree", () => {
  const p = honestProfile();
  p.projects[0].metrics = { delegation: 4, orchestration: { delegation: 9, tools: { "claude-code": 10 }, toolCount: 1, toolOverlap: null, dispatchCommands: 0 } };
  const { issues } = assessStructure(p);
  assert.ok(issues.some((i) => i.includes("delegation")), issues.join("; "));
});

test("logs: inflated dispatch and per-CLI counts are excess claims", () => {
  const p = honestProfile();
  p.projects[0].metrics = { delegation: 0, orchestration: { delegation: 0, tools: { "claude-code": 10 }, toolCount: 1, toolOverlap: null, dispatchCommands: 7 } };
  const d = digestProjects();
  d[0].orchestration = { delegation: 0, tools: { "claude-code": 6 }, toolCount: 1, toolOverlap: null, dispatchCommands: 2 };
  const { issues, excessClaims } = assessAgainstLogs(p, d);
  assert.ok(issues.some((i) => i.includes("agent dispatches")), issues.join("; "));
  assert.ok(issues.some((i) => i.includes("via claude-code")), issues.join("; "));
  assert.equal(excessClaims, 2);
  // dispatchCommands is matcher-derived, so an update that tightens detection
  // shrinks the re-derivation on unchanged logs — the message must name the
  // innocent cause and its remedy, not only accuse pruning/inflation.
  assert.ok(issues.some((i) => i.includes("agent dispatches") && i.includes("regenerate")), issues.join("; "));
});

test("structure: a zero-session CLI cannot pad the tools split (phantom fan-out)", () => {
  const p = honestProfile();
  // Sum invariant holds (10+0=10) and toolCount re-derives to 2 — but a CLI
  // with zero sessions never touched the product; it exists only to make
  // "fanned out across 2 CLIs" groundable.
  p.projects[0].metrics = { delegation: 0, orchestration: { delegation: 0, tools: { "claude-code": 10, opencode: 0 }, toolCount: 2, toolOverlap: true, dispatchCommands: 0 } };
  const { issues } = assessStructure(p);
  assert.ok(issues.some((i) => i.includes("opencode")), issues.join("; "));
});

test("logs: inflated delegation is an excess claim like every other orchestration count", () => {
  const p = honestProfile();
  p.projects[0].metrics = { delegation: 9000, orchestration: { delegation: 9000, tools: { "claude-code": 10 }, toolCount: 1, toolOverlap: null, dispatchCommands: 0 } };
  assert.deepEqual(assessStructure(p).issues, [], "copies agree, structure alone cannot see it");
  const d = digestProjects();
  d[0].orchestration = { delegation: 3, tools: { "claude-code": 10 }, toolCount: 1, toolOverlap: null, dispatchCommands: 0 };
  const { issues, excessClaims } = assessAgainstLogs(p, d);
  assert.ok(issues.some((i) => i.includes("delegation")), issues.join("; "));
  assert.equal(excessClaims, 1);
});

test("logs: a hand-flipped toolOverlap (migration -> concurrent) is an excess claim", () => {
  const p = honestProfile();
  p.projects[0].metrics = { delegation: 0, orchestration: { delegation: 0, tools: { "claude-code": 10 }, toolCount: 1, toolOverlap: true, dispatchCommands: 0 } };
  const d = digestProjects();
  d[0].orchestration = { delegation: 0, tools: { "claude-code": 10 }, toolCount: 1, toolOverlap: false, dispatchCommands: 0 };
  const { issues, excessClaims } = assessAgainstLogs(p, d);
  assert.ok(issues.some((i) => i.includes("toolOverlap")), issues.join("; "));
  assert.equal(excessClaims, 1);
  // growth direction stays green: false -> true is ongoing use adding overlap
  p.projects[0].metrics.orchestration.toolOverlap = false;
  d[0].orchestration.toolOverlap = true;
  assert.deepEqual(assessAgainstLogs(p, d).issues, []);
});

test("logs: orchestration growth since generation stays green (one-directional gate)", () => {
  const p = honestProfile();
  p.projects[0].metrics = { delegation: 0, orchestration: { delegation: 0, tools: { "claude-code": 10 }, toolCount: 1, toolOverlap: null, dispatchCommands: 2 } };
  const d = digestProjects();
  d[0].orchestration = { delegation: 0, tools: { "claude-code": 15, opencode: 3 }, toolCount: 2, toolOverlap: true, dispatchCommands: 9 };
  const { issues, excessClaims } = assessAgainstLogs(p, d);
  assert.deepEqual(issues, []);
  assert.equal(excessClaims, 0);
});

// --- the submit gate (defect-to-test) ----------------------------------------
// The gate read `g.score != null && g.score < 60` — a profile whose prose had
// fewer than 4 checkable anchors scored null and sailed through the exact gate
// built to stop ungrounded prose, while the intake flags precisely that case.
// submitBlockers is the single pure gate every submit path consults.
test("gate: unscored groundedness (null score) blocks like low groundedness", () => {
  const b = submitBlockers({ groundedness: { score: null, supported: 0, total: 2 } });
  assert.ok(b.some((x) => x.kind === "groundedness-unscored"), JSON.stringify(b));
});

test("gate: 59 blocks, 60 passes", () => {
  assert.ok(submitBlockers({ groundedness: { score: 59 } }).some((x) => x.kind === "groundedness-low"));
  assert.deepEqual(submitBlockers({ groundedness: { score: 60 } }), []);
});

test("gate: consistency issues block with a count", () => {
  const b = submitBlockers({ issues: ["a", "b"], groundedness: { score: 100 } });
  assert.deepEqual(b, [{ kind: "consistency", count: 2 }]);
});

test("gate: --force clears every blocker", () => {
  assert.deepEqual(submitBlockers({ issues: ["a"], groundedness: { score: null }, force: true }), []);
});

test("gate: a clean, scored profile passes", () => {
  assert.deepEqual(submitBlockers({ issues: [], groundedness: { score: 92 } }), []);
});

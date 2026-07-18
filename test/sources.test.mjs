// The capture_level / per-source provenance layer: the profile's own honesty
// about its inputs. Sources are summarized from the parsed bundle, disclosed
// in candidate.json + profile.md, bounded by a structure invariant, and the
// forensic screen is scoped to full-capture sources so structural sources can
// never pass its prefix checks vacuously.
import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeSources, assembleProfile, renderMarkdown } from "../src/profile.mjs";
import { assessStructure } from "../src/consistency.mjs";
import { computeForensics } from "../src/forensics.mjs";
import { sess as factorySess } from "./factories.mjs";

const sess = (source, sid, from, to) => ({
  sessionId: sid,
  source,
  firstTs: from,
  lastTs: to ?? from,
  cwdRaw: "/Users/x/Projects/app",
  cwdRedacted: "/Users/⟨user⟩/Projects/app",
  chain: [{ uuid: `${sid}-0`, parentUuid: null, ts: from }],
  messages: [{ role: "user", ts: from, textRedacted: "x", toolUses: [], toolResults: [], usage: null }],
});

test("summarizeSources: one entry per source, with capture level and month window", () => {
  const parsed = {
    sessions: [
      sess("claude-code", "a", "2026-04-03T10:00:00Z", "2026-04-03T11:00:00Z"),
      sess("claude-code", "b", "2026-06-01T10:00:00Z"),
      sess(undefined, "c", "2026-05-10T10:00:00Z"), // missing tag defaults to claude-code
    ],
  };
  const s = summarizeSources(parsed);
  assert.equal(s.length, 1);
  assert.deepEqual(s[0], {
    source: "claude-code",
    captureLevel: "full",
    sessions: 3,
    window: { from: "2026-04", to: "2026-06" },
    backend: null,
  });
});

test("summarizeSources: unknown sources default to structural capture", () => {
  const s = summarizeSources({ sessions: [sess("opencode", "a", "2026-05-01T10:00:00Z")] });
  assert.equal(s[0].captureLevel, "structural");
});

test("summarizeSources: a codex session reports structural capture in its own group", () => {
  const parsed = {
    sessions: [
      sess("claude-code", "a", "2026-04-03T10:00:00Z", "2026-04-03T11:00:00Z"),
      factorySess("codex", "app"),
    ],
  };
  const s = summarizeSources(parsed);
  assert.equal(s.length, 2, `expected claude-code and codex as separate groups, got ${JSON.stringify(s)}`);
  const codexEntry = s.find((e) => e.source === "codex");
  assert.ok(codexEntry, "codex must have its own group in the sources block");
  assert.equal(codexEntry.captureLevel, "structural");
  assert.equal(codexEntry.sessions, 1);
  const claudeEntry = s.find((e) => e.source === "claude-code");
  assert.equal(claudeEntry.captureLevel, "full", "claude-code must stay full capture, not get pulled down by codex");
});

test("summarizeSources: a pi session reports structural capture in its own group", () => {
  const parsed = {
    sessions: [
      sess("claude-code", "a", "2026-04-03T10:00:00Z", "2026-04-03T11:00:00Z"),
      factorySess("pi", "app"),
    ],
  };
  const s = summarizeSources(parsed);
  assert.equal(s.length, 2, `expected claude-code and pi as separate groups, got ${JSON.stringify(s)}`);
  const piEntry = s.find((e) => e.source === "pi");
  assert.ok(piEntry, "pi must have its own group in the sources block");
  assert.equal(piEntry.captureLevel, "structural");
  assert.equal(piEntry.sessions, 1);
  const claudeEntry = s.find((e) => e.source === "claude-code");
  assert.equal(claudeEntry.captureLevel, "full", "claude-code must stay full capture, not get pulled down by pi");
});

test("summarizeSources: a cursor session reports structural capture in its own group", () => {
  const parsed = {
    sessions: [
      sess("claude-code", "a", "2026-04-03T10:00:00Z", "2026-04-03T11:00:00Z"),
      factorySess("cursor", "app"),
    ],
  };
  const s = summarizeSources(parsed);
  assert.equal(s.length, 2, `expected claude-code and cursor as separate groups, got ${JSON.stringify(s)}`);
  const cursorEntry = s.find((e) => e.source === "cursor");
  assert.ok(cursorEntry, "cursor must have its own group in the sources block");
  assert.equal(cursorEntry.captureLevel, "structural");
  assert.equal(cursorEntry.sessions, 1);
  const claudeEntry = s.find((e) => e.source === "claude-code");
  assert.equal(claudeEntry.captureLevel, "full", "claude-code must stay full capture, not get pulled down by cursor");
});

const assembleArgs = (extra = {}) => ({
  contact: { name: "X", email: "x@y.z", city: "C", status: "freelance" },
  projects: [{ repo: "app", selected: true, type: ["feature-work"], from: "2026-05", to: "2026-05", sessions: 3, userMessages: 9, tech: [], landing: {}, researchToMutation: null, delegation: 0, topAreas: {} }],
  narrative: null,
  fingerprint: { totals: {} },
  forensics: { score: 100 },
  manifestHash: "h",
  ...extra,
});

test("assembleProfile: sources is present when given, absent on old-shape input", () => {
  const without = assembleProfile(assembleArgs());
  assert.ok(!("sources" in without), "old-shape profiles must not grow a sources key");
  assert.equal(without.authenticity.note, "screen, not proof");

  const sources = [{ source: "claude-code", captureLevel: "full", sessions: 5, window: null, backend: null }];
  const withS = assembleProfile(assembleArgs({ sources }));
  assert.deepEqual(withS.sources, sources);
  assert.equal(withS.authenticity.note, "screen, not proof");
});

test("assembleProfile: authenticity note names its scope once a structural source is in the mix", () => {
  const sources = [
    { source: "claude-code", captureLevel: "full", sessions: 5, window: null, backend: null },
    { source: "opencode", captureLevel: "structural", sessions: 9, window: null, backend: "sqlite" },
  ];
  const p = assembleProfile(assembleArgs({ sources }));
  assert.equal(p.authenticity.note, "screen, not proof; verifies full-capture sources only");
});

test("renderMarkdown: sources line + lower-bounds disclosure render when present", () => {
  const sources = [{ source: "claude-code", captureLevel: "full", sessions: 5, window: null, backend: null }];
  const md = renderMarkdown(assembleProfile(assembleArgs({ sources })));
  assert.match(md, /Sources: claude-code \(full capture\) · 5 sessions read/);
  assert.match(md, /lower bounds: logs rotate/);
});

test("structure: volume.sessions cannot exceed what the sources captured", () => {
  const base = {
    schema: "playnew-profile/v1",
    volume: { products: 1, sessions: 10, instructions: 1 },
    projects: [{ id: "p1", repoLabel: "app", sessions: 10, landing: {} }],
    otherProjects: [],
    sources: [{ source: "claude-code", captureLevel: "full", sessions: 4, window: null, backend: null }],
  };
  const { issues } = assessStructure(base);
  assert.ok(issues.some((i) => i.includes("sources block records only 4")), issues.join("; "));

  base.sources[0].sessions = 12; // capture includes ephemeral sessions the digest drops
  assert.ok(!assessStructure(base).issues.some((i) => i.includes("sources block")));
});

test("forensics: structural-source sessions are excluded, never passed vacuously", () => {
  // An opencode session whose chain is full of orphan arcs would flag the
  // uuid_chain check if it were included; scoped out, the check stays clean.
  const orphans = {
    ...sess("opencode", "oc", "2026-05-01T10:00:00Z"),
    chain: Array.from({ length: 10 }, (_, i) => ({ uuid: `oc-${i}`, parentUuid: `missing-${i}`, ts: "2026-05-01T10:00:00Z" })),
  };
  const clean = sess("claude-code", "cc", "2026-05-01T10:00:00Z");
  const f = computeForensics({ sessions: [clean, orphans], files: [] });
  const uuidCheck = f.checks.find((c) => c.id === "uuid_chain");
  assert.equal(uuidCheck.status, "pass", uuidCheck.detail);
});

test("forensics: pi sessions are excluded too (FULL_CAPTURE_SOURCES untouched by pi wiring)", () => {
  // Same forgery-shaped fixture as the opencode/codex cases above, tagged pi
  // instead: an orphaned chain would flag uuid_chain if pi were scanned.
  // Scoped out, the check stays clean — proving landing pi didn't widen
  // FULL_CAPTURE_SOURCES to include it.
  const orphans = {
    ...sess("pi", "pi", "2026-05-01T10:00:00Z"),
    chain: Array.from({ length: 10 }, (_, i) => ({ uuid: `pi-${i}`, parentUuid: `missing-${i}`, ts: "2026-05-01T10:00:00Z" })),
  };
  const clean = sess("claude-code", "cc", "2026-05-01T10:00:00Z");
  const f = computeForensics({ sessions: [clean, orphans], files: [] });
  const uuidCheck = f.checks.find((c) => c.id === "uuid_chain");
  assert.equal(uuidCheck.status, "pass", uuidCheck.detail);
});

test("forensics: codex sessions are excluded too (FULL_CAPTURE_SOURCES untouched by #15)", () => {
  // Same forgery-shaped fixture as the opencode case above, tagged codex
  // instead: an orphaned chain would flag uuid_chain if codex were scanned.
  // Scoped out, the check stays clean — proving landing codex didn't widen
  // FULL_CAPTURE_SOURCES to include it.
  const orphans = {
    ...sess("codex", "cx", "2026-05-01T10:00:00Z"),
    chain: Array.from({ length: 10 }, (_, i) => ({ uuid: `cx-${i}`, parentUuid: `missing-${i}`, ts: "2026-05-01T10:00:00Z" })),
  };
  const clean = sess("claude-code", "cc", "2026-05-01T10:00:00Z");
  const f = computeForensics({ sessions: [clean, orphans], files: [] });
  const uuidCheck = f.checks.find((c) => c.id === "uuid_chain");
  assert.equal(uuidCheck.status, "pass", uuidCheck.detail);
});

test("forensics: cursor sessions are excluded too (FULL_CAPTURE_SOURCES untouched by #15)", () => {
  // Same forgery-shaped fixture as the opencode/codex/pi cases above, tagged
  // cursor instead: an orphaned chain would flag uuid_chain if cursor were
  // scanned. Scoped out, the check stays clean — proving landing cursor
  // didn't widen FULL_CAPTURE_SOURCES to include it.
  const orphans = {
    ...sess("cursor", "cu", "2026-05-01T10:00:00Z"),
    chain: Array.from({ length: 10 }, (_, i) => ({ uuid: `cu-${i}`, parentUuid: `missing-${i}`, ts: "2026-05-01T10:00:00Z" })),
  };
  const clean = sess("claude-code", "cc", "2026-05-01T10:00:00Z");
  const f = computeForensics({ sessions: [clean, orphans], files: [] });
  const uuidCheck = f.checks.find((c) => c.id === "uuid_chain");
  assert.equal(uuidCheck.status, "pass", uuidCheck.detail);
});

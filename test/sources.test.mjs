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

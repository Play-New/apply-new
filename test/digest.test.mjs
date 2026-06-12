import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDigest } from "../src/digest.mjs";

function session(sid, cwdRaw, ts, msgs) {
  return {
    sessionId: sid,
    cwdRaw,
    cwdRedacted: cwdRaw.replace(/\/Users\/[^/]+/, "/Users/⟨user⟩"),
    firstTs: ts[0],
    lastTs: ts.at(-1),
    chain: ts.map((t, i) => ({ uuid: `${sid}-${i}`, parentUuid: null, ts: t })),
    messages: msgs,
  };
}
function tool(name, opts = {}) {
  return { id: Math.random().toString(36).slice(2), name, path: opts.path || "", cmd: opts.cmd || "", q: opts.q || "" };
}
function user(text, ts) { return { role: "user", ts, textRedacted: text, toolUses: [], toolResults: [], usage: null }; }
function assistant(ts, tools = []) { return { role: "assistant", ts, textRedacted: "", toolUses: tools, toolResults: [], usage: null }; }

test("ephemeral sandbox paths are excluded from the digest", () => {
  const parsed = {
    source: "claude-code",
    sessions: [
      session("a", "/private/tmp/claude-501/some/path", ["2026-01-01T10:00:00Z"], [user("x", "2026-01-01T10:00:00Z")]),
      session("b", "/Users/matteo/Github/real-repo", ["2026-01-02T10:00:00Z"], [user("y", "2026-01-02T10:00:00Z")]),
    ],
  };
  const d = buildDigest(parsed);
  assert.equal(d.projectCount, 1);
  assert.equal(d.projects[0].repo, "real-repo");
});

test("ephemeral filter is anchored to scratch roots: user dirs named tmp/private are kept", () => {
  const mk = (sid, cwd) => session(sid, cwd, ["2026-01-01T10:00:00Z"], [user("x", "2026-01-01T10:00:00Z")]);
  const parsed = {
    source: "claude-code",
    sessions: [
      mk("a", "/Users/matteo/tmp/scratchpad-app"),      // kept: tmp/ inside HOME is a real dir
      mk("b", "/Users/matteo/private-notes/journal"),   // kept: merely contains "private"
      mk("c", "/tmp/throwaway"),                        // dropped: scratch root
      mk("d", "/private/tmp/claude-501/task"),          // dropped: macOS alias of /tmp
      mk("e", "/var/folders/ab/cd/T/work"),             // dropped: macOS per-user scratch
      mk("f", "/private/var/folders/zz/yy/T/job"),      // dropped: aliased form
    ],
  };
  const d = buildDigest(parsed);
  assert.deepEqual(d.projects.map((p) => p.repo).sort(), ["journal", "scratchpad-app"]);
});

test("classifies a sustained product build with many commits", () => {
  const cwd = "/Users/matteo/Github/big-product";
  const msgs = [];
  // 30+ days of activity, many Edits and a few commits in Bash
  for (let day = 0; day < 30; day++) {
    const ts = `2026-02-${String((day % 28) + 1).padStart(2, "0")}T10:00:00Z`;
    msgs.push(user("change something", ts));
    msgs.push(assistant(ts, [
      tool("Edit", { path: `${cwd}/src/file${day}.ts` }),
      tool("Edit", { path: `${cwd}/src/other${day}.ts` }),
      tool("Edit", { path: `${cwd}/src/util${day}.ts` }),
      tool("Edit", { path: `${cwd}/src/api${day}.ts` }),
      tool("Edit", { path: `${cwd}/src/lib${day}.ts` }),
      tool("Edit", { path: `${cwd}/src/comp${day}.ts` }),
      tool("Edit", { path: `${cwd}/src/page${day}.ts` }),
      tool("Bash", { cmd: "git commit -m 'work'" }),
    ]));
  }
  const parsed = {
    source: "claude-code",
    sessions: [session("s1", cwd, ["2026-02-01T10:00:00Z", "2026-02-28T10:00:00Z"], msgs)],
  };
  const d = buildDigest(parsed);
  const p = d.projects[0];
  assert.ok(p.type.includes("product-build"), `expected product-build, got ${p.type.join(", ")}`);
  assert.ok(p.landing.commits >= 20, `expected >=20 commits, got ${p.landing.commits}`);
  assert.equal(p.landing.revertChurn, "low");
});

test("selectRepresentatives recency is relative to the candidate's own window", async () => {
  const { selectRepresentatives } = await import("../src/profile.mjs");
  // The cutoff is anchored to the candidate's LATEST project (here 2024-12),
  // not a fixed calendar date, so "recent" means recent for this candidate.
  // The two projects carry the same substance; only the recency bonus, applied
  // because "recent" ends within 2 months of 2024-12, breaks the tie.
  const base = { researchToMutation: 1, delegation: 0, topAreas: {}, tech: [], learningTopics: [], promptSamples: [] };
  const projects = [
    { repo: "old", type: ["product-build"], from: "2023-01", to: "2023-06",
      sessions: 18, mutations: 100, landing: { commits: 20, checksRun: false, revertChurn: "low" }, ...base },
    { repo: "recent", type: ["product-build"], from: "2024-07", to: "2024-12",
      sessions: 18, mutations: 100, landing: { commits: 20, checksRun: false, revertChurn: "low" }, ...base },
  ];
  const picked = selectRepresentatives(projects, 1).filter((p) => p.selected).map((p) => p.repo);
  assert.deepEqual(picked, ["recent"], "recent project should win once recency is relative");
});

test("classifies an audit-research project (lots of reads, few mutations)", () => {
  const cwd = "/Users/matteo/Github/audit-target";
  const reads = Array.from({ length: 200 }, () => tool("Read", { path: `${cwd}/src/x.ts` }));
  const parsed = {
    source: "claude-code",
    sessions: [
      session("s1", cwd, ["2026-03-01T10:00:00Z", "2026-03-05T10:00:00Z"], [
        user("audit the codebase", "2026-03-01T10:00:00Z"),
        assistant("2026-03-01T10:01:00Z", [...reads, tool("Edit", { path: `${cwd}/src/x.ts` })]),
      ]),
    ],
  };
  const d = buildDigest(parsed);
  assert.ok(d.projects[0].type.includes("audit-research"));
});

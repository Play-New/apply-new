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
  // Candidate's latest project ends 2024-12 → recency cutoff is 2024-10.
  // The older project has slightly more work; the +8 recency bonus on the
  // recent one must flip the order.
  const projects = [
    { repo: "old-flagship", type: ["product-build"], from: "2023-01", to: "2023-12",
      sessions: 20, landing: { commits: 50 }, researchToMutation: 1, delegation: 0, topAreas: {}, tech: [], learningTopics: [], promptSamples: [] },
    // Lower raw score, but ends within the last 2 months → recency bonus applies.
    { repo: "recent", type: ["audit-research"], from: "2024-10", to: "2024-12",
      sessions: 15, landing: { commits: 10 }, researchToMutation: 5, delegation: 0, topAreas: {}, tech: [], learningTopics: [], promptSamples: [] },
  ];
  // old: 20 + 0.1*50 = 25.   recent: 15 + 0.1*10 + 8 = 24.   margin is tight on purpose.
  // Adjust to make recency the unambiguous winner:
  projects[1].sessions = 18; // recent: 18 + 1 + 8 = 27 > 25
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

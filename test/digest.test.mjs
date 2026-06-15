import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildDigest, detectStack } from "../src/digest.mjs";

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

// Unit-test detectStack directly against an on-disk fixture. buildDigest would
// drop a fixture created under the OS tmpdir (/var/folders, /tmp) via the
// ephemeral-path filter — so the on-disk assertions live here, and buildDigest-
// level behaviour is exercised on synthetic /Users/... paths below.
test("detectStack: deps across workspace globs + touched evidence, never .env", () => {
  const root = mkdtempSync(join(tmpdir(), "apply-new-stack-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({
      workspaces: ["packages/*"],
      dependencies: { next: "*", firebase: "*", "@prisma/client": "*" },
    }));
    mkdirSync(join(root, "packages", "core"), { recursive: true });
    writeFileSync(join(root, "packages", "core", "package.json"), JSON.stringify({ dependencies: { openai: "*" } }));
    // STRAPI_API_TOKEN would match the /strapi/ dep rule IF env keys were ever
    // fed to detection. They must not be — this is the load-bearing privacy line.
    writeFileSync(join(root, ".env"), "STRAPI_API_TOKEN=secret\n");

    const tech = detectStack({ cwdRaw: root, exts: { py: 1 }, cmdsText: "uvicorn api.main:app" });
    assert.ok(tech.includes("Next.js/React"), tech.join(","));
    assert.ok(tech.includes("Firebase/Firestore"), tech.join(","));
    assert.ok(tech.includes("OpenAI"), tech.join(",")); // workspace dep via "workspaces" glob
    assert.ok(tech.includes("Prisma"), tech.join(",")); // @prisma/client -> real dep
    assert.ok(tech.includes("Python"), tech.join(","));  // touched .py
    assert.ok(tech.includes("FastAPI"), tech.join(",")); // uvicorn command
    assert.ok(!tech.some((t) => /strapi/i.test(t)), `.env leaked Strapi: ${tech.join(",")}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectStack: a subdirectory session still sees the repo-root manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "apply-new-subdir-"));
  try {
    mkdirSync(join(root, ".git"), { recursive: true }); // repo boundary for the walk-up
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { "@supabase/supabase-js": "*" } }));
    mkdirSync(join(root, "apps", "web"), { recursive: true });
    writeFileSync(join(root, "apps", "web", "package.json"), JSON.stringify({ dependencies: { vite: "*" } }));
    // Session ran INSIDE apps/web — must still discover the root supabase dep.
    const tech = detectStack({ cwdRaw: join(root, "apps", "web"), exts: {}, cmdsText: "" });
    assert.ok(tech.includes("Supabase"), `root dep missed from subdir: ${tech.join(",")}`);
    assert.ok(tech.includes("Vite"), tech.join(",")); // and the workspace's own dep
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectStack: a tool name inside a path/argument is not a command false positive", () => {
  assert.ok(!detectStack({ cwdRaw: "", exts: {}, cmdsText: "cat docs/fastapi-notes.md" }).includes("FastAPI"));
  assert.ok(detectStack({ cwdRaw: "", exts: {}, cmdsText: "uvicorn api.main:app" }).includes("FastAPI"));
});

test("stack detection: a path that merely mentions a library is not a false positive", () => {
  // No package.json on disk, a path containing "prisma", no prisma command.
  const cwd = "/Users/matteo/Github/no-deps-repo";
  const parsed = {
    source: "claude-code",
    sessions: [session("s1", cwd, ["2026-04-01T10:00:00Z"], [
      user("x", "2026-04-01T10:00:00Z"),
      assistant("2026-04-01T10:01:00Z", [tool("Edit", { path: `${cwd}/src/lib/prisma/client.ts` })]),
    ])],
  };
  const tech = buildDigest(parsed).projects[0].tech;
  assert.ok(!tech.includes("Prisma"), `path "prisma" became a false positive: ${tech.join(",")}`);
});

test("the digest never reads .env (absence-of-read, proven from source)", () => {
  const src = readFileSync(new URL("../src/digest.mjs", import.meta.url), "utf8");
  const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""); // strip comments
  assert.ok(!/\.env\b/.test(code), "src/digest.mjs must not reference .env in code");
});

// --- undated projects (defect-to-test) ---------------------------------------
// A project whose messages carry no timestamps got `new Date(null)` → epoch →
// "1970-01" as its span — a fabricated date in a tool whose rule is that every
// claimed number must be verifiable. Undated spans are null now, and the
// render shows "n/a" instead of an invented month.
import { assembleProfile, renderMarkdown } from "../src/profile.mjs";

test("a project with no parseable timestamps gets a null span, never the epoch", () => {
  const parsed = {
    source: "claude-code",
    sessions: [{
      sessionId: "u", cwdRaw: "/Users/x/Projects/undated-app",
      cwdRedacted: "/Users/⟨user⟩/Projects/undated-app",
      firstTs: undefined, lastTs: undefined,
      chain: [{ uuid: "u-0", parentUuid: null, ts: undefined }],
      messages: [{ role: "user", ts: undefined, textRedacted: "hello", toolUses: [], toolResults: [], usage: null }],
    }],
  };
  const d = buildDigest(parsed);
  assert.equal(d.projects[0].from, null);
  assert.equal(d.projects[0].to, null);
  assert.ok(!JSON.stringify(d.projects[0]).includes("1970-01"));
});

test("null spans render as n/a, not null→null", () => {
  const p = assembleProfile({
    contact: { name: "X", email: "x@y.z", city: "C", status: "freelance" },
    projects: [
      { repo: "undated", selected: true, type: ["feature-work"], from: null, to: null, sessions: 2, userMessages: 4, tech: [], landing: {}, researchToMutation: null, delegation: 0, topAreas: {} },
      { repo: "inv", selected: false, type: ["feature-work"], from: null, to: null, sessions: 1, userMessages: 1, tech: [], landing: {}, researchToMutation: null, delegation: 0, topAreas: {} },
    ],
    narrative: null, fingerprint: { totals: {} }, forensics: { score: 100 }, manifestHash: "h",
  });
  const md = renderMarkdown(p);
  assert.match(md, /n\/a→n\/a/);
  assert.ok(!md.includes("null→null"));
  assert.ok(!md.includes("1970-01"));
});

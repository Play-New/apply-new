// Shared test factories (not a test file — node --test only picks *.test.mjs).
//
// One normalized-session factory and one baseline playnew-profile/v1 fixture,
// shared so the shapes the tests fake cannot drift apart file by file: a
// session-shape change edited in one test file but not its byte-identical
// copy would leave the stale copy passing vacuously.

// A minimal normalized session as the adapters emit it and buildDigest
// consumes it. `cmds` become Bash toolUses; `ts` stamps every message.
export const sess = (source, repo, cmds = [], { ts = "2026-05-01T10:00:00.000Z" } = {}) => ({
  source,
  cwdRaw: "",
  cwdRedacted: `C:/Users/⟨user⟩/Documents/proj/${repo}`,
  messages: [{
    role: "assistant",
    ts,
    textRedacted: "",
    toolUses: cmds.map((c) => ({ name: "Bash", path: "", cmd: c, q: "" })),
  }],
});

// A coherent playnew-profile/v1 baseline: clone, mutate, assert.
export const baseProfile = () => ({
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

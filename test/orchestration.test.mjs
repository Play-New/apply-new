// Per-product orchestration / fan-out signal. Within a repo (sessions already
// cluster by cwd), two cheap signals reveal that work was dispatched to other
// agents rather than driven entirely by hand: how many distinct agent CLIs
// touched the product (tool fan-out), and how many agent-launcher commands its
// sessions ran. Both are framework-agnostic and computed from data the digest
// already ingests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDigest } from "../src/digest.mjs";

const sess = (source, repo, cmds = []) => ({
  source,
  cwdRaw: "",
  cwdRedacted: `C:/Users/⟨user⟩/Documents/proj/${repo}`,
  messages: [{
    role: "assistant",
    ts: "2026-05-01T10:00:00.000Z",
    textRedacted: "",
    toolUses: cmds.map((c) => ({ name: "Bash", path: "", cmd: c, q: "" })),
  }],
});

test("multi-tool fan-out and dispatch commands surface per product", () => {
  const parsed = {
    sessions: [
      // one Claude session orchestrates: it shells out to two other agent CLIs
      sess("claude-code", "orchestrated-app", ['opencode run "/build the api"', 'claude -p "fix the failing tests"']),
      sess("claude-code", "orchestrated-app"),
      sess("opencode", "orchestrated-app"),       // the dispatched children,
      sess("opencode", "orchestrated-app"),       // same repo → same bucket
      sess("crush", "orchestrated-app"),
      // a hand-driven product: one tool, ordinary shell, no agent launchers
      sess("claude-code", "handmade", ["git commit -m x", "npm run build"]),
    ],
  };
  const d = buildDigest(parsed);

  const orch = d.projects.find((p) => p.repo === "orchestrated-app");
  assert.deepEqual(orch.orchestration.tools, { "claude-code": 2, opencode: 2, crush: 1 });
  assert.equal(orch.orchestration.toolCount, 3);
  assert.equal(orch.orchestration.dispatchCommands, 2);

  const hand = d.projects.find((p) => p.repo === "handmade");
  assert.deepEqual(hand.orchestration.tools, { "claude-code": 1 });
  assert.equal(hand.orchestration.toolCount, 1);
  assert.equal(hand.orchestration.dispatchCommands, 0);
});

test("sessions with no source are bucketed, not dropped", () => {
  const d = buildDigest({ sessions: [sess(undefined, "x")] });
  const p = d.projects.find((p) => p.repo === "x");
  assert.equal(p.orchestration.toolCount, 1);
  assert.equal(p.orchestration.tools.unknown, 1);
});

test("recognises common agent launchers, ignores ordinary shell", () => {
  const cmds = ['aider --yes', 'codex exec "do x"', 'goose run', 'cursor-agent', 'ls -la', 'python build.py'];
  const d = buildDigest({ sessions: [sess("claude-code", "z", cmds)] });
  assert.equal(d.projects[0].orchestration.dispatchCommands, 4); // aider, codex, goose, cursor-agent
});

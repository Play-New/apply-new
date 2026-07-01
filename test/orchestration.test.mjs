// Per-product orchestration / fan-out signal. Within a repo (sessions already
// cluster by cwd), two cheap signals reveal that work was dispatched to other
// agents rather than driven entirely by hand: how many distinct agent CLIs
// touched the product (tool fan-out), and how many agent-launcher commands its
// sessions ran. Both are framework-agnostic and computed from data the digest
// already ingests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDigest } from "../src/digest.mjs";
import { sess } from "./factories.mjs";

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
  assert.equal(orch.orchestration.toolOverlap, true); // same-day sessions: concurrent, not migration
  assert.equal(orch.orchestration.dispatchCommands, 2);

  const hand = d.projects.find((p) => p.repo === "handmade");
  assert.deepEqual(hand.orchestration.tools, { "claude-code": 1 });
  assert.equal(hand.orchestration.toolCount, 1);
  assert.equal(hand.orchestration.toolOverlap, null); // one tool: nothing to overlap
  assert.equal(hand.orchestration.dispatchCommands, 0);
});

test("sessions with no source are bucketed, not dropped", () => {
  const d = buildDigest({ sessions: [sess(undefined, "x")] });
  const p = d.projects.find((p) => p.repo === "x");
  assert.equal(p.orchestration.toolCount, 1);
  assert.equal(p.orchestration.tools.unknown, 1);
});

test("dispatch counts the executable position only — not args, paths, or REPLs", () => {
  const cmds = [
    'aider --message "fix"', 'codex exec "do x"', "goose run", 'cursor-agent -p "check"', // 4 real headless launchers
    "cd my-codex-tests",            // codex inside a hyphenated path — must NOT count
    "cat aider-notes.md",           // aider as an argument — must NOT count
    'cd repo && opencode run "/x"', // chained: the 2nd sub-command IS a launcher
    "claude",                       // interactive REPL — only -p/--print is a dispatch
    "ls -la", "python build.py",    // ordinary shell
  ];
  const d = buildDigest({ sessions: [sess("claude-code", "z", cmds)] });
  // 4 launchers + the chained opencode run = 5; the path/arg/REPL cases are 0.
  assert.equal(d.projects[0].orchestration.dispatchCommands, 5);
});

test("in-session delegation is folded into the orchestration object (ask a)", () => {
  const taskSess = {
    source: "claude-code", cwdRaw: "", cwdRedacted: "C:/Users/⟨user⟩/Documents/proj/deleg",
    messages: [{
      role: "assistant", ts: "2026-05-01T10:00:00.000Z", textRedacted: "",
      toolUses: [{ name: "Task", path: "", cmd: "", q: "" }, { name: "Task", path: "", cmd: "", q: "" }],
    }],
  };
  const p = buildDigest({ sessions: [taskSess] }).projects.find((p) => p.repo === "deleg");
  assert.equal(p.orchestration.delegation, 2, "delegation should live inside orchestration");
  assert.equal(p.delegation, 2, "and still at the top level for existing consumers");
});

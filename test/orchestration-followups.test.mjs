// Follow-up fixes from the PR #5 review:
//  - the codex launcher counts only the HEADLESS `codex exec`, not bare/
//    housekeeping `codex` / `codex login` / `codex mcp` (parity with the
//    `claude -p`-only rule for claude);
//  - the per-CLI orchestration.tools counts that the narrative is fed are added
//    to the groundedness support pool, so an honest fan-out citation isn't
//    flagged ungrounded once a second source lands.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDigest } from "../src/digest.mjs";
import { assessGroundedness } from "../src/groundedness.mjs";
import { sess, baseProfile } from "./factories.mjs";

test("codex dispatch requires the headless `exec` subcommand, not bare/housekeeping codex", () => {
  const cmds = [
    "codex",                  // interactive TUI — NOT a dispatch
    "codex login",            // housekeeping — NOT a dispatch
    "codex mcp",              // housekeeping — NOT a dispatch
    "codex resume",           // housekeeping — NOT a dispatch
    'codex exec "do the thing"', // headless dispatch — counts
    'aider --message "do y"', // headless dispatch — counts
    "aider --yes",            // interactive with autoconfirm — NOT a dispatch
    'cd repo && opencode run "/x"', // chained launcher — counts
  ];
  const d = buildDigest({ sessions: [sess("claude-code", "z", cmds)] });
  // codex exec + aider --message + opencode run = 3; the bare/housekeeping
  // codex and aider lines must contribute 0.
  assert.equal(d.projects[0].orchestration.dispatchCommands, 3,
    `bare/housekeeping launchers should not count: ${JSON.stringify(d.projects[0].orchestration)}`);
});

const groundProfile = () => {
  const p = baseProfile();
  p.summary = "Across 236 sessions on 30 products, the work blends product-build with research-first verification.";
  p.projects[0].sessions = 50; // = the per-CLI split below (honest by construction)
  p.projects[0].did = "Fanned out across 2 CLIs: 38 sessions via Claude, 12 via opencode.";
  p.projects[0].metrics = {
    researchToMutation: 2.1,
    delegation: 4,
    orchestration: { delegation: 4, tools: { "claude-code": 38, opencode: 12 }, toolCount: 2, toolOverlap: true, dispatchCommands: 0 },
  };
  return p;
};

test("per-CLI orchestration.tools counts are grounded (a fan-out citation is supported)", () => {
  const g = assessGroundedness(groundProfile());
  const numberAnomalies = g.anomalies.filter((a) => a.kind === "number");
  assert.deepEqual(numberAnomalies, [],
    `38 and 12 should be grounded by orchestration.tools: ${JSON.stringify(g.anomalies)}`);
  assert.equal(g.score, 100);
});

test("the tools pool stays specific — a number absent from the data is still flagged", () => {
  const p = groundProfile();
  // 777 is clear of every pooled number (and outside the ±5% rounding window of
  // each), so it must flag — proving the tools pool grounds only the real split.
  p.projects[0].did = "Fanned out across 2 CLIs: 38 via Claude, 12 via opencode, plus 777 phantom runs.";
  const g = assessGroundedness(p);
  assert.ok(g.anomalies.some((a) => a.kind === "number" && a.anchor === "777"),
    "777 is in neither the tools pool nor any structured field and must be flagged");
});

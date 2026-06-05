// Autonomous-run detection: an orchestrator (e.g. SUDD's `sudd auto`) stamps a
// correlation marker into the child CLI's first prompt. agentic-literacy counts
// the sessions that carry it as autonomous (dispatched) work — across tools,
// since the marker lives in the prompt text, not in any one tool's log format.

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAgenticLiteracy } from "../src/agentic-literacy.mjs";

const userMsg = (text) => ({ role: "user", textRedacted: text, toolUses: [] });
const session = (id, firstText) => ({ sessionId: id, messages: [userMsg(firstText)] });

test("counts sessions carrying the autonomous-run marker", () => {
  const parsed = {
    sessions: [
      session("s1", "/sudd-run brown change-a\n\n<!-- sudd-run id=r1 change=change-a -->"),
      session("s2", "/sudd-run green\n\n<!-- sudd-run id=r1 change=green:vision -->"),
      session("s3", "let me fix this bug myself"), // interactive — no marker
    ],
  };
  const a = computeAgenticLiteracy(parsed);
  assert.equal(a.uses.autonomous.sessions, 2);
  assert.equal(a.uses.autonomous.runs, 1); // r1 launched both
  assert.equal(a.uses.autonomous.changes, 2); // change-a + green:vision
});

test("no marker anywhere → zeroed, never undefined", () => {
  const a = computeAgenticLiteracy({ sessions: [session("s1", "build the dashboard")] });
  assert.deepEqual(a.uses.autonomous, { sessions: 0, runs: 0, changes: 0 });
});

test("tolerates empty input", () => {
  const a = computeAgenticLiteracy({});
  assert.equal(a.uses.autonomous.sessions, 0);
});

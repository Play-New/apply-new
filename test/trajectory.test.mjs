import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTrajectory } from "../src/trajectory.mjs";

// Build a synthetic "parsed" object the way claude-code.mjs would emit it.
function session(sid, ts, msgs = []) {
  return {
    sessionId: sid,
    firstTs: ts[0],
    lastTs: ts.at(-1),
    chain: ts.map((t, i) => ({ uuid: `${sid}-${i}`, parentUuid: i === 0 ? null : `${sid}-${i - 1}`, ts: t })),
    messages: msgs,
  };
}
function user(text, ts) {
  return { role: "user", ts, textRedacted: text, toolUses: [], toolResults: [], usage: null };
}
function assistant(ts, tools = []) {
  return { role: "assistant", ts, textRedacted: "", toolUses: tools.map((n, i) => ({ id: `t${i}`, name: n, path: "", cmd: "", q: "" })), toolResults: [], usage: null };
}

test("shifts detect a real change in prompt length and delegation", () => {
  const parsed = {
    sessions: [
      // EARLY half: short prompts, no Task delegation
      session("e1", ["2026-01-01T10:00:00Z", "2026-01-01T10:01:00Z"], [
        user("ok fix this", "2026-01-01T10:00:00Z"),
        assistant("2026-01-01T10:01:00Z", ["Edit"]),
      ]),
      session("e2", ["2026-01-10T10:00:00Z", "2026-01-10T10:01:00Z"], [
        user("change name", "2026-01-10T10:00:00Z"),
        assistant("2026-01-10T10:01:00Z", ["Edit"]),
      ]),
      session("e3", ["2026-01-20T10:00:00Z", "2026-01-20T10:01:00Z"], [
        user("now this", "2026-01-20T10:00:00Z"),
        assistant("2026-01-20T10:01:00Z", ["Edit"]),
      ]),
      // LATE half: longer structured prompts, Task delegation
      session("l1", ["2026-04-01T10:00:00Z", "2026-04-01T10:01:00Z"], [
        user("Explore the codebase thoroughly. Read the API routes, the data model, the migrations. Identify any inconsistencies, dead code, missing validation. Produce a numbered checklist of fixes with file paths and line numbers, then propose an execution plan that splits into parallel sub-tasks.", "2026-04-01T10:00:00Z"),
        assistant("2026-04-01T10:01:00Z", ["Task", "Read"]),
      ]),
      session("l2", ["2026-04-15T10:00:00Z", "2026-04-15T10:01:00Z"], [
        user("Read the schema in full. Then explore every API route and verify input validation. Produce a checklist with file paths, line numbers, and acceptance criteria. Split into delegable sub-tasks.", "2026-04-15T10:00:00Z"),
        assistant("2026-04-15T10:01:00Z", ["Task", "Read"]),
      ]),
      session("l3", ["2026-05-01T10:00:00Z", "2026-05-01T10:01:00Z"], [
        user("Decompose this into parallel sub-agents. Each should produce a structured plan with file paths, criteria, and verification steps before any modification.", "2026-05-01T10:00:00Z"),
        assistant("2026-05-01T10:01:00Z", ["Task"]),
      ]),
    ],
  };
  const t = buildTrajectory(parsed);
  assert.equal(t.shifts.available, true);
  const median = t.shifts.deltas.find((d) => d.metric === "median prompt words");
  const delegation = t.shifts.deltas.find((d) => d.metric === "delegation rate");
  assert.ok(median.late > median.early, "late half has longer prompts");
  assert.equal(median.dir, "up");
  assert.equal(delegation.dir, "up");
});

test("system-injected compaction prompts are excluded from prompt-length metrics", () => {
  const longSummary = "Your task is to create a detailed summary of the conversation so far " + "words ".repeat(500);
  const parsed = {
    sessions: [
      session("a", ["2026-01-01T10:00:00Z"], [user(longSummary, "2026-01-01T10:00:00Z")]),
      session("b", ["2026-01-02T10:00:00Z"], [user("fix it", "2026-01-02T10:00:00Z")]),
      session("c", ["2026-05-01T10:00:00Z"], [user("explore the codebase", "2026-05-01T10:00:00Z")]),
      session("d", ["2026-05-02T10:00:00Z"], [user("now refactor this carefully", "2026-05-02T10:00:00Z")]),
    ],
  };
  const t = buildTrajectory(parsed);
  // If the compaction prompt had leaked in, "early median" would be hundreds.
  const median = t.shifts.deltas.find((d) => d.metric === "median prompt words");
  assert.ok(median.early == null || median.early < 50, `compaction prompt leaked: early=${median.early}`);
});

test("new vocabulary surfaces words that appear only in the late half", () => {
  const parsed = {
    sessions: [
      session("e", ["2026-01-01T10:00:00Z"], [user("simple change here please thanks", "2026-01-01T10:00:00Z")]),
      session("e2", ["2026-01-05T10:00:00Z"], [user("simple change again here", "2026-01-05T10:00:00Z")]),
      session("l1", ["2026-05-01T10:00:00Z"], [user("apply enrichment pipeline carefully", "2026-05-01T10:00:00Z")]),
      session("l2", ["2026-05-05T10:00:00Z"], [user("enrichment layer should run first", "2026-05-05T10:00:00Z")]),
      session("l3", ["2026-05-10T10:00:00Z"], [user("the enrichment phase is now interesting", "2026-05-10T10:00:00Z")]),
      session("l4", ["2026-05-15T10:00:00Z"], [user("enrichment again carefully here", "2026-05-15T10:00:00Z")]),
    ],
  };
  const t = buildTrajectory(parsed);
  assert.ok(t.newVocabulary.includes("enrichment"), `newVocabulary missing 'enrichment': ${t.newVocabulary.join(", ")}`);
  // 'simple' is early and should NOT be in the late-vocab.
  assert.ok(!t.newVocabulary.includes("simple"));
});

test("topics cluster web queries into themes per quarter", () => {
  const sess = (sid, ts, q) =>
    session(sid, [ts], [
      { role: "assistant", ts, textRedacted: "", usage: null, toolResults: [],
        toolUses: [{ id: "t", name: "WebSearch", path: "", cmd: "", q }] },
    ]);
  const parsed = {
    sessions: [
      sess("a", "2026-01-15T10:00:00Z", "Anthropic Agent SDK subagents composition"),
      sess("b", "2026-02-15T10:00:00Z", "Swiss typographic style design grid"),
      sess("c", "2026-04-15T10:00:00Z", "Supabase postgres schema migration drizzle index"),
    ],
  };
  const t = buildTrajectory(parsed);
  const q1 = t.topics.find((q) => q.quarter === "2026-Q1");
  const q2 = t.topics.find((q) => q.quarter === "2026-Q2");
  assert.ok(q1.themes.some((th) => th.name === "agent architecture"));
  assert.ok(q1.themes.some((th) => th.name === "design & UI"));
  assert.ok(q2.themes.some((th) => th.name === "data & schema"));
});

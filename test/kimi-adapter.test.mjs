// kimi (kimi-code) adapter: verifies turn synthesis from the loop-event
// stream (step.begin/content.part/tool.call/tool.result/step.end, like
// codex's turn reconstruction), the usage-key rename + per-turn sum across
// multiple step.ends (and null when a turn has no step.end at all), the
// tool.call display-preferred / args-fallback extraction (including the
// PascalCase-passthrough + FetchURL->WebFetch + fallbackToolName cases),
// the tool.result isError-presence-means-true / absence-means-false
// contract, the systemPrompt/title/lastPrompt privacy exclusions, the
// multi-agent-file -> one-session time-ordered rollup, the live-append
// truncated-trailing-line resilience + stats.liveSessionsSeen disclosure,
// the modelAlias Set-accumulation from both config.update and llm.request,
// the absent-root and missing-state.json fallback defaults, and a smoke run
// through the shared lenses.
//
// Every fixture here is fully synthetic, built under mkdtempSync(tmpdir()).
// This machine has real kimi-code sessions under ~/.kimi-code/sessions — no
// test may read them (same hermeticity posture as codex/pi).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readKimi } from "../src/adapters/kimi.mjs";
import { mergeSources } from "../src/adapters/opencode.mjs";
import { buildDigest } from "../src/digest.mjs";
import { computeAgenticLiteracy } from "../src/agentic-literacy.mjs";
import { computeIntensity } from "../src/intensity.mjs";

function makeKimiRoot() {
  return mkdtempSync(join(tmpdir(), "kimi-sessions-"));
}

function withRoot(fn) {
  const root = makeKimiRoot();
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// epoch-ms helper: T(0) is an arbitrary fixed base, T(n) is n seconds later.
const BASE = 1784000000000;
const T = (n) => BASE + n * 1000;

// Build sessions/wd_<slug>/session_<id>/state.json + agents/<agentId>/wire.jsonl.
function makeSessionDir(root, { wd = "wd_proj_abcdef123456", sessionSuffix = "test-session-1" } = {}) {
  const dir = join(root, "sessions", wd, `session_${sessionSuffix}`);
  mkdirSync(dir, { recursive: true });
  return { dir, sessionId: sessionSuffix };
}

function writeStateJson(sessionDir, { workDir = "/Users/synthetic/default-project", title, lastPrompt, agents } = {}) {
  const state = {
    createdAt: "2026-01-02T03:04:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z", // deliberately stale/wrong; must never be trusted for firstTs/lastTs
    title: title ?? "SECRET_TITLE_TEXT_never_leak",
    isCustomTitle: false,
    agents: agents ?? { main: { type: "main", parentAgentId: null } },
    custom: {},
    workDir,
    lastPrompt: lastPrompt ?? "SECRET_LASTPROMPT_TEXT_never_leak",
  };
  writeFileSync(join(sessionDir, "state.json"), JSON.stringify(state));
}

function writeAgentWire(sessionDir, agentId, lines) {
  const dir = join(sessionDir, "agents", agentId);
  mkdirSync(dir, { recursive: true });
  const body = lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n";
  writeFileSync(join(dir, "wire.jsonl"), body);
}

// ── Record builders, mirroring the confirmed real wire.jsonl schema ────────
const metadataRec = (createdAt) => ({ type: "metadata", protocol_version: "1.4", created_at: createdAt });
const configUpdate = (t, { modelAlias, systemPrompt, thinkingEffort } = {}) => ({
  type: "config.update",
  time: t,
  ...(modelAlias !== undefined ? { modelAlias } : {}),
  ...(systemPrompt !== undefined ? { systemPrompt } : {}),
  ...(thinkingEffort !== undefined ? { thinkingEffort } : {}),
});
const toolsSetActive = (t, names) => ({ type: "tools.set_active_tools", names, time: t });
const turnPromptRec = (t, text) => ({ type: "turn.prompt", input: [{ type: "text", text }], origin: { kind: "user" }, time: t });
const appendMessageUser = (t, text) => ({
  type: "context.append_message",
  time: t,
  message: { role: "user", content: [{ type: "text", text }], toolCalls: [], origin: { kind: "user" } },
});
const llmRequest = (t, { modelAlias, provider = "openai", model = "glm-5.2" } = {}) => ({
  type: "llm.request",
  kind: "loop",
  provider,
  model,
  modelAlias,
  time: t,
});
const usageRecordRec = (t, usage) => ({ type: "usage.record", model: "x", usage, usageScope: "turn", time: t });
const stepBegin = (t, turnId, step, uuid = `step-${step}`) => ({
  type: "context.append_loop_event",
  time: t,
  event: { type: "step.begin", uuid, turnId, step },
});
const contentThink = (t, turnId, step, think) => ({
  type: "context.append_loop_event",
  time: t,
  event: { type: "content.part", turnId, step, part: { type: "think", think } },
});
const contentText = (t, turnId, step, text) => ({
  type: "context.append_loop_event",
  time: t,
  event: { type: "content.part", turnId, step, part: { type: "text", text } },
});
const toolCallRec = (t, turnId, step, { toolCallId, name, args, display }) => ({
  type: "context.append_loop_event",
  time: t,
  event: { type: "tool.call", turnId, step, toolCallId, name, args, display },
});
const toolResultRec = (t, { toolCallId, output, isError, note }) => ({
  type: "context.append_loop_event",
  time: t,
  event: {
    type: "tool.result",
    toolCallId,
    parentUuid: toolCallId,
    result: { output, ...(isError !== undefined ? { isError } : {}), ...(note !== undefined ? { note } : {}) },
  },
});
const stepEnd = (t, turnId, step, usage) => ({
  type: "context.append_loop_event",
  time: t,
  event: { type: "step.end", turnId, step, usage, finishReason: "stop" },
});
const permissionApproval = (t, turnId) => ({
  type: "permission.record_approval_result",
  turnId, // a NUMBER here, unlike loop events' string turnId
  toolCallId: "call_x",
  toolName: "Bash",
  action: "Running: something",
  result: { decision: "approved" },
  time: t,
});

// ── 1. User message + loop events synthesize one user + one assistant message ──

test("turn synthesis: a user message + loop events (think, text, tool.call, tool.result, step.end) become one user + one assistant message with correct chain", () => {
  withRoot((root) => {
    const { dir, sessionId } = makeSessionDir(root);
    writeStateJson(dir, { workDir: "/Users/synthetic/proj-one" });
    writeAgentWire(dir, "main", [
      metadataRec(T(-1)),
      configUpdate(T(0), { modelAlias: "zhipuai/glm-5.2" }),
      appendMessageUser(T(1), "please fix the bug"),
      stepBegin(T(2), "0", 1),
      contentThink(T(3), "0", 1, "let me think about this carefully"),
      contentText(T(3), "0", 1, "I'll read the file first"),
      toolCallRec(T(4), "0", 1, { toolCallId: "call_1", name: "Read", args: { path: "/Users/synthetic/proj-one/app.py" }, display: { kind: "file_io", operation: "read", path: "/Users/synthetic/proj-one/app.py" } }),
      toolResultRec(T(5), { toolCallId: "call_1", output: "1\tprint('hi')" }),
      stepEnd(T(6), "0", 1, { inputOther: 100, output: 20, inputCacheRead: 5, inputCacheCreation: 0 }),
    ]);

    const parsed = readKimi(join(root, "sessions"));
    assert.equal(parsed.sessions.length, 1);
    const s = parsed.sessions[0];
    assert.equal(s.messages.length, 2, `expected 1 user + 1 assistant, got roles ${JSON.stringify(s.messages.map((m) => m.role))}`);

    const [user, asst] = s.messages;
    assert.equal(user.role, "user");
    assert.equal(user.textRedacted.trim(), "please fix the bug");
    assert.equal(asst.role, "assistant");
    assert.ok(asst.textRedacted.includes("I'll read the file first"));
    assert.equal(asst.toolUses.length, 1);
    assert.equal(asst.toolUses[0].name, "Read");
    assert.equal(asst.toolResults.length, 1);
    assert.equal(asst.toolResults[0].forId, "call_1");

    // epoch-ms -> ISO
    for (const m of s.messages) {
      assert.equal(typeof m.ts, "string");
      assert.ok(Number.isFinite(Date.parse(m.ts)), `ts not ISO: ${m.ts}`);
    }

    // uuid / parentUuid / chain
    assert.equal(user.uuid, `${sessionId}-main-turn-1`);
    assert.equal(user.parentUuid, null);
    assert.equal(asst.uuid, `${sessionId}-main-turn-2`);
    assert.equal(asst.parentUuid, user.uuid);
    assert.equal(s.chain.length, 2);
    assert.deepEqual(s.chain.map((c) => c.uuid), [user.uuid, asst.uuid]);
  });
});

// ── 2. Usage rename + sum across step.ends; no step.end -> usage null ──

test("usage: inputOther/inputCacheRead/inputCacheCreation rename to input/cacheRead/cacheCreate; two step.ends in one turn sum; a turn with no step.end has usage null", () => {
  withRoot((root) => {
    const { dir } = makeSessionDir(root);
    writeStateJson(dir);
    writeAgentWire(dir, "main", [
      appendMessageUser(T(0), "go"),
      stepBegin(T(1), "0", 1),
      contentText(T(1), "0", 1, "working on it"),
      stepEnd(T(2), "0", 1, { inputOther: 100, output: 10, inputCacheRead: 4, inputCacheCreation: 1 }),
      stepBegin(T(3), "0", 2),
      contentText(T(3), "0", 2, "still working"),
      stepEnd(T(4), "0", 2, { inputOther: 50, output: 5, inputCacheRead: 2, inputCacheCreation: 0 }),
      appendMessageUser(T(5), "go again"),
      contentText(T(6), "1", 1, "no step.end this time"),
    ]);

    const parsed = readKimi(join(root, "sessions"));
    const asstMsgs = parsed.sessions[0].messages.filter((m) => m.role === "assistant");
    assert.equal(asstMsgs.length, 2);
    const [a1, a2] = asstMsgs;
    assert.deepEqual(a1.usage, { input: 150, output: 15, cacheRead: 6, cacheCreate: 1 });
    assert.equal(a2.usage, null, "a turn with no step.end must have usage null, not 0s or undefined");
  });
});

// ── 3. think length -> thinkingChars; think text never stored; signatureChars 0 ──

test("thinking: think text length lands in thinkingChars; the think string itself never appears in the serialized bundle; signatureChars is always 0", () => {
  withRoot((root) => {
    const { dir } = makeSessionDir(root);
    writeStateJson(dir);
    const secretThink = "SECRET_THINKING_TEXT_DO_NOT_LEAK_1234";
    writeAgentWire(dir, "main", [
      appendMessageUser(T(0), "think about it"),
      stepBegin(T(1), "0", 1),
      contentThink(T(1), "0", 1, secretThink),
      contentText(T(2), "0", 1, "the answer"),
      stepEnd(T(3), "0", 1, { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 }),
    ]);

    const parsed = readKimi(join(root, "sessions"));
    const asst = parsed.sessions[0].messages.find((m) => m.role === "assistant");
    assert.equal(asst.thinkingChars, secretThink.length);
    assert.equal(asst.signatureChars, 0);
    const bundleJson = JSON.stringify(parsed);
    assert.ok(!bundleJson.includes(secretThink), "thinking text leaked into the bundle");
  });
});

// ── 4. tool.call: display-preferred, args-fallback, tool-name mapping ──

test("tool.call: display.kind file_io/command wins over args; args is the fallback when display is absent; PascalCase names pass through; FetchURL maps to WebFetch; unknown names fall back to fallbackToolName", () => {
  withRoot((root) => {
    const { dir } = makeSessionDir(root);
    writeStateJson(dir);
    writeAgentWire(dir, "main", [
      appendMessageUser(T(0), "do several things"),
      stepBegin(T(1), "0", 1),
      // display wins over args for both path and command
      toolCallRec(T(2), "0", 1, {
        toolCallId: "c1", name: "Read",
        args: { path: "/args/should-not-win.txt" },
        display: { kind: "file_io", operation: "read", path: "/display/wins.txt" },
      }),
      toolCallRec(T(2), "0", 1, {
        toolCallId: "c2", name: "Bash",
        args: { command: "args-should-not-win" },
        display: { kind: "command", command: "echo display-wins", cwd: "/Users/synthetic/proj" },
      }),
      // display absent: args fallback
      toolCallRec(T(2), "0", 1, { toolCallId: "c3", name: "Write", args: { path: "/args/fallback.txt" } }),
      toolCallRec(T(2), "0", 1, { toolCallId: "c4", name: "Bash", args: { command: "fallback command" } }),
      // q fallback: args.pattern, regardless of display
      toolCallRec(T(2), "0", 1, {
        toolCallId: "c5", name: "Glob",
        args: { pattern: "lib/**/*.js" },
        display: { kind: "file_io", operation: "glob", path: "/Users/synthetic/proj" },
      }),
      // PascalCase passthrough
      toolCallRec(T(2), "0", 1, { toolCallId: "c6", name: "Edit", args: { path: "/x.js" }, display: { kind: "file_io", operation: "edit", path: "/x.js" } }),
      // FetchURL -> WebFetch
      toolCallRec(T(2), "0", 1, { toolCallId: "c7", name: "FetchURL", args: { url: "https://example.com" } }),
      // unknown MCP-shaped name -> fallbackToolName
      toolCallRec(T(2), "0", 1, { toolCallId: "c8", name: "myserver_mytool", args: {} }),
      stepEnd(T(3), "0", 1, { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 }),
    ]);

    const parsed = readKimi(join(root, "sessions"));
    const toolUses = parsed.sessions[0].messages.flatMap((m) => m.toolUses);
    const byId = Object.fromEntries(toolUses.map((u) => [u.id, u]));

    assert.equal(byId.c1.name, "Read");
    assert.equal(byId.c1.path, "/display/wins.txt", "display.path must win over args.path");

    assert.equal(byId.c2.name, "Bash");
    assert.equal(byId.c2.cmd, "echo display-wins", "display.command must win over args.command");

    assert.equal(byId.c3.name, "Write");
    assert.equal(byId.c3.path, "/args/fallback.txt", "args.path must be used when display is absent");

    assert.equal(byId.c4.name, "Bash");
    assert.equal(byId.c4.cmd, "fallback command", "args.command must be used when display is absent");

    assert.equal(byId.c5.q, "lib/**/*.js", "q always comes from args.pattern");

    assert.equal(byId.c6.name, "Edit", "PascalCase tool names must pass through unchanged");

    assert.equal(byId.c7.name, "WebFetch", "FetchURL must map to WebFetch");

    assert.equal(byId.c8.name, "mcp__myserver__mytool", `unknown tool name must fall back to fallbackToolName, got ${byId.c8.name}`);
  });
});

// ── 5. tool.result: isError presence/absence, bytes, output never stored ──

test("tool.result: isError is true only when the field is present; absence means false; bytes is the output length; output text never appears in the serialized bundle", () => {
  withRoot((root) => {
    const { dir } = makeSessionDir(root);
    writeStateJson(dir);
    const secretOutput = "SECRET_TOOL_OUTPUT_TEXT_boom";
    writeAgentWire(dir, "main", [
      appendMessageUser(T(0), "run two tools"),
      stepBegin(T(1), "0", 1),
      toolCallRec(T(1), "0", 1, { toolCallId: "call_ok", name: "Bash", args: { command: "true" }, display: { kind: "command", command: "true" } }),
      toolResultRec(T(2), { toolCallId: "call_ok", output: "ok output" }), // no isError field at all
      toolCallRec(T(2), "0", 1, { toolCallId: "call_fail", name: "Bash", args: { command: "false" }, display: { kind: "command", command: "false" } }),
      toolResultRec(T(3), { toolCallId: "call_fail", output: secretOutput, isError: true, note: null }),
      stepEnd(T(4), "0", 1, { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 }),
    ]);

    const parsed = readKimi(join(root, "sessions"));
    const results = parsed.sessions[0].messages.flatMap((m) => m.toolResults);
    const byId = Object.fromEntries(results.map((r) => [r.forId, r]));

    assert.equal(byId.call_ok.isError, false, "absent isError must mean false");
    assert.equal(byId.call_ok.bytes, "ok output".length);

    assert.equal(byId.call_fail.isError, true);
    assert.equal(byId.call_fail.bytes, secretOutput.length);

    const bundleJson = JSON.stringify(parsed);
    assert.ok(!bundleJson.includes(secretOutput), "tool.result output text leaked into the bundle");
  });
});

// ── 6. systemPrompt / title / lastPrompt privacy exclusion ──

test("PRIVACY: config.update's systemPrompt and state.json's title/lastPrompt never appear in the serialized bundle", () => {
  withRoot((root) => {
    const { dir } = makeSessionDir(root);
    const secretTitle = "SECRET_TITLE_should_never_leak_xyz";
    const secretLastPrompt = "SECRET_LASTPROMPT_should_never_leak_xyz";
    const secretSystemPrompt = "SECRET_SYSTEMPROMPT_should_never_leak_xyz";
    writeStateJson(dir, { title: secretTitle, lastPrompt: secretLastPrompt });
    writeAgentWire(dir, "main", [
      configUpdate(T(0), { systemPrompt: secretSystemPrompt }),
      configUpdate(T(1), { modelAlias: "zhipuai/glm-5.2" }),
      appendMessageUser(T(2), "hello"),
      stepBegin(T(3), "0", 1),
      contentText(T(3), "0", 1, "hi there"),
      stepEnd(T(4), "0", 1, { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 }),
    ]);

    const parsed = readKimi(join(root, "sessions"));
    const bundleJson = JSON.stringify(parsed);
    assert.ok(!bundleJson.includes(secretTitle), "state.json title leaked");
    assert.ok(!bundleJson.includes(secretLastPrompt), "state.json lastPrompt leaked");
    assert.ok(!bundleJson.includes(secretSystemPrompt), "config.update systemPrompt leaked");
  });
});

// ── 7. Multi-agent rollup: agents/main + agents/sub1 -> ONE session, time-ordered ──

test("multi-agent rollup: agents/main + agents/sub1 fold into ONE session, messages ordered by record time across files", () => {
  withRoot((root) => {
    const { dir, sessionId } = makeSessionDir(root);
    writeStateJson(dir, {
      agents: { main: { type: "main", parentAgentId: null }, sub1: { type: "worker", parentAgentId: "main" } },
    });
    // main: user at T(0), assistant flush at T(4) (interleaved with sub1 below)
    writeAgentWire(dir, "main", [
      appendMessageUser(T(0), "main task"),
      stepBegin(T(4), "0", 1),
      contentText(T(4), "0", 1, "main working"),
      stepEnd(T(4), "0", 1, { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 }),
    ]);
    // sub1: user at T(1), assistant flush at T(3) - both fall BETWEEN main's two records
    writeAgentWire(dir, "sub1", [
      appendMessageUser(T(1), "sub task"),
      stepBegin(T(3), "0", 1),
      contentText(T(3), "0", 1, "sub working"),
      stepEnd(T(3), "0", 1, { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 }),
    ]);

    const parsed = readKimi(join(root, "sessions"));
    assert.equal(parsed.sessions.length, 1, "both agent files must fold into ONE session, not two");
    const s = parsed.sessions[0];
    assert.equal(s.sessionId, sessionId);
    assert.equal(s.messages.length, 4);

    // time-ordered across files: main-user(T0), sub1-user(T1), sub1-asst(T3), main-asst(T4)
    const order = s.messages.map((m) => `${m.role}:${m.textRedacted.trim()}`);
    assert.deepEqual(order, ["user:main task", "user:sub task", "assistant:sub working", "assistant:main working"], `messages not time-ordered across agent files: ${JSON.stringify(order)}`);

    // uuids carry the agent id, proving both files were actually read
    assert.ok(s.messages.some((m) => m.uuid.includes("-main-turn-")));
    assert.ok(s.messages.some((m) => m.uuid.includes("-sub1-turn-")));
  });
});

// ── 8. Live-append: truncated trailing line ──

test("live-append: a truncated trailing line in wire.jsonl counts as malformed and never throws; earlier lines still parse; stats.liveSessionsSeen counts the session", () => {
  withRoot((root) => {
    const { dir } = makeSessionDir(root);
    writeStateJson(dir);
    writeAgentWire(dir, "main", [
      appendMessageUser(T(0), "hello"),
      stepBegin(T(1), "0", 1),
      contentText(T(1), "0", 1, "hi there"),
      stepEnd(T(2), "0", 1, { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 }),
      '{"type":"context.append_loop_event","time":' + T(3) + ',"event":{"type":"content.part","part":{"type":"text","text":"cut off mid-wri', // truncated, no closing braces
    ]);

    assert.doesNotThrow(() => readKimi(join(root, "sessions")));
    const parsed = readKimi(join(root, "sessions"));
    assert.equal(parsed.sessions.length, 1);
    assert.equal(parsed.stats.malformedLines, 1);
    assert.equal(parsed.stats.liveSessionsSeen, 1);
    const wireFile = parsed.files.find((f) => f.relPath.endsWith("wire.jsonl"));
    assert.equal(wireFile.malformed, 1);

    const s = parsed.sessions[0];
    assert.equal(s.messages.length, 2, "the earlier, well-formed lines must still parse into messages");
  });
});

// ── 9. modelAlias Set semantics from config.update AND llm.request ──

test("models: modelAlias from config.update AND llm.request both accumulate into session.models with Set (dedup) semantics", () => {
  withRoot((root) => {
    const { dir } = makeSessionDir(root);
    writeStateJson(dir);
    writeAgentWire(dir, "main", [
      configUpdate(T(0), { modelAlias: "zhipuai/glm-5.2" }),
      appendMessageUser(T(1), "go"),
      llmRequest(T(2), { modelAlias: "zhipuai/glm-5.2" }), // duplicate: must not double up
      stepBegin(T(2), "0", 1),
      contentText(T(2), "0", 1, "on it"),
      stepEnd(T(3), "0", 1, { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 }),
      appendMessageUser(T(4), "now switch models"),
      llmRequest(T(5), { modelAlias: "openai/gpt-6-mini" }),
      stepBegin(T(5), "1", 1),
      contentText(T(5), "1", 1, "switched"),
      stepEnd(T(6), "1", 1, { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 }),
    ]);

    const parsed = readKimi(join(root, "sessions"));
    const s = parsed.sessions[0];
    assert.deepEqual([...s.models].sort(), ["openai/gpt-6-mini", "zhipuai/glm-5.2"].sort());
  });
});

// ── 10. Absent root -> EMPTY bundle ──

test("absent root returns an EMPTY bundle, never throws", () => {
  const missing = join(tmpdir(), "kimi-does-not-exist-" + Math.random().toString(36).slice(2));
  const parsed = readKimi(missing);
  assert.equal(parsed.source, "kimi");
  assert.deepEqual(parsed.sessions, []);
  assert.deepEqual(parsed.files, []);
  assert.deepEqual(parsed.compactionSummaries, []);
  assert.deepEqual(parsed.redaction, { hits: 0, charsRemoved: 0 });
  assert.equal(parsed.stats.malformedLines, 0);
  assert.equal(parsed.stats.liveSessionsSeen, 0);
});

// ── 11. Missing state.json -> project-unknown defaults ──

test("a missing state.json does not throw; the session still parses with project-unknown defaults", () => {
  withRoot((root) => {
    const { dir } = makeSessionDir(root);
    // deliberately no writeStateJson() call
    writeAgentWire(dir, "main", [
      appendMessageUser(T(0), "hello with no state.json"),
      stepBegin(T(1), "0", 1),
      contentText(T(1), "0", 1, "hi"),
      stepEnd(T(2), "0", 1, { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 }),
    ]);

    assert.doesNotThrow(() => readKimi(join(root, "sessions")));
    const parsed = readKimi(join(root, "sessions"));
    assert.equal(parsed.sessions.length, 1);
    const s = parsed.sessions[0];
    assert.equal(s.cwdRaw, "");
    assert.equal(s.projectLabel, "project-unknown");
    assert.equal(s.messages.length, 2);
  });
});

// ── 12. Smoke-run through the shared lenses ──

test("smoke: bundle flows through buildDigest + computeAgenticLiteracy + computeIntensity without throwing, session is counted", () => {
  withRoot((root) => {
    const { dir } = makeSessionDir(root);
    writeStateJson(dir, { workDir: "/Users/synthetic/smoke-product" });
    writeAgentWire(dir, "main", [
      configUpdate(T(0), { modelAlias: "zhipuai/glm-5.2" }),
      appendMessageUser(T(1), "fix the bug in app.py"),
      stepBegin(T(2), "0", 1),
      contentText(T(2), "0", 1, "fixed it, tests pass"),
      toolCallRec(T(2), "0", 1, { toolCallId: "call1", name: "Bash", args: { command: "pytest" }, display: { kind: "command", command: "pytest" } }),
      toolResultRec(T(3), { toolCallId: "call1", output: "all green" }),
      stepEnd(T(4), "0", 1, { inputOther: 50, output: 20, inputCacheRead: 0, inputCacheCreation: 0 }),
    ]);

    const parsed = mergeSources(readKimi(join(root, "sessions")));
    assert.doesNotThrow(() => buildDigest(parsed));
    assert.doesNotThrow(() => computeAgenticLiteracy(parsed));
    assert.doesNotThrow(() => computeIntensity(parsed));

    const digest = buildDigest(parsed);
    assert.equal(digest.projects.length, 1);
    assert.equal(digest.projects[0].sessions, 1);

    const intensity = computeIntensity(parsed);
    assert.ok(intensity !== null);
    assert.ok(intensity.activeDays >= 1, "session should be counted as an active day, not silently dropped");
  });
});

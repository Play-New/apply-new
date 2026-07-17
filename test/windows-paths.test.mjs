// Windows-path handling: Claude Code on Windows logs paths with "\" separators.
// The path-based analysis (repo clustering, area extraction, skill/agent
// detection) is written against "/", so without normalisation at the adapter
// boundary every path regex silently misses — areas come back empty, authored
// skills/agents count as 0, and the repo label degrades to the full path.
//
// These tests pin the normalisation by driving the real adapter with synthetic
// Windows-shaped log records and asserting the downstream lenses recover.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readClaudeCode } from "../src/adapters/claude-code.mjs";
import { readCodex } from "../src/adapters/codex.mjs";
import { readPi } from "../src/adapters/pi.mjs";
import { buildDigest } from "../src/digest.mjs";
import { computeAgenticLiteracy } from "../src/agentic-literacy.mjs";

// A Windows working directory and the file paths a session would touch, all
// using backslash separators exactly as Claude Code records them on win32.
const CWD = "C:\\Users\\alice\\Documents\\proj\\my-product";
const records = [
  { type: "user", sessionId: "s1", cwd: CWD, timestamp: "2026-05-01T10:00:00.000Z",
    uuid: "u1", version: "1.0.0",
    message: { role: "user", content: "let's build the agent route and the api" } },
  { type: "assistant", sessionId: "s1", cwd: CWD, timestamp: "2026-05-01T10:01:00.000Z",
    uuid: "u2", parentUuid: "u1", version: "1.0.0",
    message: { role: "assistant", model: "claude-x", content: [
      { type: "tool_use", id: "t1", name: "Edit",
        input: { file_path: "C:\\Users\\alice\\Documents\\proj\\my-product\\src\\api\\agent\\route.ts" } },
      { type: "tool_use", id: "t2", name: "Write",
        input: { file_path: "C:\\Users\\alice\\Documents\\proj\\my-product\\api\\main.py" } },
      { type: "tool_use", id: "t3", name: "Bash",
        input: { command: "uvicorn api.main:app --reload" } },
      { type: "tool_use", id: "t4", name: "Write",
        input: { file_path: "C:\\Users\\alice\\.claude\\skills\\my-skill\\SKILL.md" } },
      { type: "tool_use", id: "t5", name: "Write",
        input: { file_path: "C:\\Users\\alice\\.claude\\agents\\my-agent.md" } },
    ] } },
];

function parseFixture() {
  const dir = mkdtempSync(join(tmpdir(), "apply-new-win-"));
  try {
    writeFileSync(join(dir, "session.jsonl"), records.map((r) => JSON.stringify(r)).join("\n"));
    return readClaudeCode(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("adapter normalises Windows paths to POSIX (and still redacts the user)", () => {
  const parsed = parseFixture();
  const s = parsed.sessions[0];
  assert.ok(!s.cwdRedacted.includes("\\"), `cwdRedacted still has backslashes: ${s.cwdRedacted}`);
  assert.ok(s.cwdRedacted.includes("⟨user⟩"), "username should still be redacted");
  const paths = s.messages.flatMap((m) => m.toolUses.map((u) => u.path)).filter(Boolean);
  for (const p of paths) assert.ok(!p.includes("\\"), `tool path still has backslashes: ${p}`);
});

test("digest clusters by repo basename and recovers code areas + tech on Windows", () => {
  const digest = buildDigest(parseFixture());
  assert.equal(digest.projects.length, 1);
  const proj = digest.projects[0];
  // #4: repo is the basename, not the full "C:\Users\..." path.
  assert.equal(proj.repo, "my-product");
  // #1: code areas are populated (and "src/" is stripped from the lead segment).
  assert.ok(Object.keys(proj.topAreas).includes("api/agent/route.ts"),
    `areas missing route: ${JSON.stringify(proj.topAreas)}`);
  assert.ok(Object.keys(proj.topAreas).includes("api/main.py"));
  // #5: stack is detected from the recovered areas + commands.
  assert.ok(proj.tech.includes("Python"), `tech: ${JSON.stringify(proj.tech)}`);
  assert.ok(proj.tech.includes("FastAPI"), `tech: ${JSON.stringify(proj.tech)}`);
});

test("agentic literacy counts authored skills/agents from Windows paths", () => {
  const a = computeAgenticLiteracy(parseFixture());
  // #2: .claude\skills\...\SKILL.md and .claude\agents\....md are detected.
  assert.equal(a.builds.skillsAuthored, 1);
  assert.equal(a.builds.agentsAuthored, 1);
});

// ── codex: same Windows-path contract, driven through the codex adapter
// instead of claude-code.mjs. Codex's cwd comes from a single session_meta
// record rather than per-message records, so the fixture is a minimal
// rollout file (mirrors test/codex-adapter.test.mjs's writeRollout helper).
const CODEX_CWD = "C:\\Users\\x\\proj";

function parseCodexFixture() {
  const root = mkdtempSync(join(tmpdir(), "apply-new-win-codex-"));
  try {
    const dir = join(root, "2026", "01", "02");
    mkdirSync(dir, { recursive: true });
    const lines = [
      { timestamp: "2026-01-02T03:04:05.000Z", type: "session_meta", payload: { id: "sess-win", cwd: CODEX_CWD, originator: "codex-tui", cli_version: "0.60.0", model_provider: "openai" } },
      { timestamp: "2026-01-02T03:04:06.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "build the agent route" }] } },
      { timestamp: "2026-01-02T03:04:07.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] } },
    ];
    writeFileSync(
      join(dir, "rollout-2026-01-02T03-04-05-11111111-2222-7333-8444-555555555555.jsonl"),
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    );
    return readCodex(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("codex adapter normalises Windows cwd to POSIX (cwdRedacted, projectLabel)", () => {
  const parsed = parseCodexFixture();
  const s = parsed.sessions[0];
  assert.ok(!s.cwdRedacted.includes("\\"), `cwdRedacted still has backslashes: ${s.cwdRedacted}`);
  assert.ok(s.cwdRedacted.includes("⟨user⟩"), "username should still be redacted");
  assert.match(s.projectLabel, /^project-[0-9a-f]{8}$/, `projectLabel not well-formed: ${s.projectLabel}`);
});

// ── pi: same Windows-path contract, driven through the pi adapter instead of
// claude-code.mjs/codex.mjs. pi's cwd comes from a single "session" header
// record (mirrors test/pi-adapter.test.mjs's fixture shape).
const PI_CWD = "C:\\Users\\x\\proj";

function parsePiFixture() {
  const root = mkdtempSync(join(tmpdir(), "apply-new-win-pi-"));
  try {
    const dir = join(root, "sessions", "--decoy--"); // dir-name encoding irrelevant: header cwd wins
    mkdirSync(dir, { recursive: true });
    const lines = [
      { type: "session", id: "sess-win-pi", timestamp: "2026-01-02T03:04:05.000Z", version: 3, cwd: PI_CWD },
      { type: "message", id: "m1", parentId: null, timestamp: "2026-01-02T03:04:06.000Z", message: { role: "user", content: [{ type: "text", text: "build the agent route" }], timestamp: "2026-01-02T03:04:06.000Z" } },
      { type: "message", id: "m2", parentId: "m1", timestamp: "2026-01-02T03:04:07.000Z", message: { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: "2026-01-02T03:04:07.000Z" } },
    ];
    writeFileSync(
      join(dir, "2026-01-02T03-04-05-000Z_11111111-2222-7333-8444-555555555555.jsonl"),
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    );
    return readPi(join(root, "sessions"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("pi adapter normalises Windows cwd to POSIX (cwdRedacted, projectLabel)", () => {
  const parsed = parsePiFixture();
  const s = parsed.sessions[0];
  assert.ok(!s.cwdRedacted.includes("\\"), `cwdRedacted still has backslashes: ${s.cwdRedacted}`);
  assert.ok(s.cwdRedacted.includes("⟨user⟩"), "username should still be redacted");
  assert.match(s.projectLabel, /^project-[0-9a-f]{8}$/, `projectLabel not well-formed: ${s.projectLabel}`);
});

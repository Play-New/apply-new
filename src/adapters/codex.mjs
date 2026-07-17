// codex adapter: reads the Codex CLI / VS Code extension's rollout logs
// (~/.codex/sessions/YYYY/MM/DD/rollout-<iso>-<uuid>.jsonl, one file per
// session) and normalises them into the SAME session model claude-code.mjs
// and opencode.mjs produce, so every downstream lens (digest, agentic-
// literacy, forensics, fingerprint, intensity, distribution) keeps working
// unchanged.
//
// Codex's event stream is flatter than Claude Code's: every line is
// {timestamp, type, payload} and there is no per-message id or parent chain —
// only a chronological sequence of session_meta / turn_context / response_item
// (message, reasoning, function_call(_output), custom_tool_call(_output)) /
// event_msg (token_count, web_search_call, ...) records. We reconstruct TURNS
// ourselves: each surviving user message flushes the previously open
// assistant turn, emits the user message, and opens a fresh assistant turn;
// every reasoning/tool/usage record until the next user message folds into
// that open turn, and the final turn is flushed at EOF. This is the only
// adapter where turn boundaries aren't handed to us by the source tool.
//
// Two kinds of noise are filtered before a "user message" is allowed to
// become a turn boundary:
//   - role "developer": framework-injected system turns (never authored by
//     the human), dropped entirely — no text, no boundary, no count.
//   - role "user" content BLOCKS wrapped ENTIRELY in <environment_context> or
//     <permissions instructions> tags: Codex re-injects IDE/sandbox state as
//     a synthetic block, sometimes alongside a real human block in the same
//     message. Filtering is per block, not per message: a wrapped block never
//     contributes text, and a message where every block is wrapped (or which
//     has none left after filtering) is dropped entirely — counting it as a
//     real turn would inflate the turn count and pollute textRedacted with
//     boilerplate.
//
// apply_patch is Codex's diff-application tool and its `input` is the raw
// unified-diff text — full file contents can ride along in an Add File hunk.
// We never store it: only the touched file paths are pulled out of the
// "*** Add/Update/Delete File: ..." headers (redacted, POSIX'd), one toolUse
// per file, so path-based analysis downstream (repo clustering, area
// extraction) still works without the diff body ever touching the bundle.
//
// Same structural-capture posture as the other two adapters: reasoning text,
// tool output, and diff bodies are reduced to lengths/booleans/paths, never
// kept — see redact.mjs and claude-code.mjs/opencode.mjs for the shared
// contract this adapter has to honor.

import { readFileSync, existsSync, statSync } from "node:fs";
import { join, relative, basename } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { redactText, countRedactions } from "../redact.mjs";
import { toPosix, walk } from "./claude-code.mjs";
import { fallbackToolName } from "./tool-vocab.mjs";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const shortHash = (s) => sha256(s).slice(0, 8);

// ── Default location ────────────────────────────────────────────────────────
// CODEX_HOME defaults to ~/.codex; sessions live under sessions/. The PARENT
// (auth.json, config.toml, history.jsonl, *.sqlite*) is never resolved or
// opened here — only the sessions subdirectory is walked.
export function defaultCodexRoot() {
  const base = process.env.CODEX_HOME || join(homedir(), ".codex");
  return join(base, "sessions");
}

// ── Tool vocabulary: codex → canonical (Claude Code) names ─────────────────
const TOOL_MAP = {
  exec_command: "Bash",
  shell: "Bash",
  shell_command: "Bash",
  update_plan: "TodoWrite",
  request_user_input: "AskUserQuestion",
};
function mapTool(name) {
  if (!name) return name;
  if (TOOL_MAP[name]) return TOOL_MAP[name];
  // Anything else falls through to the fallback shared with every other
  // adapter (see tool-vocab.mjs) so unmapped/MCP tool names land on the same
  // "mcp__server__tool" shape regardless of which source produced them.
  return fallbackToolName(name);
}

// A raw shell-ish command string pulled out of a function_call's already-
// parsed `arguments`, before mapping/redaction. `shell`'s command can be a
// string array (["bash","-lc","cmd"]); the others are plain strings.
function rawCommand(name, args) {
  if (name === "exec_command") return args.cmd;
  if (name === "shell") return Array.isArray(args.command) ? args.command.join(" ") : args.command;
  if (name === "shell_command") return args.command;
  return "";
}

// function_call → toolUse. Safe-parses `arguments` (a JSON-encoded string);
// malformed arguments degrade to {} rather than dropping the call entirely,
// since the call itself (name, id) is still structurally meaningful.
function buildFunctionCallToolUse(payload) {
  const name = payload.name;
  let args = {};
  try {
    args = JSON.parse(payload.arguments);
    if (!args || typeof args !== "object") args = {};
  } catch {
    args = {};
  }
  const mapped = mapTool(name);
  // Same truncation length opencode/claude-code apply to Bash commands.
  const cmd = mapped === "Bash" ? redactText(String(rawCommand(name, args) || "").slice(0, 240)) : "";
  const q = mapped === "AskUserQuestion" ? redactText(String(args.questions?.[0]?.question || "").slice(0, 200)) : "";
  return { id: payload.call_id, name: mapped, path: "", cmd, q };
}

// apply_patch's `input` is the raw diff text — never stored. Only the touched
// file paths survive, extracted from the "*** Add/Update/Delete File: X"
// headers. Zero parseable headers → a single pathless toolUse (the call still
// happened; we just can't say which file it touched).
const PATCH_HEADER_RE = /^\*\*\* (?:Add File|Update File|Delete File): (.+)$/gm;
function buildApplyPatchToolUses(payload) {
  const callId = payload.call_id;
  const input = typeof payload.input === "string" ? payload.input : "";
  const paths = [...input.matchAll(PATCH_HEADER_RE)].map((m) => m[1]);
  if (paths.length === 0) return [{ id: callId, name: "Edit", path: "", cmd: "", q: "" }];
  return paths.map((p, i) => ({ id: `${callId}-${i}`, name: "Edit", path: toPosix(redactText(p)), cmd: "", q: "" }));
}

// function_call_output → toolResult. Codex's exec harness prefixes real
// output with "Exit code: N"; a non-zero code is the only error signal we
// get (there's no separate boolean). Output text itself is never stored,
// only its byte length.
function buildFunctionCallResult(payload) {
  const output = typeof payload.output === "string" ? payload.output : "";
  const m = /^Exit code: (\d+)/.exec(output);
  const isError = !!m && m[1] !== "0";
  return { forId: payload.call_id, isError, bytes: Buffer.byteLength(output) };
}

// custom_tool_call_output → toolResult (apply_patch's own result record).
// Unlike function_call_output there's no "Exit code" convention; when a
// `status` field is present, anything but "completed" is an error, else we
// have no error signal and default to false.
function buildCustomToolResult(payload) {
  const isError = Object.prototype.hasOwnProperty.call(payload, "status") ? payload.status !== "completed" : false;
  const output = payload.output;
  const outStr = typeof output === "string" ? output : JSON.stringify(output ?? "");
  return { forId: payload.call_id, isError, bytes: Buffer.byteLength(outStr) };
}

// reasoning → {thinkingChars, signatureChars}. Like Claude's redacted
// thinking, only lengths survive as a depth proxy — the summary text and the
// encrypted_content blob are both dropped.
function reasoningLens(payload) {
  const summary = Array.isArray(payload.summary) ? payload.summary : [];
  const summaryText = summary.filter((s) => s && s.type === "summary_text").map((s) => s.text || "").join("");
  const signature = typeof payload.encrypted_content === "string" ? payload.encrypted_content : "";
  return { thinkingChars: summaryText.length, signatureChars: signature.length };
}

// message.content is an array of {type: "input_text"|"output_text", text}.
function extractMessageText(content) {
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "input_text" || b.type === "output_text") text += (b.text || "") + "\n";
  }
  return text;
}

// Framework-injected content: Codex re-sends IDE/sandbox state as a synthetic
// block wrapped entirely in one of these tags (checked per content block —
// see extractUserMessageText below — not per message). Trimmed text must
// both start with the open tag and end with its close tag — otherwise a real
// block that merely mentions the tag would be dropped.
const FRAMEWORK_TAGS = [
  { open: "<environment_context>", close: "</environment_context>" },
  { open: "<permissions instructions>", close: "</permissions instructions>" },
];
function isFrameworkWrapped(trimmed) {
  return FRAMEWORK_TAGS.some((t) => trimmed.startsWith(t.open) && trimmed.endsWith(t.close));
}

// role "user" content, filtered per block: Codex can mix a real human block
// with a framework-injected <environment_context>/<permissions instructions>
// block in the SAME message. Each block is judged on its own trimmed text;
// a block that survives contributes to the message exactly like
// extractMessageText does, one that's framework-wrapped is dropped without
// contributing. Returns null when no block survives (all wrapped, or there
// were none) so the caller can skip the message entirely — the pre-existing
// behavior for pure boilerplate.
function extractUserMessageText(content) {
  if (!Array.isArray(content)) return null;
  let text = "";
  let survived = 0;
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if (b.type !== "input_text" && b.type !== "output_text") continue;
    const blockText = b.text || "";
    if (isFrameworkWrapped(blockText.trim())) continue;
    survived++;
    text += blockText + "\n";
  }
  return survived > 0 ? text : null;
}

// rollout-<iso-ts>-<uuid>.jsonl — pull the trailing uuid as a sessionId
// fallback for when session_meta is missing or fails to parse.
const FILENAME_UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
function sessionIdFromFilename(path) {
  const m = FILENAME_UUID_RE.exec(basename(path));
  return m ? m[1] : basename(path, ".jsonl");
}

const EMPTY = (root) => ({
  source: "codex",
  root: root || null,
  files: [],
  sessions: [],
  compactionSummaries: [],
  redaction: { hits: 0, charsRemoved: 0 },
  stats: { originatorCounts: {}, malformedLines: 0 },
});

export function readCodex(root) {
  if (!root || !existsSync(root)) return EMPTY(root);

  const files = [];
  const sessions = [];
  let redactionHits = 0;
  let redactedChars = 0;
  const originatorCounts = {};
  let malformedLinesTotal = 0;

  for (const path of walk(root)) {
    const buf = readFileSync(path);
    const relPath = relative(root, path);
    const lines = buf.toString("utf8").split("\n").filter((l) => l.trim());
    const records = [];
    let malformed = 0;
    for (const line of lines) {
      try {
        records.push(JSON.parse(line));
      } catch {
        malformed++;
      }
    }
    malformedLinesTotal += malformed;

    const session = {
      source: "codex",
      sessionId: sessionIdFromFilename(path),
      projectLabel: "project-unknown",
      cwdRedacted: "",
      cwdRaw: "", // local-only; never sent in the bundle
      gitBranch: null, // codex does not record the branch
      cliVersions: new Set(),
      models: new Set(),
      messages: [],
      chain: [], // {uuid, parentUuid, ts}
      firstTs: null,
      lastTs: null,
    };

    let currentModel = null;
    let modelProvider = null;
    let turn = null; // open assistant-turn accumulator, or null between turns
    let turnN = 0;
    let prevUuid = null;

    const stampSessionTs = (ts) => {
      if (!ts) return;
      if (!session.firstTs || ts < session.firstTs) session.firstTs = ts;
      if (!session.lastTs || ts > session.lastTs) session.lastTs = ts;
    };

    // Emit one normalized message (user or the flushed assistant turn),
    // wiring up the uuid/parentUuid chain and the redaction accumulators.
    const emit = (role, ts, text, extra = {}) => {
      turnN += 1;
      const uuid = `${session.sessionId}-turn-${turnN}`;
      const parentUuid = prevUuid;
      prevUuid = uuid;

      redactionHits += countRedactions(text);
      const textRedacted = redactText(text);
      redactedChars += text.length - textRedacted.length;

      session.messages.push({
        role,
        ts,
        uuid,
        parentUuid,
        model: currentModel,
        textRedacted,
        textLen: text.length,
        thinkingChars: extra.thinkingChars || 0,
        signatureChars: extra.signatureChars || 0,
        toolUses: extra.toolUses || [],
        toolResults: extra.toolResults || [],
        usage: extra.usage || null,
      });
      session.chain.push({ uuid, parentUuid, ts });
      stampSessionTs(ts);
    };

    const openTurn = () => {
      turn = { ts: null, text: "", thinkingChars: 0, signatureChars: 0, toolUses: [], toolResults: [], usage: null };
    };
    const markTurnTs = (ts) => {
      if (turn && !turn.ts && ts) turn.ts = ts;
    };
    const flushTurn = () => {
      if (!turn) return;
      const hasContent =
        turn.text.trim().length > 0 ||
        turn.toolUses.length > 0 ||
        turn.toolResults.length > 0 ||
        turn.thinkingChars > 0 ||
        turn.signatureChars > 0 ||
        !!turn.usage;
      if (hasContent) {
        emit("assistant", turn.ts, turn.text, {
          thinkingChars: turn.thinkingChars,
          signatureChars: turn.signatureChars,
          toolUses: turn.toolUses,
          toolResults: turn.toolResults,
          usage: turn.usage,
        });
      }
      turn = null;
    };

    for (const r of records) {
      if (!r || typeof r !== "object") continue;
      const ts = typeof r.timestamp === "string" ? r.timestamp : null;
      const payload = r.payload && typeof r.payload === "object" ? r.payload : {};

      if (r.type === "session_meta") {
        if (payload.id) session.sessionId = payload.id;
        if (payload.cwd) {
          session.cwdRaw = payload.cwd;
          session.cwdRedacted = toPosix(redactText(payload.cwd));
          session.projectLabel = `project-${shortHash(payload.cwd)}`;
        }
        if (payload.cli_version) session.cliVersions.add(payload.cli_version);
        if (payload.model_provider) modelProvider = payload.model_provider;
        if (payload.originator) originatorCounts[payload.originator] = (originatorCounts[payload.originator] || 0) + 1;
        continue;
      }

      if (r.type === "turn_context") {
        if (payload.model) {
          currentModel = modelProvider ? `${modelProvider}/${payload.model}` : payload.model;
          session.models.add(currentModel);
        }
        continue;
      }

      if (r.type === "response_item") {
        switch (payload.type) {
          case "message": {
            const role = payload.role;
            if (role === "developer") break; // framework-injected: drop entirely
            if (role === "user") {
              const text = extractUserMessageText(payload.content);
              if (text === null) break; // no surviving block: pure boilerplate, skip entirely
              flushTurn();
              emit("user", ts, text);
              openTurn();
            } else if (role === "assistant" && turn) {
              turn.text += extractMessageText(payload.content);
              markTurnTs(ts);
            }
            break;
          }
          case "reasoning": {
            if (!turn) break;
            const { thinkingChars, signatureChars } = reasoningLens(payload);
            turn.thinkingChars += thinkingChars;
            turn.signatureChars += signatureChars;
            markTurnTs(ts);
            break;
          }
          case "function_call": {
            if (!turn) break;
            turn.toolUses.push(buildFunctionCallToolUse(payload));
            markTurnTs(ts);
            break;
          }
          case "function_call_output": {
            if (!turn) break;
            turn.toolResults.push(buildFunctionCallResult(payload));
            break;
          }
          case "custom_tool_call": {
            if (!turn) break;
            const toolUses =
              payload.name === "apply_patch"
                ? buildApplyPatchToolUses(payload)
                : [{ id: payload.call_id, name: mapTool(payload.name), path: "", cmd: "", q: "" }];
            turn.toolUses.push(...toolUses);
            markTurnTs(ts);
            break;
          }
          case "custom_tool_call_output": {
            if (!turn) break;
            turn.toolResults.push(buildCustomToolResult(payload));
            break;
          }
          default:
            break; // structural records with no message-shaped content
        }
        continue;
      }

      if (r.type === "event_msg") {
        switch (payload.type) {
          case "token_count": {
            const u = payload.last_token_usage;
            if (u && turn) {
              turn.usage ||= { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
              turn.usage.input += u.input_tokens || 0;
              turn.usage.output += u.output_tokens || 0;
              turn.usage.cacheRead += u.cached_input_tokens || 0;
              // cacheCreate has no codex counterpart; stays 0.
              markTurnTs(ts);
            }
            break;
          }
          case "web_search_call": {
            const query = payload.action && payload.action.query;
            const q = query ? redactText(String(query).slice(0, 200)) : "";
            const toolUse = { id: payload.call_id || payload.id, name: "WebSearch", path: "", cmd: "", q };
            if (turn) {
              turn.toolUses.push(toolUse);
              markTurnTs(ts);
            }
            break;
          }
          default:
            break; // task_started, task_complete, agent_message, user_message,
          // web_search_end, agent_reasoning... duplicate response_item
          // content or carry nothing structural worth capturing.
        }
        continue;
      }
      // Unknown top-level record type: ignore.
    }

    flushTurn();

    files.push({ relPath, sha256: sha256(buf), bytes: statSync(path).size, lines: lines.length, malformed });
    sessions.push({ ...session, cliVersions: [...session.cliVersions], models: [...session.models] });
  }

  return {
    source: "codex",
    root,
    files,
    sessions,
    compactionSummaries: [], // codex has no compaction-summary convention to mine
    redaction: { hits: redactionHits, charsRemoved: redactedChars },
    stats: { originatorCounts, malformedLines: malformedLinesTotal },
  };
}

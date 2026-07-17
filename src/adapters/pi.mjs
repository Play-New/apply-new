// pi (pi.dev) adapter: reads pi's per-project session logs
// (~/.pi/agent/sessions/<encoded-cwd>/<iso-ts>_<uuid>.jsonl, one file per
// session) and normalises them into the SAME session model claude-code.mjs,
// opencode.mjs and codex.mjs produce, so every downstream lens (digest,
// agentic-literacy, forensics, fingerprint, intensity, distribution) keeps
// working unchanged.
//
// The one structurally pleasant thing about pi's log format: every record
// already carries a real {id, parentId, timestamp: ISO}. Unlike codex (whose
// flat event stream has no per-message id and forces us to reconstruct
// TURNS ourselves), pi hands us the chain directly — so there is NO turn
// synthesis here. Every `type: "message"` record becomes exactly one entry
// in session.messages (role "user" | "assistant" | "toolResult"), uuid = the
// record's own id, parentUuid = its parentId, ts = its timestamp passed
// through as-is (already ISO). "toolResult" is its own record in pi (unlike
// Claude Code/opencode, where a tool result is a content BLOCK folded into
// the calling assistant message) — it becomes its own message row here too,
// carrying an empty toolUses and a single-element toolResults array, so the
// shared lenses (which iterate m.toolUses/m.toolResults unconditionally on
// every message, not just assistant ones — see digest.mjs/forensics.mjs)
// keep working without special-casing a third role.
//
// CRITICAL PRIVACY RULE: pi's model_change record carries `modelId`, which
// for local models can be a full filesystem path (e.g.
// "/Users/<name>/.cache/mlx/Qwen3-...") — the OS username lives right there
// in the model identifier, not in some free-text field an LLM pass might
// catch later. It is redacted with the same structural redactText() used for
// cwd, before it ever touches session.models or an assistant message's
// `model` field. This is the single most important privacy assertion in this
// adapter (see the "PRIVACY" test).
//
// No within-pi subagent rollup (compare opencode.mjs's applyRollup): 64 real
// sessions on this machine show no delegation/subagent tool at all. This is
// a deliberate scope cut, not an oversight — revisit if/when pi ships a
// Task-equivalent tool.
//
// Same structural-capture posture as the other adapters: thinking text, tool
// output, and compaction-summary overflow are reduced to lengths/booleans/
// truncated-and-redacted text, never kept in full — see redact.mjs and
// claude-code.mjs/opencode.mjs/codex.mjs for the shared contract this
// adapter has to honor.

import { readFileSync, existsSync, statSync } from "node:fs";
import { join, relative, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { redactText, countRedactions } from "../redact.mjs";
import { toPosix, walk } from "./claude-code.mjs";
import { fallbackToolName } from "./tool-vocab.mjs";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const shortHash = (s) => sha256(s).slice(0, 8);

// ── Default location ────────────────────────────────────────────────────────
// pi documents no env-var override for the sessions root (unlike CODEX_HOME
// or opencode's XDG chain) — --pi-root at the CLI layer is how an override
// gets applied, not this function. Stated honestly rather than inventing an
// env var pi doesn't support.
//
// The PARENT of sessions/ (auth.json, settings.json, models.json,
// models-store.json, trust.json — confirmed present on this machine) is
// never resolved or opened here; only the sessions subdirectory is walked.
export function defaultPiRoot() {
  return join(homedir(), ".pi", "agent", "sessions");
}

// ── Tool vocabulary: pi → canonical (Claude Code) names ─────────────────────
// bash/edit/read/write/ls are the names actually observed across 64 real
// sessions on this machine (ls -> Read, matching opencode's list -> Read
// precedent). glob/grep/task/webfetch/websearch are documented but were never
// observed here; they're included only because opencode.mjs's TOOL_MAP maps
// the identical lowercase names, so if pi ever emits them they land on the
// same canonical name a different source would produce for the same action.
// Anything else (extension tools, the argument-less "Validation" tool seen in
// real data) falls through to fallbackToolName, unchanged when it has no
// "server_tool" shape.
const TOOL_MAP = {
  bash: "Bash",
  edit: "Edit",
  read: "Read",
  write: "Write",
  ls: "Read",
  glob: "Glob",
  grep: "Grep",
  task: "Task",
  webfetch: "WebFetch",
  websearch: "WebSearch",
};
function mapTool(name) {
  if (!name) return name;
  if (TOOL_MAP[name]) return TOOL_MAP[name];
  return fallbackToolName(name);
}

// toolCall.arguments is normally an object, but real data has at least one
// observed case of a non-object shape: a "Validation" call with
// `arguments: []`. Guard so a malformed/empty-array arguments never throws
// and just degrades to no path/cmd/q, same posture as codex's function_call
// argument guard.
function buildToolUse(id, name, rawArguments) {
  const args = rawArguments && typeof rawArguments === "object" && !Array.isArray(rawArguments) ? rawArguments : {};
  const mapped = mapTool(name);
  const path = toPosix(redactText(String(args.path || args.filePath || args.file_path || "")));
  const cmd = mapped === "Bash" ? redactText(String(args.command || args.cmd || "").slice(0, 240)) : "";
  const q = redactText(String(args.query || args.url || args.pattern || "").slice(0, 200));
  return { id, name: mapped, path, cmd, q };
}

// Assistant message content: {type:"thinking", thinking, thinkingSignature},
// {type:"text", text}, {type:"toolCall", id, name, arguments}. Thinking text
// and its signature are reduced to lengths only, exactly like Claude Code's
// redacted-thinking blocks and codex's reasoning summaries — never stored.
function reduceAssistantContent(content) {
  const toolUses = [];
  let text = "";
  let thinkingChars = 0;
  let signatureChars = 0;
  if (Array.isArray(content)) {
    for (const b of content) {
      if (!b || typeof b !== "object") continue;
      switch (b.type) {
        case "text":
          text += (b.text || "") + "\n";
          break;
        case "thinking":
          thinkingChars += (b.thinking || "").length;
          signatureChars += (b.thinkingSignature || "").length;
          break;
        case "toolCall":
          toolUses.push(buildToolUse(b.id, b.name, b.arguments));
          break;
      }
    }
  }
  return { text, thinkingChars, signatureChars, toolUses };
}

// User message content: {type:"text", text} blocks only, per the observed shape.
function extractUserText(content) {
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const b of content) {
    if (b && typeof b === "object" && b.type === "text") text += (b.text || "") + "\n";
  }
  return text;
}

// toolResult.content is an array of {type:"text", text} blocks; bytes is the
// sum of their .length — the claude-code/opencode convention (`.length`, not
// codex's Buffer.byteLength outlier). The text itself is never stored.
function toolResultBytes(content) {
  if (!Array.isArray(content)) return 0;
  return content.reduce((n, b) => n + (b && typeof b.text === "string" ? b.text.length : 0), 0);
}

// {input, output, cacheRead, cacheWrite} -> {input, output, cacheRead,
// cacheCreate} (RENAME only — cacheWrite is pi's name for the same thing
// claude-code/opencode call cacheCreate). Absent usage stays null so
// downstream's `if (m.usage)` gate behaves the same as every other adapter.
function buildUsage(u) {
  if (!u || typeof u !== "object") return null;
  return { input: u.input || 0, output: u.output || 0, cacheRead: u.cacheRead || 0, cacheCreate: u.cacheWrite || 0 };
}

// Compaction noise floor + max length, mirrored EXACTLY from opencode.mjs's
// ingestMessage (200-char floor, 3000-char slice) so a "compaction summary"
// means the same thing regardless of which adapter produced it.
const COMPACTION_MIN_LEN = 200;
const COMPACTION_MAX_LEN = 3000;

// Directory name = cwd with "/" replaced by "-", wrapped in a leading and
// trailing "--" (e.g. "/Users/x/proj" -> "--Users-x-proj--"). LOSSY around
// literal hyphens in path segments (a project dir named "pn-stealth" is
// indistinguishable from two segments "pn"/"stealth" once decoded) — this is
// only ever used as a fallback when the session header line is missing or
// malformed; the header's own `cwd` field always wins when present.
const DIR_ENCODED_RE = /^--(.+)--$/;
function decodeDirCwd(dirName) {
  const m = DIR_ENCODED_RE.exec(dirName);
  if (!m || !m[1]) return "";
  return "/" + m[1].replace(/-/g, "/");
}

// <iso-ish>_<uuid>.jsonl — pull the trailing uuid as a sessionId fallback for
// when the "session" header record is missing or fails to parse.
const FILENAME_UUID_RE = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
function sessionIdFromFilename(path) {
  const m = FILENAME_UUID_RE.exec(basename(path));
  return m ? m[1] : basename(path, ".jsonl");
}

const EMPTY = (root) => ({
  source: "pi",
  root: root || null,
  files: [],
  sessions: [],
  compactionSummaries: [],
  redaction: { hits: 0, charsRemoved: 0 },
  stats: { malformedLines: 0, projectDirCount: 0 },
});

export function readPi(root) {
  if (!root || !existsSync(root)) return EMPTY(root);

  const files = [];
  const sessions = [];
  let redactionHits = 0;
  let redactedChars = 0;
  const compactionSummaries = [];
  let malformedLinesTotal = 0;
  const projectDirs = new Set();

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

    const dirName = basename(dirname(path));
    projectDirs.add(dirName);

    const session = {
      source: "pi",
      sessionId: sessionIdFromFilename(path),
      projectLabel: "project-unknown",
      cwdRedacted: "",
      cwdRaw: "", // local-only; never sent in the bundle
      gitBranch: null, // pi does not record the branch
      cliVersions: new Set(),
      models: new Set(),
      messages: [],
      chain: [], // {uuid, parentUuid, ts}
      firstTs: null,
      lastTs: null,
    };

    let currentModel = null;

    const stampSessionTs = (ts) => {
      if (!ts) return;
      if (!session.firstTs || ts < session.firstTs) session.firstTs = ts;
      if (!session.lastTs || ts > session.lastTs) session.lastTs = ts;
    };

    const setCwd = (cwd) => {
      if (!cwd) return;
      session.cwdRaw = cwd;
      session.cwdRedacted = toPosix(redactText(cwd));
      session.projectLabel = `project-${shortHash(cwd)}`;
    };

    // Emit one normalized message per record — no turn synthesis. uuid/
    // parentUuid/ts come straight from the record's own id/parentId/
    // timestamp (already ISO).
    const emit = (role, r, text, extra = {}) => {
      const ts = typeof r.timestamp === "string" ? r.timestamp : null;
      const uuid = r.id;
      const parentUuid = r.parentId ?? null;

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

    for (const r of records) {
      if (!r || typeof r !== "object") continue;

      switch (r.type) {
        case "session": {
          if (r.id) session.sessionId = r.id;
          if (r.version != null) session.cliVersions.add(String(r.version));
          setCwd(r.cwd);
          if (typeof r.timestamp === "string") stampSessionTs(r.timestamp);
          break;
        }
        case "model_change": {
          if (r.provider && r.modelId) {
            // The privacy-critical line: modelId can be a full local
            // filesystem path for local models (mlx-local et al.) — redact
            // it exactly like a cwd before it ever lands in session.models
            // or an assistant message's `model` field.
            currentModel = `${r.provider}/${redactText(String(r.modelId))}`;
            session.models.add(currentModel);
          }
          if (typeof r.timestamp === "string") stampSessionTs(r.timestamp);
          break;
        }
        case "thinking_level_change":
          break; // no structural content worth capturing
        case "compaction": {
          const summary = typeof r.summary === "string" ? r.summary : "";
          redactionHits += countRedactions(summary);
          const redacted = redactText(summary);
          redactedChars += summary.length - redacted.length;
          if (redacted.length > COMPACTION_MIN_LEN) compactionSummaries.push(redacted.slice(0, COMPACTION_MAX_LEN));
          if (typeof r.timestamp === "string") stampSessionTs(r.timestamp);
          break;
        }
        case "message": {
          const m = r.message;
          if (!m || typeof m !== "object") break;
          if (m.role === "user") {
            emit("user", r, extractUserText(m.content));
          } else if (m.role === "assistant") {
            const { text, thinkingChars, signatureChars, toolUses } = reduceAssistantContent(m.content);
            emit("assistant", r, text, { thinkingChars, signatureChars, toolUses, usage: buildUsage(m.usage) });
          } else if (m.role === "toolResult") {
            const bytes = toolResultBytes(m.content);
            emit("toolResult", r, "", { toolResults: [{ forId: m.toolCallId, isError: !!m.isError, bytes }] });
          }
          // any other message.role: ignore, forward-compat
          break;
        }
        default:
          break; // unknown record types: ignore, count nothing (forward compat)
      }
    }

    // Dir-name decode fallback: only when the session header never supplied
    // a cwd (missing/malformed header line). The header always wins when
    // present, even if the directory encodes a different path.
    if (!session.cwdRaw) {
      const decoded = decodeDirCwd(dirName);
      if (decoded) setCwd(decoded);
    }

    files.push({ relPath, sha256: sha256(buf), bytes: statSync(path).size, lines: lines.length, malformed });
    sessions.push({ ...session, cliVersions: [...session.cliVersions], models: [...session.models] });
  }

  return {
    source: "pi",
    root,
    files,
    sessions,
    compactionSummaries,
    redaction: { hits: redactionHits, charsRemoved: redactedChars },
    stats: { malformedLines: malformedLinesTotal, projectDirCount: projectDirs.size },
  };
}

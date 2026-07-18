// cursor-agent adapter: reads Cursor's per-session SQLite blob-DAG
// (~/.cursor/chats/<32hex>/<session-uuid>/store.db, one db per session) and
// normalises it into the SAME session model claude-code.mjs, opencode.mjs,
// codex.mjs and pi.mjs produce, so every downstream lens (digest, agentic-
// literacy, forensics, fingerprint, intensity, distribution) keeps working
// unchanged. `cursor-agent -p`/`--print` is already recognised by digest.mjs's
// AGENT_LAUNCHER_RE — this adapter is pure log-reading, no digest changes.
//
// This is the most structurally involved adapter in the repo. Two things
// make it unlike anything else here:
//
//   1. Storage is a content-addressed BLOB DAG, not a log. `meta(key, value)`
//      holds one row — value is HEX-ENCODED UTF-8 JSON — carrying the session
//      id, a `latestRootBlobId` pointer, and (never stored downstream) a
//      model-generated title. `blobs(id, data)` is content-addressed: id =
//      sha256(data) hex. A blob is either a JSON message ({"role": ...},
//      first byte 0x7B) or a small hand-rolled protobuf message (anything
//      else). The ONLY thing we walk the protobuf for is the root blob
//      pointed to by latestRootBlobId, and from it we take exactly three
//      fields: field 1 (repeated 32-byte hashes, IN ORDER — this is the
//      entire conversation ordering; there is no other index), field 9 (cwd,
//      as a file:// URI), and field 26 (a last-updated epoch-ms varint).
//      Every other field in the root message (workspace-file references,
//      rule/tool metadata, timezone...) is structurally present but
//      deliberately unread — the brief that drove this adapter verified
//      those against a real session and none of them carry conversation
//      content we need. The message blobs themselves are then walked in
//      field-1 order and classified purely by their `role`.
//
//   2. The db is LIVE — cursor-agent keeps writing to it (WAL mode) for the
//      lifetime of the session. Opening it directly, even read-only, races a
//      concurrent writer and node:sqlite's read-only mode does not itself
//      guarantee a consistent snapshot of a growing WAL file. So every read
//      COPIES the trio (store.db, -wal, -shm — wal/shm may not exist, copy
//      whatever is there) into a throwaway mkdtemp() dir first and only ever
//      opens THAT copy, read-only, cleaning it up in a finally. This is the
//      one adapter in the repo where "copy before read" is load-bearing, not
//      just tidy.
//
// Privacy / exclusions, all deliberate:
//   - meta.name (the model-generated conversation title) is NEVER stored —
//     same precedent set for kimi's title/lastPrompt fields elsewhere in this
//     repo. A title is a dense free-text summary of exactly what the human
//     was doing; that's precisely the kind of thing this tool structurally
//     avoids capturing.
//   - Only `~/.cursor/chats/<hex>/<uuid>/store.db(+wal,+shm)` is ever opened.
//     `~/.cursor/prompt_history.json` (raw global prompt history outside any
//     session), `cli-config.json`, `projects/`, and any local sockets are
//     never resolved or read — chats/ is the only subtree this adapter walks.
//   - Tool call/result payloads follow the same structural-capture posture as
//     every other adapter: Write's `contents`, StrReplace-style old/new text,
//     and tool-result `result`/`experimental_content` bodies are never
//     stored — only paths, truncated commands/queries, and byte counts.
//   - Reasoning `text` is empty in every real blob observed; its `signature`
//     (an opaque provider blob, not reasoning content) is reduced to a
//     length, exactly like Claude Code's redacted-thinking signature and
//     codex's encrypted_content.
//
// Timestamp honesty: cursor stores NO per-message timestamp. The only
// timestamps that exist are meta.createdAt (session creation) and the root
// blob's field 26 (last-updated), plus a human-readable
// "<timestamp>Saturday, Jul 18, 2026, 6:16 AM (UTC)</timestamp>" tag Cursor's
// own framework wrapper injects into EVERY <user_query> turn. We parse that
// tag (tolerantly — day-name and the "(UTC)" suffix aren't ISO) as the one
// real per-turn clock signal we have; every assistant/tool message in
// between inherits the most recent parsed user timestamp; the very first
// emitted message falls back to meta.createdAt. This means duration signals
// derived from cursor sessions are coarse — accurate to the user-turn
// granularity, not to individual assistant/tool steps — and that coarseness
// is a property of the source format, not a shortcut taken here.
//
// Usage: cursor persists NO per-message token usage anywhere in the blob DAG
// (grep-verified across every blob in a real session) — every message's
// `usage` is null, never invented from a context-budget snapshot.
//
// Version-gate warning: this is an UNDOCUMENTED internal format with no
// stability guarantee across cursor-agent releases (confirmed against
// v2026.07.16 on this machine). The adapter's only defense is shape-checking
// at every step — missing tables/rows/fields, malformed JSON, an unopenable
// copy, or an unrecognised protobuf wire type all degrade to "skip and
// count in stats", never throw.

import { readdirSync, readFileSync, existsSync, mkdtempSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { redactText, countRedactions } from "../redact.mjs";
import { toPosix } from "./claude-code.mjs";
import { fallbackToolName } from "./tool-vocab.mjs";

const require = createRequire(import.meta.url);
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const shortHash = (s) => sha256(s).slice(0, 8);
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

// node:sqlite is experimental and only present on Node >= 22.5 (same gate as
// opencode.mjs). Unlike opencode there is no JSON fallback for cursor — the
// blob DAG has no other on-disk representation — so Node < 22.5 yields an
// EMPTY bundle with stats.backend: null, and the sources block discloses it.
function loadSqlite() {
  try {
    return require("node:sqlite");
  } catch {
    return null;
  }
}

// ── Default location ────────────────────────────────────────────────────────
// cursor-agent documents no env-var override for the chats root (unlike
// CODEX_HOME); ~/.cursor/chats is the only location observed. Only THIS
// subdirectory is ever walked — see the header comment for what's excluded.
export function defaultCursorRoot() {
  return join(homedir(), ".cursor", "chats");
}

// ── Tool vocabulary: cursor → canonical (Claude Code) names ─────────────────
// Cursor's own toolName strings are already close to canonical (Read, Write,
// Grep, Glob, TodoWrite all pass through fallbackToolName unchanged) — only
// "Shell" needs an explicit rewrite to "Bash". "StrReplace" (cursor's
// string-replace edit tool, grep-confirmed in a real session's blob DAG) is
// mapped to "Edit" so it lands in digest.mjs's MUTATION set — unmapped it
// fell through fallbackToolName unchanged and cursor sessions editing files
// exclusively via StrReplace read as zero-mutation and got misclassified.
// Its path arg lives under the already-covered `path` key (confirmed against
// the real blob: keys are old_string/new_string/path — old_string/new_string
// are never read by buildToolUse's known-key list, see below). Anything not
// in this table (including tools not yet observed) falls through to the same
// shared fallback every other adapter uses.
const TOOL_MAP = { Shell: "Bash", StrReplace: "Edit" };
function mapTool(name) {
  if (!name) return name;
  if (TOOL_MAP[name]) return TOOL_MAP[name];
  return fallbackToolName(name);
}

// tool-call args -> {path, cmd, q}, generic across tools (mirrors opencode's
// reduceParts): path/cmd/q are pulled from known-safe argument keys only.
// Write's `contents` and a StrReplace-style call's old_string/new_string are
// never read here, so they can never leak into the bundle no matter what
// unmapped tool names show up in future cursor-agent releases.
function buildToolUse(id, name, rawArgs) {
  const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? rawArgs : {};
  const mapped = mapTool(name);
  const path = toPosix(redactText(String(args.path || args.file_path || args.filePath || "")));
  const cmd = mapped === "Bash" ? redactText(String(args.command || "").slice(0, 240)) : "";
  const q = redactText(String(args.pattern || args.glob_pattern || args.query || args.url || "").slice(0, 200));
  return { id, name: mapped, path, cmd, q };
}

// A tool-result part's isError lives under providerOptions.cursor — checked
// first on the part itself, then (since real data shows it living there
// instead) on the enclosing message's own providerOptions. Absent either way
// defaults to false, same posture as every other adapter's isError guard.
function resultIsError(part, message) {
  if (part && part.providerOptions && part.providerOptions.cursor && part.providerOptions.cursor.highLevelToolCallResult) {
    if (part.providerOptions.cursor.highLevelToolCallResult.isError === true) return true;
  }
  if (message && message.providerOptions && message.providerOptions.cursor && message.providerOptions.cursor.highLevelToolCallResult) {
    return message.providerOptions.cursor.highLevelToolCallResult.isError === true;
  }
  return false;
}

// ── Minimal hand-rolled protobuf walker (zero deps, per repo rule) ─────────
// Reads tag/value pairs from a buffer without any schema: fieldNo = tag >> 3,
// wireType = tag & 7. wt0 (varint) and wt2 (length-delimited bytes) are kept;
// wt5 (32-bit) and wt1 (64-bit) are skipped by their fixed width; any other
// wire type means we've lost sync (or hit a shape we don't understand) and we
// bail, returning whatever was parsed so far — callers treat a missing field
// as simply absent, never as an error. Varint values are accumulated with
// BigInt (a field like the epoch-ms timestamp routinely exceeds 2^32) and
// only narrowed to Number at the end.
function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  let i = pos;
  while (i < buf.length) {
    const byte = buf[i++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
    if (shift > 70n) return { value: 0n, next: pos, ok: false }; // runaway varint: bail
  }
  return { value: result, next: i, ok: true };
}

export function pbFields(buf) {
  const fields = new Map();
  const push = (fieldNo, value) => {
    if (!fields.has(fieldNo)) fields.set(fieldNo, []);
    fields.get(fieldNo).push(value);
  };
  let i = 0;
  while (i < buf.length) {
    const tagRes = readVarint(buf, i);
    if (!tagRes.ok || tagRes.next === i) break;
    const tag = Number(tagRes.value);
    i = tagRes.next;
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (wireType === 0) {
      const v = readVarint(buf, i);
      if (!v.ok) break;
      i = v.next;
      push(fieldNo, Number(v.value));
    } else if (wireType === 2) {
      const l = readVarint(buf, i);
      if (!l.ok) break;
      const len = Number(l.value);
      if (len < 0 || l.next + len > buf.length) break; // malformed length: bail
      push(fieldNo, buf.subarray(l.next, l.next + len));
      i = l.next + len;
    } else if (wireType === 5) {
      i += 4;
    } else if (wireType === 1) {
      i += 8;
    } else {
      break; // unrecognised wire type: bail, return what was parsed
    }
  }
  return fields;
}

// "<timestamp>Saturday, Jul 18, 2026, 6:16 AM (UTC)</timestamp>" -> ISO, or
// null when absent/unparseable. Tolerant: strips the leading day name (not
// part of any Date-parseable format) and turns the "(UTC)" suffix into a
// bare "UTC" the platform Date parser understands.
const TIMESTAMP_TAG_RE = /<timestamp>([^<]*)<\/timestamp>/;
function parseWrapperTimestamp(text) {
  const m = TIMESTAMP_TAG_RE.exec(text);
  if (!m) return null;
  const cleaned = m[1].trim().replace(/^[A-Za-z]+,\s*/, "").replace(/\(UTC\)/, "UTC");
  const ms = Date.parse(cleaned);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// "<user_query>\n...\n</user_query>" -> inner text, or null when the tag is
// absent from this block (a pure framework-wrapper block with no real query).
const USER_QUERY_RE = /<user_query>([\s\S]*?)<\/user_query>/;
function extractUserQuery(text) {
  const m = USER_QUERY_RE.exec(text);
  return m ? m[1].trim() : null;
}

// Two-level scan: <root>/<hex-dir>/<uuid-dir>/store.db. We do NOT validate
// the hex-dir name against md5(cwd) — the brief that drove this adapter
// confirmed real cwd comes from inside the db (root blob field 9), not from
// this directory name, so treating the name as anything but an opaque path
// segment would be relying on an assumption cursor-agent never promised to
// keep. Anything unreadable (permissions, a stray file where a dir is
// expected) is skipped rather than thrown.
function discoverSessions(root) {
  const out = [];
  let level1;
  try {
    level1 = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d1 of level1) {
    if (!d1.isDirectory()) continue;
    let level2;
    try {
      level2 = readdirSync(join(root, d1.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d2 of level2) {
      if (!d2.isDirectory()) continue;
      const dbPath = join(root, d1.name, d2.name, "store.db");
      if (existsSync(dbPath)) out.push({ hexDir: d1.name, uuidDir: d2.name, dbPath });
    }
  }
  return out;
}

// Push one normalised message. usage is always null (see header comment —
// cursor persists no per-message token usage anywhere in the blob DAG).
function emit(session, acc, { role, ts, uuid, parentUuid, text, toolUses, toolResults, thinkingChars, signatureChars, model }) {
  acc.redactionHits += countRedactions(text);
  const textRedacted = redactText(text);
  acc.redactedChars += text.length - textRedacted.length;
  session.messages.push({
    role,
    ts,
    uuid,
    parentUuid,
    model: model || null,
    textRedacted,
    textLen: text.length,
    thinkingChars: thinkingChars || 0,
    signatureChars: signatureChars || 0,
    toolUses: toolUses || [],
    toolResults: toolResults || [],
    usage: null,
  });
  session.chain.push({ uuid, parentUuid, ts });
}

// Copy the trio, open the COPY read-only, reconstruct one session. Any
// failure anywhere in here (bad meta, missing/garbage root blob, an
// unopenable copy) propagates to the caller, which counts it in
// stats.unreadableSessions and moves on — this function never partially
// mutates caller state on failure.
function readSession(dbPath, hexDir, uuidDir, sqlite, acc) {
  const tmpDir = mkdtempSync(join(tmpdir(), "cursor-"));
  try {
    const copiedDb = join(tmpDir, "store.db");
    copyFileSync(dbPath, copiedDb);
    for (const suffix of ["-wal", "-shm"]) {
      const src = dbPath + suffix;
      if (existsSync(src)) copyFileSync(src, copiedDb + suffix);
    }

    const db = new sqlite.DatabaseSync(copiedDb, { readOnly: true });
    try {
      const metaRow = db.prepare("SELECT value FROM meta LIMIT 1").get();
      if (!metaRow || typeof metaRow.value !== "string") throw new Error("cursor: no meta row");
      const metaJson = JSON.parse(Buffer.from(metaRow.value, "hex").toString("utf8"));
      const sessionId = metaJson.agentId;
      if (!sessionId) throw new Error("cursor: meta missing agentId");
      const createdAtIso = iso(metaJson.createdAt);
      // meta.name is the model-generated conversation title — see header
      // comment. It is read here only to confirm it exists, NEVER assigned
      // to anything that ends up in the session object.

      const blobStmt = db.prepare("SELECT data FROM blobs WHERE id = ?");
      const rootHash = metaJson.latestRootBlobId;
      if (!rootHash) throw new Error("cursor: meta missing latestRootBlobId");
      const rootRow = blobStmt.get(rootHash);
      if (!rootRow) throw new Error("cursor: root blob missing");
      const rootBuf = Buffer.from(rootRow.data);
      const rootFields = pbFields(rootBuf);

      const msgHashes = (rootFields.get(1) || []).map((b) => Buffer.from(b));

      let cwdRaw = "";
      const cwdField = rootFields.get(9);
      if (cwdField && cwdField[0]) {
        const raw = Buffer.from(cwdField[0]).toString("utf8");
        const stripped = raw.replace(/^file:\/\//, "");
        try {
          cwdRaw = decodeURIComponent(stripped);
        } catch {
          cwdRaw = stripped; // malformed % escape: keep the raw (still usable) path
        }
      }

      const originatorField = rootFields.get(22);
      const originator = originatorField && originatorField[0] ? Buffer.from(originatorField[0]).toString("utf8") : null;

      const updatedField = rootFields.get(26);
      const lastUpdatedIso = updatedField && Number.isFinite(updatedField[0]) ? iso(updatedField[0]) : null;

      const session = {
        source: "cursor",
        sessionId,
        projectLabel: cwdRaw ? `project-${shortHash(cwdRaw)}` : "project-unknown",
        cwdRedacted: toPosix(redactText(cwdRaw)),
        cwdRaw, // local-only; never sent in the bundle
        gitBranch: null, // cursor does not record the branch in the fields we read
        cliVersions: [], // no per-session app version lives in the fields this adapter reads
        models: new Set(),
        messages: [],
        chain: [], // {uuid, parentUuid, ts}
        firstTs: createdAtIso,
        lastTs: null,
      };

      let currentTs = createdAtIso;
      let prevUuid = null;
      let emittedIdx = 0;
      let malformed = 0;

      for (const hashBuf of msgHashes) {
        const row = blobStmt.get(hashBuf.toString("hex"));
        if (!row) continue; // root references a blob this copy doesn't have: skip, don't throw
        const raw = Buffer.from(row.data);
        if (raw[0] !== 0x7b) continue; // not a JSON message blob (defensive; field 1 should only hold those)
        let obj;
        try {
          obj = JSON.parse(raw.toString("utf8"));
        } catch {
          malformed++;
          continue;
        }
        if (!obj || typeof obj !== "object") continue;

        const role = obj.role;
        if (role === "system") continue; // framework system prompt: drop entirely

        if (role === "user") {
          const content = obj.content;
          if (typeof content === "string") continue; // framework-injected <user_info> turn: drop
          if (!Array.isArray(content)) continue;
          let text = "";
          let parsedTs = null;
          for (const block of content) {
            if (!block || block.type !== "text" || typeof block.text !== "string") continue;
            if (!parsedTs) {
              const t = parseWrapperTimestamp(block.text);
              if (t) parsedTs = t;
            }
            const q = extractUserQuery(block.text);
            if (q !== null) text += q + "\n";
          }
          if (!text.trim()) continue; // every block was framework-wrapped (or none survived): drop the message
          if (parsedTs) currentTs = parsedTs;
          const uuid = `${sessionId}-m${emittedIdx}`;
          const parentUuid = prevUuid;
          emit(session, acc, { role: "user", ts: currentTs, uuid, parentUuid, text, toolUses: [], toolResults: [] });
          prevUuid = uuid;
          emittedIdx++;
          continue;
        }

        if (role === "assistant") {
          const content = Array.isArray(obj.content) ? obj.content : [];
          let text = "";
          let thinkingChars = 0;
          let signatureChars = 0;
          let model = null;
          const toolUses = [];
          for (const part of content) {
            if (!part || typeof part !== "object") continue;
            if (part.type === "reasoning") {
              thinkingChars += (part.text || "").length;
              signatureChars += (part.signature || "").length;
              const m = part.providerOptions && part.providerOptions.cursor && part.providerOptions.cursor.modelName;
              if (m) model = m;
            } else if (part.type === "text") {
              text += (part.text || "") + "\n";
            } else if (part.type === "tool-call") {
              toolUses.push(buildToolUse(part.toolCallId, part.toolName, part.args));
            }
          }
          if (model) session.models.add(model);
          const uuid = `${sessionId}-m${emittedIdx}`;
          const parentUuid = prevUuid;
          emit(session, acc, { role: "assistant", ts: currentTs, uuid, parentUuid, text, toolUses, toolResults: [], thinkingChars, signatureChars, model });
          prevUuid = uuid;
          emittedIdx++;
          continue;
        }

        if (role === "tool") {
          const content = Array.isArray(obj.content) ? obj.content : [];
          const toolResults = [];
          for (const part of content) {
            if (!part || part.type !== "tool-result") continue;
            toolResults.push({
              forId: part.toolCallId,
              isError: resultIsError(part, obj),
              // Result content (part.result / experimental_content) is NEVER
              // stored — only its serialized byte length, per the brief's
              // exact rule.
              bytes: JSON.stringify(part.result ?? "").length,
            });
          }
          const uuid = `${sessionId}-m${emittedIdx}`;
          const parentUuid = prevUuid;
          emit(session, acc, { role: "tool", ts: currentTs, uuid, parentUuid, text: "", toolUses: [], toolResults });
          prevUuid = uuid;
          emittedIdx++;
          continue;
        }
        // Any other role: unrecognised shape, skip without counting — forward-compat.
      }

      session.lastTs = lastUpdatedIso || (session.messages.length ? session.messages[session.messages.length - 1].ts : createdAtIso);

      if (originator) acc.originatorCounts[originator] = (acc.originatorCounts[originator] || 0) + 1;

      const dbBuf = readFileSync(copiedDb);
      const file = {
        relPath: `${hexDir}/${uuidDir}/store.db`,
        sha256: sha256(dbBuf),
        bytes: dbBuf.length,
        lines: 0, // not line-oriented; malformed carries the JSON-blob parse-failure count instead
        malformed,
      };

      return { session: { ...session, models: [...session.models] }, file };
    } finally {
      // Cleanup must never turn a successful read into a thrown error — a
      // close/rm failure here would otherwise supersede a pending `return`
      // (finally-block semantics) and wrongly count a GOOD session as
      // unreadable.
      try {
        db.close();
      } catch {
        // no-op
      }
    }
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // no-op: best-effort temp-dir cleanup, never lets a successful read fail
    }
  }
}

const EMPTY = (root) => ({
  source: "cursor",
  root: root || null,
  files: [],
  sessions: [],
  compactionSummaries: [], // cursor has no compaction-summary convention to mine
  redaction: { hits: 0, charsRemoved: 0 },
  stats: { unreadableSessions: 0, originatorCounts: {}, backend: null },
});

export function readCursor(root = defaultCursorRoot()) {
  if (!root || !existsSync(root)) return EMPTY(root);
  const sqlite = loadSqlite();
  if (!sqlite) return EMPTY(root); // Node < 22.5: no JSON fallback exists for this format

  const acc = { redactionHits: 0, redactedChars: 0, unreadableSessions: 0, originatorCounts: {} };
  const sessions = [];
  const files = [];

  for (const { hexDir, uuidDir, dbPath } of discoverSessions(root)) {
    try {
      const { session, file } = readSession(dbPath, hexDir, uuidDir, sqlite, acc);
      sessions.push(session);
      files.push(file);
    } catch {
      // Bad meta, missing/garbage root blob, or an unopenable copy (e.g. a
      // store.db that isn't a valid sqlite file): skip this session, disclose
      // the count, never throw out of the adapter.
      acc.unreadableSessions++;
    }
  }

  return {
    source: "cursor",
    root,
    files,
    sessions,
    compactionSummaries: [],
    redaction: { hits: acc.redactionHits, charsRemoved: acc.redactedChars },
    stats: { unreadableSessions: acc.unreadableSessions, originatorCounts: acc.originatorCounts, backend: "sqlite" },
  };
}

// Claude Code adapter: reads ~/.claude/projects/**/*.jsonl and normalises it
// into the shared session model consumed by fingerprint.mjs / forensics.mjs.
//
// Hashing runs on the RAW bytes (provenance manifest). Redaction of text runs
// here too, but only on human-readable fields — never on the structural fields
// the forensics depend on (timestamps, uuids, token usage).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { redactText, countRedactions } from "../redact.mjs";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const shortHash = (s) => sha256(s).slice(0, 8);

// Canonicalise paths to POSIX separators. The path-based analysis downstream
// (repo clustering in digest.mjs, area extraction, skill/agent detection in
// agentic-literacy.mjs) is written against "/"; on Windows the logged paths
// use "\", so without this every path regex silently misses. cwdRaw is left
// untouched — it stays the real OS path used for local filesystem access.
export const toPosix = (s) => (typeof s === "string" ? s.replace(/\\/g, "/") : s);

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield full;
  }
}

/** Pull the readable text out of a message.content that may be string or block array. */
function extractContent(content) {
  const toolUses = [];
  const toolResults = [];
  let text = "";
  let thinkingChars = 0;
  let signatureChars = 0;

  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    for (const b of content) {
      if (!b || typeof b !== "object") continue;
      switch (b.type) {
        case "text":
          text += (b.text || "") + "\n";
          break;
        case "thinking":
          // Redacted thinking exposes only a signature; use its length as a
          // reasoning-depth proxy when the thinking text itself is withheld.
          thinkingChars += (b.thinking || "").length;
          signatureChars += (b.signature || "").length;
          break;
        case "tool_use": {
          const inp = b.input || {};
          toolUses.push({
            id: b.id,
            name: b.name,
            path: toPosix(redactText(inp.file_path || inp.path || "")),
            cmd: b.name === "Bash" ? redactText(String(inp.command || "").slice(0, 240)) : "",
            q: redactText(String(inp.query || inp.url || "").slice(0, 200)),
          });
          break;
        }
        case "tool_result": {
          const c = b.content;
          const bytes =
            typeof c === "string"
              ? c.length
              : Array.isArray(c)
                ? c.reduce((n, x) => n + (x?.text?.length || 0), 0)
                : 0;
          toolResults.push({ forId: b.tool_use_id, isError: !!b.is_error, bytes });
          break;
        }
      }
    }
  }
  return { text, thinkingChars, signatureChars, toolUses, toolResults };
}

export function readClaudeCode(root) {
  const files = [];
  const records = [];

  for (const path of walk(root)) {
    const buf = readFileSync(path);
    const lines = buf.toString("utf8").split("\n").filter((l) => l.trim());
    let malformed = 0;
    const parsed = [];
    for (const line of lines) {
      try {
        parsed.push(JSON.parse(line));
      } catch {
        malformed++;
      }
    }
    const relPath = relative(root, path);
    files.push({
      relPath,
      sha256: sha256(buf),
      bytes: statSync(path).size,
      lines: lines.length,
      malformed,
    });
    for (const r of parsed) records.push({ ...r, _file: relPath });
  }

  // Group into sessions.
  const sessions = new Map();
  let redactionHits = 0;
  let redactedChars = 0;
  // Compaction summaries: when Claude Code asks the model to summarise the
  // session, the assistant reply is a dense self-portrait of how that work
  // went. We collect them here for the narrative step.
  const compactionSummaries = [];
  let lastUserWasCompactionRequest = false;

  for (const r of records) {
    const sid = r.sessionId;
    if (!sid) continue;
    if (!sessions.has(sid)) {
      sessions.set(sid, {
        source: "claude-code",
        sessionId: sid,
        projectLabel: r.cwd ? `project-${shortHash(r.cwd)}` : "project-unknown",
        cwdRedacted: toPosix(redactText(r.cwd || "")),
        cwdRaw: r.cwd || "", // local-only, for repo enrichment; never sent in the bundle

        gitBranch: r.gitBranch,
        cliVersions: new Set(),
        models: new Set(),
        messages: [],
        chain: [], // {uuid, parentUuid, ts}
        firstTs: null,
        lastTs: null,
      });
    }
    const s = sessions.get(sid);
    if (r.version) s.cliVersions.add(r.version);
    if (r.timestamp) {
      if (!s.firstTs || r.timestamp < s.firstTs) s.firstTs = r.timestamp;
      if (!s.lastTs || r.timestamp > s.lastTs) s.lastTs = r.timestamp;
    }
    // Backfill cwd from later records: many session-opening records
    // (permission-mode, file-history-snapshot, summaries) carry no cwd, so
    // the first message wins only if it actually has one. Without this fix
    // sessions cluster as "unknown".
    if (!s.cwdRaw && r.cwd) {
      s.cwdRaw = r.cwd;
      s.cwdRedacted = toPosix(redactText(r.cwd));
      s.projectLabel = `project-${shortHash(r.cwd)}`;
    }
    if (!s.gitBranch && r.gitBranch) s.gitBranch = r.gitBranch;
    if (r.uuid) s.chain.push({ uuid: r.uuid, parentUuid: r.parentUuid ?? null, ts: r.timestamp });

    if ((r.type === "user" || r.type === "assistant") && r.message && typeof r.message === "object") {
      const m = r.message;
      if (m.model && m.model !== "<synthetic>") s.models.add(m.model);
      const { text, thinkingChars, signatureChars, toolUses, toolResults } = extractContent(m.content);
      redactionHits += countRedactions(text);
      const textRedacted = redactText(text);
      redactedChars += text.length - textRedacted.length;

      // Catch compaction summaries: a user prompt that asks for a session
      // summary followed by the assistant's reply. Already redacted.
      if (r.type === "user" && /Your task is to create a detailed summary of the conversation/i.test(text)) {
        lastUserWasCompactionRequest = true;
      } else if (r.type === "assistant" && lastUserWasCompactionRequest) {
        if (textRedacted.length > 200) compactionSummaries.push(textRedacted.slice(0, 3000));
        lastUserWasCompactionRequest = false;
      } else if (r.type === "user") {
        lastUserWasCompactionRequest = false;
      }
      s.messages.push({
        role: r.type,
        ts: r.timestamp,
        uuid: r.uuid,
        parentUuid: r.parentUuid ?? null,
        model: m.model || null,
        messageId: m.id || null,
        requestId: r.requestId || null,
        textRedacted,
        textLen: text.length,
        thinkingChars,
        signatureChars,
        toolUses,
        toolResults,
        usage: m.usage
          ? {
              input: m.usage.input_tokens || 0,
              output: m.usage.output_tokens || 0,
              cacheRead: m.usage.cache_read_input_tokens || 0,
              cacheCreate: m.usage.cache_creation_input_tokens || 0,
            }
          : null,
      });
    }
  }

  const sessionList = [...sessions.values()].map((s) => ({
    ...s,
    cliVersions: [...s.cliVersions],
    models: [...s.models],
  }));

  return {
    source: "claude-code",
    root,
    files,
    sessions: sessionList,
    compactionSummaries,
    redaction: { hits: redactionHits, charsRemoved: redactedChars },
  };
}

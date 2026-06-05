// opencode adapter: reads opencode's JSON storage and normalises it into the
// SAME session model that claude-code.mjs produces, so every downstream lens
// (digest, agentic-literacy, forensics, fingerprint, intensity, distribution)
// consumes it unchanged.
//
// opencode lays its data out as three file trees under <storage>/:
//   session/<projectID>/ses_*.json        — one file per session
//   message/<sessionID>/msg_*.json         — one file per message
//   part/<messageID>/prt_*.json            — message parts (text, reasoning,
//                                            tool calls, step-finish, compaction)
// Tool calls, text, reasoning and token usage all live in the PARTS, so a
// message is reconstructed by joining its message file with its parts.
//
// Two translations make the shared model work:
//   1. Vocabulary — opencode tool names are lowercase ("edit", "bash", "task")
//      and MCP tools are "server_tool"; we map them onto the canonical Claude
//      names ("Edit", "Bash", "Task") and "mcp__server__tool" so the existing
//      MUTATION/RESEARCH/DELEGATION sets and MCP classification just fire.
//   2. Timestamps — opencode stores epoch ms; downstream assumes ISO strings,
//      so we convert at the boundary.
//
// Privacy: tool OUTPUTS and assistant ERROR blobs (which carry URLs, headers,
// command output) are never stored — only byte counts, mirroring the Claude
// adapter. Reasoning text is reduced to a character count, never kept.

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { redactText, countRedactions } from "../redact.mjs";
import { toPosix } from "./claude-code.mjs";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const shortHash = (s) => sha256(s).slice(0, 8);
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

// ── Default storage location ───────────────────────────────────────────────
// opencode follows XDG even on Windows: ~/.local/share/opencode/storage.
// Honour OPENCODE_DATA / XDG_DATA_HOME, then fall back to the known spots.
export function defaultOpencodeRoot() {
  const candidates = [
    process.env.OPENCODE_DATA && join(process.env.OPENCODE_DATA, "storage"),
    process.env.XDG_DATA_HOME && join(process.env.XDG_DATA_HOME, "opencode", "storage"),
    join(homedir(), ".local", "share", "opencode", "storage"),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "opencode", "storage"),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) || null;
}

// ── Tool vocabulary: opencode → canonical (Claude Code) names ───────────────
const TOOL_MAP = {
  bash: "Bash", read: "Read", edit: "Edit", write: "Write", patch: "Edit",
  multiedit: "MultiEdit", glob: "Glob", grep: "Grep", list: "Read",
  webfetch: "WebFetch", websearch: "WebSearch", todowrite: "TodoWrite",
  todoread: "TodoRead", task: "Task", question: "AskUserQuestion",
};
function mapTool(name) {
  if (!name) return name;
  if (TOOL_MAP[name]) return TOOL_MAP[name];
  // Anything else with a "server_tool" shape is an MCP tool; rewrite to the
  // canonical mcp__server__tool so agentic-literacy's MCP detection lights up.
  const us = name.indexOf("_");
  if (us > 0) return `mcp__${name.slice(0, us)}__${name.slice(us + 1)}`;
  return name;
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const listFiles = (dir) =>
  existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".json")).map((e) => join(dir, e.name)) : [];

// Reduce a message's parts into the shared content shape.
function reduceParts(parts) {
  const toolUses = [];
  const toolResults = [];
  let text = "";
  let thinkingChars = 0;
  let isCompaction = false;
  let tokens = null;

  for (const b of parts) {
    switch (b.type) {
      case "text":
        if (typeof b.text === "string") text += b.text + "\n";
        break;
      case "reasoning":
        // Like Claude's redacted thinking: keep length as a depth proxy only.
        thinkingChars += (b.text || "").length;
        break;
      case "tool": {
        const inp = (b.state && b.state.input) || {};
        const out = b.state && typeof b.state.output === "string" ? b.state.output.length : 0;
        toolUses.push({
          id: b.callID || b.id,
          name: mapTool(b.tool),
          path: toPosix(redactText(inp.filePath || inp.file_path || inp.path || "")),
          cmd: b.tool === "bash" ? redactText(String(inp.command || "").slice(0, 240)) : "",
          q: redactText(String(inp.query || inp.url || inp.pattern || "").slice(0, 200)),
        });
        toolResults.push({ forId: b.callID || b.id, isError: b.state && b.state.status === "error", bytes: out });
        break;
      }
      case "step-finish":
        // Token usage lands on step-finish parts; sum across the message.
        if (b.tokens) {
          tokens ||= { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
          tokens.input += b.tokens.input || 0;
          tokens.output += b.tokens.output || 0;
          tokens.cacheRead += (b.tokens.cache && b.tokens.cache.read) || 0;
          tokens.cacheCreate += (b.tokens.cache && b.tokens.cache.write) || 0;
        }
        break;
      case "compaction":
        isCompaction = true;
        break;
    }
  }
  return { text, thinkingChars, toolUses, toolResults, isCompaction, tokens };
}

export function readOpencode(root = defaultOpencodeRoot()) {
  const empty = {
    source: "opencode", root: root || null, files: [], sessions: [],
    compactionSummaries: [], redaction: { hits: 0, charsRemoved: 0 },
  };
  if (!root || !existsSync(root)) return empty;

  const sessionDir = join(root, "session");
  const messageDir = join(root, "message");
  const partDir = join(root, "part");

  const files = [];
  const sessions = [];
  const byId = new Map(); // session id -> built session (for parent rollup)
  const compactionSummaries = [];
  let redactionHits = 0;
  let redactedChars = 0;

  // session files live one level down: session/<projectID>/ses_*.json
  const sessionFiles = [];
  if (existsSync(sessionDir)) {
    for (const e of readdirSync(sessionDir, { withFileTypes: true })) {
      if (e.isDirectory()) sessionFiles.push(...listFiles(join(sessionDir, e.name)));
      else if (e.isFile() && e.name.endsWith(".json")) sessionFiles.push(join(sessionDir, e.name));
    }
  }

  for (const sf of sessionFiles) {
    let info;
    try { info = readJson(sf); } catch { continue; }
    if (!info || !info.id) continue;

    const cwdRaw = info.directory || "";
    const cwdRedacted = toPosix(redactText(cwdRaw));
    const session = {
      source: "opencode",
      sessionId: info.id,
      parentId: info.parentID || null,
      projectLabel: cwdRaw ? `project-${shortHash(cwdRaw)}` : "project-unknown",
      cwdRedacted,
      cwdRaw, // local-only; never sent in the bundle
      gitBranch: null, // opencode does not record the branch
      cliVersions: info.version ? [info.version] : [],
      models: new Set(),
      messages: [],
      chain: [],
      firstTs: null,
      lastTs: null,
    };

    // Manifest: one provenance entry per session, covering the session file +
    // all of its message and part files (hash of the concatenated raw bytes).
    const chunks = [readFileSync(sf)];
    let recordCount = 0;
    let malformed = 0;

    const msgFiles = listFiles(join(messageDir, info.id)).sort();
    for (const mf of msgFiles) {
      let m;
      try { chunks.push(readFileSync(mf)); m = readJson(mf); recordCount++; }
      catch { malformed++; continue; }
      if (!m || (m.role !== "user" && m.role !== "assistant")) continue;

      const parts = [];
      for (const pf of listFiles(join(partDir, m.id)).sort()) {
        try { chunks.push(readFileSync(pf)); parts.push(readJson(pf)); recordCount++; }
        catch { malformed++; }
      }

      const { text, thinkingChars, toolUses, toolResults, isCompaction, tokens } = reduceParts(parts);
      const ts = iso(m.time && m.time.created);
      if (ts) {
        const t = Date.parse(ts);
        if (!session.firstTs || t < session.firstTs) session.firstTs = t;
        if (!session.lastTs || t > session.lastTs) session.lastTs = t;
      }
      const providerID = m.providerID || (m.model && m.model.providerID);
      const modelID = m.modelID || (m.model && m.model.modelID);
      const model = providerID && modelID ? `${providerID}/${modelID}` : null;
      if (model) session.models.add(model);

      redactionHits += countRedactions(text);
      const textRedacted = redactText(text);
      redactedChars += text.length - textRedacted.length;

      if (isCompaction && textRedacted.length > 200) compactionSummaries.push(textRedacted.slice(0, 3000));

      if (m.id) session.chain.push({ uuid: m.id, parentUuid: m.parentID ?? null, ts });

      session.messages.push({
        role: m.role,
        ts,
        uuid: m.id,
        parentUuid: m.parentID ?? null,
        model,
        messageId: m.id,
        requestId: null, // opencode has no per-request id
        textRedacted,
        textLen: text.length,
        thinkingChars,
        signatureChars: 0,
        toolUses,
        toolResults,
        usage: tokens || (m.tokens ? {
          input: m.tokens.input || 0,
          output: m.tokens.output || 0,
          cacheRead: (m.tokens.cache && m.tokens.cache.read) || 0,
          cacheCreate: (m.tokens.cache && m.tokens.cache.write) || 0,
        } : null),
      });
    }

    files.push({
      relPath: `opencode/session/${info.id}`,
      sha256: sha256(Buffer.concat(chunks)),
      bytes: chunks.reduce((n, c) => n + c.length, 0),
      lines: recordCount,
      malformed,
    });

    byId.set(session.sessionId, session);
    sessions.push(session);
  }

  // ── Within-opencode subagent rollup ───────────────────────────────────────
  // opencode spawns subagents (the `task` tool) as CHILD sessions linked by
  // parentID. Left alone they cluster as their own tiny "products", scattering
  // the orchestration. Re-point each child to its root ancestor's working dir
  // so the subagent work is attributed to the product that launched it. The
  // delegation COUNT is already carried by the parent's mapped `Task` calls.
  const rootCwd = (s, seen = new Set()) => {
    if (!s.parentId || seen.has(s.sessionId)) return s;
    seen.add(s.sessionId);
    const parent = byId.get(s.parentId);
    return parent ? rootCwd(parent, seen) : s;
  };
  let rolledUp = 0;
  for (const s of sessions) {
    if (!s.parentId) continue;
    const anc = rootCwd(s);
    if (anc !== s && anc.cwdRedacted && anc.cwdRedacted !== s.cwdRedacted) {
      s.cwdRedacted = anc.cwdRedacted;
      rolledUp++;
    }
  }

  const sessionList = sessions.map((s) => ({ ...s, models: [...s.models] }));

  return {
    source: "opencode",
    root,
    files,
    sessions: sessionList,
    compactionSummaries,
    redaction: { hits: redactionHits, charsRemoved: redactedChars },
    stats: { rolledUpSubagentSessions: rolledUp },
  };
}

// Merge two parsed sources (e.g. Claude Code + opencode) into one bundle. The
// per-repo clustering downstream then unifies sessions of the same product
// across tools automatically.
export function mergeSources(...parsedList) {
  const sources = parsedList.filter(Boolean);
  return {
    source: sources.map((p) => p.source).join("+") || "none",
    root: sources[0]?.root ?? null,
    files: sources.flatMap((p) => p.files ?? []),
    sessions: sources.flatMap((p) => p.sessions ?? []),
    compactionSummaries: sources.flatMap((p) => p.compactionSummaries ?? []),
    redaction: {
      hits: sources.reduce((n, p) => n + (p.redaction?.hits ?? 0), 0),
      charsRemoved: sources.reduce((n, p) => n + (p.redaction?.charsRemoved ?? 0), 0),
    },
  };
}

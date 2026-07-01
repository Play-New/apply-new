// opencode adapter: reads opencode's logs and normalises them into the SAME
// session model that claude-code.mjs produces, so every downstream lens
// (digest, agentic-literacy, forensics, fingerprint, intensity, distribution)
// consumes it unchanged.
//
// Two storage backends, both supported:
//   - sqlite (opencode.db): the authoritative, fuller store. Preferred when
//     node:sqlite is available (Node >= 22.5). One indexed read instead of
//     tens of thousands of file opens, and it retains more history than the
//     JSON cache.
//   - JSON files (storage/{session,message,part}/...): older/portable layout
//     and the fallback when node:sqlite is missing.
//
// Either way the shape is identical: session/<id> with messages reconstructed
// by joining each message with its parts (text, reasoning, tool calls,
// step-finish token usage, compaction markers).
//
// Two translations make the shared model work:
//   1. Vocabulary — opencode tool names are lowercase ("edit","bash","task")
//      and MCP tools are "server_tool"; mapped onto the canonical Claude names
//      ("Edit","Bash","Task") and "mcp__server__tool" so the MUTATION/RESEARCH/
//      DELEGATION sets and MCP classification just fire.
//   2. Timestamps — opencode stores epoch ms; converted to ISO at the boundary
//      because downstream assumes ISO.
//
// Privacy: tool OUTPUTS and assistant ERROR blobs (URLs, headers, command
// output) are never stored — only byte counts, mirroring the Claude adapter.
// Reasoning text is reduced to a character count, never kept.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { redactText, countRedactions } from "../redact.mjs";
import { toPosix } from "./claude-code.mjs";

const require = createRequire(import.meta.url);
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const shortHash = (s) => sha256(s).slice(0, 8);
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

// node:sqlite is experimental and only present on Node >= 22.5. Load it lazily
// so the adapter still imports (and the JSON path still works) on Node 20.
function loadSqlite() {
  try { return require("node:sqlite"); } catch { return null; }
}

// ── Default locations ───────────────────────────────────────────────────────
// opencode follows XDG even on Windows: ~/.local/share/opencode/{storage,opencode.db}.
export function defaultOpencodeRoot() {
  const candidates = [
    process.env.OPENCODE_DATA && join(process.env.OPENCODE_DATA, "storage"),
    process.env.XDG_DATA_HOME && join(process.env.XDG_DATA_HOME, "opencode", "storage"),
    join(homedir(), ".local", "share", "opencode", "storage"),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "opencode", "storage"),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) || null;
}
// The db sits beside the storage dir.
export function defaultOpencodeDb(root = defaultOpencodeRoot()) {
  if (!root) return null;
  const db = join(dirname(root), "opencode.db");
  return existsSync(db) ? db : null;
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

// Base session object from session info ({id, directory, parentID, version}).
function baseSession(info) {
  const cwdRaw = info.directory || "";
  return {
    source: "opencode",
    sessionId: info.id,
    parentId: info.parentID || null,
    projectLabel: cwdRaw ? `project-${shortHash(cwdRaw)}` : "project-unknown",
    cwdRedacted: toPosix(redactText(cwdRaw)),
    cwdRaw, // local-only; never sent in the bundle
    gitBranch: null, // opencode does not record the branch
    cliVersions: info.version ? [info.version] : [],
    models: new Set(),
    messages: [],
    chain: [],
    firstTs: null,
    lastTs: null,
  };
}

// Fold one message (already parsed) + its parts into a session, updating the
// shared accumulators (redaction stats, compaction summaries).
function ingestMessage(session, m, parts, acc) {
  if (!m || (m.role !== "user" && m.role !== "assistant")) return;
  const { text, thinkingChars, toolUses, toolResults, isCompaction, tokens } = reduceParts(parts);
  const ts = iso(m.time && m.time.created);
  if (ts) {
    // Store the ISO string, not the parsed epoch. Downstream lenses
    // (intensity.mjs, trajectory.mjs) call Date.parse(s.firstTs) and
    // expect an ISO string; epoch numbers coerce to "1748772000000" which
    // is not a valid ISO date and yields NaN, silently dropping the session.
    // ISO strings compare correctly lexicographically for the same format.
    if (!session.firstTs || ts < session.firstTs) session.firstTs = ts;
    if (!session.lastTs || ts > session.lastTs) session.lastTs = ts;
  }
  const providerID = m.providerID || (m.model && m.model.providerID);
  const modelID = m.modelID || (m.model && m.model.modelID);
  const model = providerID && modelID ? `${providerID}/${modelID}` : null;
  if (model) session.models.add(model);

  acc.redactionHits += countRedactions(text);
  const textRedacted = redactText(text);
  acc.redactedChars += text.length - textRedacted.length;
  if (isCompaction && textRedacted.length > 200) acc.compactionSummaries.push(textRedacted.slice(0, 3000));
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

// ── Within-opencode subagent rollup ────────────────────────────────────────
// opencode spawns subagents (the `task` tool) as CHILD sessions linked by
// parentID. Left alone they cluster as their own tiny "products", scattering
// the orchestration. Re-point each child to its root ancestor's working dir so
// the subagent work is attributed to the product that launched it. The
// delegation COUNT is already carried by the parent's mapped `Task` calls.
//
// Re-point ALL THREE project-identity fields together, not just cwdRedacted:
// digest clusters by cwdRedacted (repoKey) but fingerprint counts distinct
// projectLabel (= shortHash(cwdRaw)). If only cwdRedacted moves, the child
// folds into the parent product for the digest yet stays a separate project
// for the fingerprint — the two then disagree on the product count.
function applyRollup(sessions, byId) {
  const ancestor = (s, seen = new Set()) => {
    if (!s.parentId || seen.has(s.sessionId)) return s;
    seen.add(s.sessionId);
    const parent = byId.get(s.parentId);
    return parent ? ancestor(parent, seen) : s;
  };
  let rolledUp = 0;
  let orphaned = 0;
  for (const s of sessions) {
    if (!s.parentId) continue;
    const anc = ancestor(s);
    // Parent absent from the read set (a pruned/partial JSON cache can hold a
    // subagent child without its root): ancestor() returns the child itself, so
    // it can't roll up and stands as its own spurious "product", inflating the
    // count. We can't attribute it without the parent, so disclose it in stats
    // rather than let the over-count be silent.
    if (anc === s) { orphaned++; continue; }
    if (anc.cwdRedacted && anc.cwdRedacted !== s.cwdRedacted) {
      s.cwdRedacted = anc.cwdRedacted;
      s.cwdRaw = anc.cwdRaw;
      s.projectLabel = anc.projectLabel;
      rolledUp++;
    }
  }
  return { rolledUp, orphaned };
}

function finalize(root, sessions, files, acc, rolledUp, backend, orphaned = 0) {
  return {
    source: "opencode",
    root,
    files,
    sessions: sessions.map((s) => ({ ...s, models: [...s.models] })),
    compactionSummaries: acc.compactionSummaries,
    redaction: { hits: acc.redactionHits, charsRemoved: acc.redactedChars },
    // backend records WHICH read path produced this bundle ("sqlite" = the full
    // opencode.db, "json" = the partial JSON cache). It is the silent-fallback
    // disclosure hook: the JSON cache can hold far fewer sessions than the db,
    // so the user should see which one was read. summarizeSources surfaces it.
    stats: { rolledUpSubagentSessions: rolledUp, orphanedSubagentSessions: orphaned, backend },
  };
}

const EMPTY = (root) => ({
  source: "opencode", root: root || null, files: [], sessions: [],
  compactionSummaries: [], redaction: { hits: 0, charsRemoved: 0 },
  stats: { rolledUpSubagentSessions: 0, orphanedSubagentSessions: 0, backend: null },
});

// ── Backend: sqlite (preferred) ─────────────────────────────────────────────
// Walks one session at a time via the indexed message/part lookups, so memory
// stays bounded (the db can be >1 GB once full tool outputs are stored) and the
// provenance hash is taken over the RAW row bytes without re-serialising.
export function readOpencodeDb(dbPath = defaultOpencodeDb()) {
  if (!dbPath || !existsSync(dbPath)) return EMPTY(dbPath);
  const sqlite = loadSqlite();
  if (!sqlite) return EMPTY(dbPath);

  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    // ORDER BY id: without it SQLite returns rows in physical/rowid order, which
    // is not stable across machines (or after VACUUM / row deletion). Session
    // emission order feeds the digest's Map-insertion order, which is the
    // tie-break for representative selection on equal-significance products — so
    // an unordered read can reorder/reselect representatives machine-to-machine.
    // The session table has no time_created column (unlike message/part), so id
    // is the deterministic key. (bundleHash sorts file hashes, so the tamper hash
    // was already safe; this fixes the candidate.json ordering/selection.)
    const sessStmt = db.prepare("SELECT id, parent_id, directory, version FROM session ORDER BY id");
    const mStmt = db.prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created");
    const pStmt = db.prepare("SELECT data FROM part WHERE message_id = ? ORDER BY time_created");

    const acc = { redactionHits: 0, redactedChars: 0, compactionSummaries: [] };
    const sessions = [];
    const byId = new Map();
    const files = [];

    for (const row of sessStmt.all()) {
      const info = { id: row.id, parentID: row.parent_id || null, directory: row.directory || "", version: row.version || null };
      const session = baseSession(info);

      const h = createHash("sha256"); // provenance over raw row bytes
      h.update(info.id + "\n" + info.directory);
      let records = 0, malformed = 0, bytes = 0;

      for (const mr of mStmt.all(info.id)) {
        h.update(mr.data); bytes += mr.data.length;
        let mObj; try { mObj = JSON.parse(mr.data); } catch { malformed++; continue; }
        const m = { id: mr.id, ...mObj };
        const parts = [];
        for (const pr of pStmt.all(mr.id)) {
          h.update(pr.data); bytes += pr.data.length;
          try { parts.push(JSON.parse(pr.data)); } catch { malformed++; }
        }
        records += 1 + parts.length;
        ingestMessage(session, m, parts, acc);
      }

      files.push({ relPath: `opencode-db/session/${info.id}`, sha256: h.digest("hex"), bytes, lines: records, malformed });
      byId.set(session.sessionId, session);
      sessions.push(session);
    }

    const { rolledUp, orphaned } = applyRollup(sessions, byId);
    return finalize(dbPath, sessions, files, acc, rolledUp, "sqlite", orphaned);
  } finally {
    db.close();
  }
}

// ── Backend: JSON files (fallback) ──────────────────────────────────────────
const listJson = (dir) =>
  existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".json")).map((e) => join(dir, e.name)) : [];

export function readOpencodeJson(root = defaultOpencodeRoot()) {
  if (!root || !existsSync(root)) return EMPTY(root);
  const sessionDir = join(root, "session");
  const messageDir = join(root, "message");
  const partDir = join(root, "part");

  const acc = { redactionHits: 0, redactedChars: 0, compactionSummaries: [] };
  const sessions = [];
  const byId = new Map();
  const files = [];

  const sessionFiles = [];
  if (existsSync(sessionDir)) {
    for (const e of readdirSync(sessionDir, { withFileTypes: true })) {
      if (e.isDirectory()) sessionFiles.push(...listJson(join(sessionDir, e.name)));
      else if (e.isFile() && e.name.endsWith(".json")) sessionFiles.push(join(sessionDir, e.name));
    }
  }

  for (const sf of sessionFiles) {
    let info;
    try { info = JSON.parse(readFileSync(sf, "utf8")); } catch { continue; }
    if (!info || !info.id) continue;

    const session = baseSession({ id: info.id, parentID: info.parentID || null, directory: info.directory || "", version: info.version || null });
    const chunks = [readFileSync(sf)];
    let records = 0;
    let malformed = 0;

    // Collect messages first, then ingest in CREATION-TIME order. The sqlite
    // backend reads messages `ORDER BY time_created`; opencode message ids sort
    // reverse-chronologically (descending-id scheme), so a bare filename sort
    // feeds messages newest-first and the two backends reconstruct each session
    // in OPPOSITE order — diverging compactionSummaries (sliced -6 into the
    // narrative), concatenated text, and the per-file provenance bytes, all from
    // nothing but the Node version (sqlite present >= 22.5 vs JSON fallback).
    // Sort by m.time.created so the JSON path agrees with the db. Provenance is
    // still hashed over `chunks` in filename order, so the per-file sha is
    // unchanged. Parts carry no timestamp in the JSON layout, so their
    // within-message order stays filename-sorted (only multi-text-part
    // concatenation is order-sensitive there).
    const msgs = [];
    for (const mf of listJson(join(messageDir, info.id)).sort()) {
      let m;
      try { chunks.push(readFileSync(mf)); m = JSON.parse(readFileSync(mf, "utf8")); records++; }
      catch { malformed++; continue; }
      const parts = [];
      for (const pf of listJson(join(partDir, m.id)).sort()) {
        try { chunks.push(readFileSync(pf)); parts.push(JSON.parse(readFileSync(pf, "utf8"))); records++; }
        catch { malformed++; }
      }
      msgs.push({ m, parts });
    }
    msgs.sort((a, b) => (a.m.time?.created ?? 0) - (b.m.time?.created ?? 0));
    for (const { m, parts } of msgs) ingestMessage(session, m, parts, acc);

    const buf = Buffer.concat(chunks);
    files.push({ relPath: `opencode/session/${info.id}`, sha256: sha256(buf), bytes: buf.length, lines: records, malformed });
    byId.set(session.sessionId, session);
    sessions.push(session);
  }

  const { rolledUp, orphaned } = applyRollup(sessions, byId);
  return finalize(root, sessions, files, acc, rolledUp, "json", orphaned);
}

// ── Public entry: prefer the db, fall back to JSON ──────────────────────────
export function readOpencode(root = defaultOpencodeRoot()) {
  const db = defaultOpencodeDb(root);
  if (db && loadSqlite()) {
    try {
      const fromDb = readOpencodeDb(db);
      if (fromDb.sessions.length) return fromDb;
    } catch {
      // Corrupt/locked db, or an unexpected schema — fall through to JSON.
    }
  }
  return readOpencodeJson(root);
}

// Merge two parsed sources (e.g. Claude Code + opencode) into one bundle. The
// per-repo clustering downstream then unifies sessions of the same product
// across tools automatically. summarizeSources(parsed) on main reads the
// per-session source tag and groups them for the profile's sources block.
//
// We also carry a per-source `backends` map ({ source: "sqlite"|"json" }) out
// of the merge — the one piece of per-source stats the capture-level seam needs
// that can't be recovered from a session tag (which read path served a source).
// summarizeSources reads it to fill each source's `backend` field.
export function mergeSources(...parsedList) {
  const sources = parsedList.filter(Boolean);
  const backends = {};
  for (const p of sources) {
    if (p.source && p.stats?.backend) backends[p.source] = p.stats.backend;
  }
  return {
    source: sources.map((p) => p.source).join("+") || "none",
    root: sources[0]?.root ?? null,
    files: sources.flatMap((p) => p.files ?? []),
    // Both shipped adapters stamp source per session; the merge seam
    // re-guarantees it so every downstream consumer (digest fan-out, sources
    // summary, forensics scoping) reads one contract even if a future adapter
    // forgets to stamp.
    sessions: sources.flatMap((p) =>
      (p.sessions ?? []).map((s) => (s.source || !p.source ? s : { ...s, source: p.source }))),
    compactionSummaries: sources.flatMap((p) => p.compactionSummaries ?? []),
    redaction: {
      hits: sources.reduce((n, p) => n + (p.redaction?.hits ?? 0), 0),
      charsRemoved: sources.reduce((n, p) => n + (p.redaction?.charsRemoved ?? 0), 0),
    },
    backends,
  };
}
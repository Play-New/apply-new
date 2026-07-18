// kimi (kimi-code) adapter: reads kimi-code CLI's per-session wire logs
// (~/.kimi-code/sessions/wd_<slug>_<12hex>/session_<uuid>/agents/<agentId>/
// wire.jsonl, one file per AGENT within a session, plus a sibling
// state.json) and normalises them into the SAME session model
// claude-code.mjs, opencode.mjs, codex.mjs and pi.mjs produce, so every
// downstream lens (digest, agentic-literacy, forensics, fingerprint,
// intensity, distribution) keeps working unchanged.
//
// DISCOVERY is bespoke, not walk()-based: unlike the other adapters' flat
// "any .jsonl under root" sweep, kimi's session is a whole DIRECTORY
// (state.json + agents/*/wire.jsonl), and the parent of sessions/ now holds
// real provider config (config.toml), a device id, and possibly a
// credentials/ dir — none of which should ever be opened. Scoping root to
// sessions/ and only descending into wd_*/session_*/{state.json,agents/*/
// wire.jsonl} makes everything else structurally unreachable, not just
// policy-excluded.
//
// TURN SYNTHESIS, like codex: kimi's assistant output arrives as a flat
// event stream (context.append_loop_event, nested step.begin/content.part/
// tool.call/tool.result/step.end), not as ready-made messages. Every
// surviving `context.append_message` with role "user" flushes the
// previously open assistant turn, emits the user message, and opens a fresh
// turn; loop events accumulate into it until the next user message or EOF.
// UNLIKE codex, this happens once PER AGENT FILE (uuid = "<sessionId>-
// <agentId>-turn-<n>", parentUuid chains only within that file), because a
// session here is not one file but N agent files. All agents' synthesized
// messages are then merged into ONE session.messages array and sorted by
// record time — "the session dir IS the session", per the subagent-rollup
// design; unlike opencode there is no cross-session re-parenting to do,
// just an interleave. FRAMEWORK-INJECTED USER TURNS ARE NOW FILTERED, same
// per-block discipline codex uses for <environment_context>: kimi's own
// injected reminders (context.append_message with role "user", origin.kind
// "injection", e.g. a stale-TodoList nudge) arrive wrapped ENTIRELY in
// <system-reminder>...</system-reminder>. An earlier revision of this
// comment documented NOT filtering these — reversed here by observed harm: a
// real end-to-end test on this machine showed reminder text surfacing in
// promptSamples and inflating user-message signal counts as if a human had
// typed it. A block survives only when its trimmed text is not fully
// wrapped in the tag; a message where every block is wrapped (or which has
// none left) is skipped ENTIRELY — no emit, no turn flush, no turn reopen —
// so a reminder landing mid-turn can never split or corrupt the surrounding
// loop-event turn synthesis (see extractUserMessageText below).
// `turn.prompt` and `context.append_message` both record the user's prompt
// (the former is the raw input event, the latter the canonical message the
// context keeps); processing both would double-count user messages, so only
// append_message emits — turn.prompt is a no-op case in the switch below.
//
// USAGE KEYS are renamed, not reused: step.end's usage object uses kimi's
// own names (inputOther, output, inputCacheRead, inputCacheCreation) which
// get renamed to the shared contract (input, output, cacheRead,
// cacheCreate) and SUMMED across every step.end inside one synthesized
// turn (a turn can span several LLM steps when it makes several tool
// calls). The separate `usage.record` record type carries the same numbers
// at a coarser ("turn") granularity and is deliberately ignored — using it
// as well would double count, and a turn with no step.end at all (e.g. it
// was still streaming when the file was read) correctly yields usage: null
// rather than falling back to it.
//
// DISPLAY IS PREFERRED over raw args for tool.call: kimi ships its own
// normalised `display` view of a call (display.kind "file_io" -> path,
// "command" -> command) alongside the real `args` object, and display is
// trusted first with args as the fallback for tools kimi hasn't classified.
// CRITICAL: display for a file_io "write" call also carries a `content`
// field with the FULL file body about to be written (confirmed on a real
// session on this machine — tens of KB of raw source). Only display.path is
// ever read off that object; display.content (and args.content) must never
// be touched, exactly like Write's `content` argument is never touched by
// any other adapter.
//
// PRIVACY: state.json's `title` and `lastPrompt` fields are VERBATIM PROMPT
// TEXT (confirmed on a real session: lastPrompt was a full user instruction
// sentence). We parse state.json only to pull out `workDir`; the rest of
// the parsed object — including title/lastPrompt — is never assigned to
// anything and never leaves this function. There is no `title` field on
// the shared session model and none is added here.
//
// SCOPE CUT: no compaction, cancel, or session-title record shapes have
// been observed in wire.jsonl yet (only metadata/config.update/tools.
// set_active_tools/turn.prompt/context.append_message/llm.request/llm.
// tools_snapshot/usage.record/context.append_loop_event/permission.
// record_approval_result — see the switch below), so compactionSummaries
// is always []. Revisit when/if kimi ships a compaction convention.
//
// Live-append: wire.jsonl is append-only and can be mid-write (a live
// session was running while this adapter's tests were being written). A
// truncated trailing line degrades to "malformed", never throws, and the
// rest of the file still parses; stats.liveSessionsSeen counts each SESSION
// (not each file) where at least one agent's wire.jsonl ended mid-line —
// cheap, honestly-named disclosure that the read may be incomplete.
//
// Same structural-capture posture as every other adapter: thinking text,
// tool output, and systemPrompt/title/lastPrompt are reduced to lengths/
// booleans or dropped outright, never kept — see redact.mjs and
// claude-code.mjs/opencode.mjs/codex.mjs/pi.mjs for the shared contract
// this adapter has to honor.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { redactText, countRedactions } from "../redact.mjs";
import { toPosix } from "./claude-code.mjs";
import { fallbackToolName } from "./tool-vocab.mjs";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const shortHash = (s) => sha256(s).slice(0, 8);
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

// ── Default location ────────────────────────────────────────────────────────
// kimi-code documents no env-var override for the sessions root (same
// honest posture as pi.mjs re: no override to invent). The PARENT of
// sessions/ (config.toml, device_id, credentials/, telemetry/, user-
// history/, logs/, session_index.jsonl, workspaces.json) is never resolved
// or opened here.
export function defaultKimiRoot() {
  return join(homedir(), ".kimi-code", "sessions");
}

// ── Tool vocabulary: kimi → canonical (Claude Code) names ──────────────────
// kimi's own tool names are already PascalCase and mostly canonical (Read,
// Write, Edit, Bash, Glob confirmed on real sessions on this machine) — the
// one confirmed rename is FetchURL -> WebFetch. Anything else unmapped
// (including any that already happen to be canonical) falls through to
// fallbackToolName unchanged, same contract every other adapter honors.
const TOOL_MAP = {
  FetchURL: "WebFetch",
};
function mapTool(name) {
  if (!name) return name;
  if (TOOL_MAP[name]) return TOOL_MAP[name];
  return fallbackToolName(name);
}

// Directory listing helper, filtered to directories only. Used for the
// three fixed levels of kimi's discovery (wd_*, session_*, agents/*)
// instead of walk()'s flat recursive .jsonl sweep, which would happily
// wander into logs/ or any other sibling under a session dir.
function listDirNames(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

// "session_<uuid>" -> "<uuid>". Falls back to the raw dir name if it
// somehow doesn't match (defensive; every session dir observed on this
// machine follows the convention).
const SESSION_DIR_RE = /^session_(.+)$/;
function sessionIdFromDirName(name) {
  const m = SESSION_DIR_RE.exec(name);
  return m ? m[1] : name;
}

// context.append_message's message.content / turn.prompt's input: an array
// of {type:"text", text} blocks — the only block shape observed.
function extractMessageText(content) {
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const b of content) {
    if (b && typeof b === "object" && b.type === "text") text += (b.text || "") + "\n";
  }
  return text;
}

// Framework-injected content: kimi re-sends TodoList/other nudges as a
// synthetic role-"user" block wrapped ENTIRELY in <system-reminder> (checked
// per content block, mirroring codex's <environment_context>/<permissions
// instructions> filter — see extractUserMessageText below). Trimmed text
// must both start with the open tag and end with the close tag, so a real
// block that merely mentions <system-reminder> inline is never dropped.
const FRAMEWORK_TAGS = [{ open: "<system-reminder>", close: "</system-reminder>" }];
function isFrameworkWrapped(trimmed) {
  return FRAMEWORK_TAGS.some((t) => trimmed.startsWith(t.open) && trimmed.endsWith(t.close));
}

// role "user" context.append_message content, filtered per block: a block
// that survives contributes to the message exactly like extractMessageText
// does; one that's framework-wrapped is dropped without contributing.
// Returns null when no block survives (all wrapped, or there were none) so
// the caller can skip the message entirely — no emit, no turn flush/reopen,
// so an all-filtered message mid-turn never disturbs the open loop-event
// turn (see the header's "turn synthesis safety" note).
function extractUserMessageText(content) {
  if (!Array.isArray(content)) return null;
  let text = "";
  let survived = 0;
  for (const b of content) {
    if (!b || typeof b !== "object" || b.type !== "text") continue;
    const blockText = b.text || "";
    if (isFrameworkWrapped(blockText.trim())) continue;
    survived++;
    text += blockText + "\n";
  }
  return survived > 0 ? text : null;
}

// tool.call -> toolUse. display is kimi's own normalised view of the call
// and is preferred when its `kind` matches the field we want; args (the
// real, un-normalised tool arguments) is the fallback for anything display
// hasn't classified (or when display is entirely absent). q has no display
// counterpart (kimi doesn't model a "search" display kind) so it always
// comes straight from args.pattern (e.g. Glob's search pattern).
function buildToolCallToolUse(event) {
  const args = event.args && typeof event.args === "object" && !Array.isArray(event.args) ? event.args : {};
  const display = event.display && typeof event.display === "object" ? event.display : {};
  const mapped = mapTool(event.name);

  // NEVER read display.content / args.content here (see header) — only
  // .path and .command are ever pulled off either object.
  const rawPath = display.kind === "file_io" ? (display.path ?? args.path) : args.path;
  const rawCmd = display.kind === "command" ? (display.command ?? args.command) : args.command;

  const path = rawPath ? toPosix(redactText(String(rawPath))) : "";
  const cmd = rawCmd ? redactText(String(rawCmd).slice(0, 240)) : "";
  const q = args.pattern ? redactText(String(args.pattern).slice(0, 200)) : "";

  return { id: event.toolCallId, name: mapped, path, cmd, q };
}

// tool.result -> toolResult. isError is present ONLY on failures (confirmed
// on real data: absent when successful, `true` with note:null on failure) —
// absence must mean false, never undefined. result.output/.note text is
// never stored, only its length.
function buildToolResultEntry(event) {
  const result = event.result && typeof event.result === "object" ? event.result : {};
  const output = typeof result.output === "string" ? result.output : "";
  return { forId: event.toolCallId, isError: result.isError === true, bytes: output.length };
}

// step.end's usage -> the shared {input, output, cacheRead, cacheCreate}
// shape (RENAME only). Mutates turn.usage in place, summing across however
// many step.ends land in one synthesized turn.
function accumulateUsage(turn, usage) {
  if (!usage || typeof usage !== "object") return;
  turn.usage ||= { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  turn.usage.input += usage.inputOther || 0;
  turn.usage.output += usage.output || 0;
  turn.usage.cacheRead += usage.inputCacheRead || 0;
  turn.usage.cacheCreate += usage.inputCacheCreation || 0;
}

// Process one agent's wire.jsonl records into a flat list of normalized
// messages, mutating the shared `session` object's models Set and firstTs/
// lastTs as it goes (every record's own `time` counts toward the session's
// span, not just the ones that become messages — state.json's updatedAt is
// STALE on a live session, so wire record times are the only trustworthy
// source). uuid/parentUuid chaining is local to this one agent file; the
// caller merges + time-sorts every agent's messages into one session.
function processAgentFile(session, sessionId, agentId, records) {
  const messages = [];
  let currentModel = null;
  let turn = null; // open assistant-turn accumulator, or null between turns
  let turnN = 0;
  let prevUuid = null;
  let redactionHits = 0;
  let redactedChars = 0;

  const stampSessionTs = (ts) => {
    if (!ts) return;
    if (!session.firstTs || ts < session.firstTs) session.firstTs = ts;
    if (!session.lastTs || ts > session.lastTs) session.lastTs = ts;
  };

  const stampModel = (alias) => {
    if (typeof alias !== "string" || !alias) return;
    // Defensive redaction, mirroring pi.mjs's model-path privacy rule: a
    // modelAlias isn't known to ever be a filesystem path on kimi, but
    // there's no cost to treating it the same way pi treats modelId.
    currentModel = redactText(alias);
    session.models.add(currentModel);
  };

  const openTurn = () => {
    turn = { ts: null, text: "", thinkingChars: 0, signatureChars: 0, toolUses: [], toolResults: [], usage: null };
  };
  const markTurnTs = (ts) => {
    if (turn && !turn.ts && ts) turn.ts = ts;
  };

  const emit = (role, ts, text, extra = {}) => {
    turnN += 1;
    const uuid = `${sessionId}-${agentId}-turn-${turnN}`;
    const parentUuid = prevUuid;
    prevUuid = uuid;

    redactionHits += countRedactions(text);
    const textRedacted = redactText(text);
    redactedChars += text.length - textRedacted.length;

    messages.push({
      role,
      ts,
      uuid,
      parentUuid,
      model: currentModel,
      textRedacted,
      textLen: text.length,
      thinkingChars: extra.thinkingChars || 0,
      signatureChars: extra.signatureChars || 0, // kimi has no signature field; always 0
      toolUses: extra.toolUses || [],
      toolResults: extra.toolResults || [],
      usage: extra.usage || null,
    });
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
    // Not every record type carries a `time` field (metadata's own
    // timestamp field is `created_at`, confirmed on real data) — fall back
    // to created_at so metadata's own record still counts toward the
    // session span, per the "every record's time counts toward the span"
    // rule below. iso() degrades a missing/non-finite value to null and
    // stampSessionTs is a no-op on null, so this is safe to call
    // unconditionally.
    const ts = iso(r.time ?? r.created_at);
    stampSessionTs(ts);

    switch (r.type) {
      case "metadata":
        break; // provenance only; the file's raw bytes are already hashed into files[]
      case "config.update":
        stampModel(r.modelAlias);
        // r.systemPrompt is framework text (confirmed 20K+ chars on a real
        // session) — deliberately never read past the modelAlias check.
        break;
      case "tools.set_active_tools":
        break; // the active tool-name list; no message-shaped content
      case "turn.prompt":
        break; // duplicates context.append_message's user text; see header
      case "context.append_message": {
        const message = r.message && typeof r.message === "object" ? r.message : {};
        if (message.role === "user") {
          const text = extractUserMessageText(message.content);
          if (text === null) break; // fully framework-injected reminder: skip entirely, no turn side effects
          flushTurn();
          emit("user", ts, text);
          openTurn();
        } else if (message.role === "assistant") {
          // Not observed on this machine (every context.append_message
          // seen was role "user"); defensive fallback only, mirroring the
          // user case's turn discipline exactly (flush -> emit -> reopen)
          // rather than leaving the open loop-event turn untouched.
          // Emitting straight into `emit()` without flushing first left the
          // in-flight turn open: it kept accumulating loop-event content
          // from BOTH sides of this injected message into one turn, whose
          // ts is fixed at its FIRST folded record (i.e. from before the
          // injection) but which is only pushed to `messages` later, after
          // the injected message was already pushed. Once merged across
          // agents and sorted by ts, that produces a parentUuid chain where
          // the child (the late-flushed turn) has an EARLIER ts than its
          // parent (this injected message) — plus content from before/after
          // the injection wrongly folded into a single message. Flushing
          // first closes out whatever was folded so far as its own message
          // (preserving the ts-of-first-folded-record rule), then this
          // injected message gets its own ts/uuid slot, then reopening a
          // fresh turn lets subsequent loop events accumulate cleanly again.
          flushTurn();
          emit("assistant", ts, extractMessageText(message.content));
          openTurn();
        }
        // any other role: ignore, forward-compat
        break;
      }
      case "llm.request":
        stampModel(r.modelAlias);
        break; // otherwise just an LLM-call boundary marker
      case "llm.tools_snapshot":
        break; // a 67KB tool-schema dump; nothing message-shaped
      case "usage.record":
        break; // step.end is the summed source of truth; see header
      case "context.append_loop_event": {
        if (!turn) break; // events outside an open turn have nothing to attach to
        const event = r.event && typeof r.event === "object" ? r.event : {};
        switch (event.type) {
          case "step.begin":
            break; // step boundary marker only, no structural content
          case "content.part": {
            const part = event.part && typeof event.part === "object" ? event.part : {};
            if (part.type === "think") {
              turn.thinkingChars += (part.think || "").length; // NEVER store the text itself
              markTurnTs(ts);
            } else if (part.type === "text") {
              turn.text += (part.text || "") + "\n";
              markTurnTs(ts);
            }
            break;
          }
          case "tool.call":
            turn.toolUses.push(buildToolCallToolUse(event));
            markTurnTs(ts);
            break;
          case "tool.result":
            turn.toolResults.push(buildToolResultEntry(event));
            markTurnTs(ts);
            break;
          case "step.end":
            accumulateUsage(turn, event.usage);
            markTurnTs(ts);
            break;
          default:
            break; // forward-compat: unknown loop-event type
        }
        break;
      }
      case "permission.record_approval_result":
        // turnId here is a NUMBER (confirmed: 0) while loop events' turnId
        // is a STRING ("0") — a genuine inconsistency in kimi's own wire
        // format, not a bug in this adapter. Noted so nobody "fixes" one of
        // the two string/number handlings later and breaks the other.
        break;
      default:
        break; // unknown top-level type: ignore (versioned protocol, forward-compat)
    }
  }

  flushTurn();
  return { messages, redactionHits, redactedChars };
}

const EMPTY = (root) => ({
  source: "kimi",
  root: root || null,
  files: [],
  sessions: [],
  compactionSummaries: [],
  redaction: { hits: 0, charsRemoved: 0 },
  stats: { malformedLines: 0, liveSessionsSeen: 0 },
});

export function readKimi(root) {
  if (!root || !existsSync(root)) return EMPTY(root);

  const files = [];
  const sessions = [];
  let redactionHits = 0;
  let redactedChars = 0;
  let malformedLinesTotal = 0;
  let liveSessionsSeenTotal = 0;

  for (const wdName of listDirNames(root).filter((n) => n.startsWith("wd_"))) {
    const wdDir = join(root, wdName);
    for (const sessName of listDirNames(wdDir).filter((n) => n.startsWith("session_"))) {
      const sessionDir = join(wdDir, sessName);
      const sessionId = sessionIdFromDirName(sessName);

      const session = {
        source: "kimi",
        sessionId,
        projectLabel: "project-unknown",
        cwdRedacted: "",
        cwdRaw: "", // local-only; never sent in the bundle
        gitBranch: null, // kimi does not record the branch
        cliVersions: [], // no per-session version signal observed to populate this from
        models: new Set(),
        messages: [],
        chain: [], // {uuid, parentUuid, ts}
        firstTs: null,
        lastTs: null,
      };

      // state.json: the ONLY field ever read out of it is workDir. title/
      // lastPrompt (verbatim prompt text — see header) and the agents map
      // are parsed into `state` transiently and never assigned anywhere.
      // Missing/malformed -> cwdRaw stays "" and projectLabel stays
      // "project-unknown", same fallback codex.mjs uses for a missing cwd —
      // no directory-name decode fallback exists for kimi (unlike pi).
      const stateJsonPath = join(sessionDir, "state.json");
      if (existsSync(stateJsonPath)) {
        const buf = readFileSync(stateJsonPath);
        let state = null;
        let malformed = 0;
        try {
          state = JSON.parse(buf.toString("utf8"));
        } catch {
          malformed = 1;
        }
        if (state && typeof state.workDir === "string" && state.workDir) {
          session.cwdRaw = state.workDir;
          session.cwdRedacted = toPosix(redactText(state.workDir));
          session.projectLabel = `project-${shortHash(state.workDir)}`;
        }
        files.push({ relPath: relative(root, stateJsonPath), sha256: sha256(buf), bytes: buf.length, lines: 1, malformed });
      }

      const agentsDir = join(sessionDir, "agents");
      let sessionIsLive = false;

      // agents/*: iterate in a fixed alphabetical order, never raw
      // readdirSync() enumeration order. POSIX readdir does not guarantee
      // any particular order (it can reflect inode/allocation history, not
      // creation or name order, and differs by filesystem/OS) — two agents
      // whose messages land on the exact same ts would previously merge in
      // whatever order the OS handed back, reproducible on one machine but
      // not across machines. Sorting here is also what the merge-sort
      // tie-break below keys its "agentId" half off of.
      for (const agentId of listDirNames(agentsDir).sort()) {
        const wirePath = join(agentsDir, agentId, "wire.jsonl");
        if (!existsSync(wirePath)) continue;

        const buf = readFileSync(wirePath);
        const relPath = relative(root, wirePath);
        const rawLines = buf.toString("utf8").split("\n").filter((l) => l.trim());
        const records = [];
        let malformed = 0;
        rawLines.forEach((line, i) => {
          try {
            records.push(JSON.parse(line));
          } catch {
            malformed++;
            // Live-append rule: only the TRAILING line failing means the
            // file was mid-write; an earlier malformed line is a genuine
            // corruption, not liveness, so it doesn't set the flag.
            if (i === rawLines.length - 1) sessionIsLive = true;
          }
        });
        malformedLinesTotal += malformed;

        const { messages, redactionHits: rh, redactedChars: rc } = processAgentFile(session, sessionId, agentId, records);
        // Tag each message with the agentId it came from and its position
        // within that agent's own emission order (0, 1, 2, ...), so the
        // merge sort below has a deterministic tie-break for identical ts
        // values across agents. Transient bookkeeping only — stripped
        // again right after sorting, never part of the returned shape.
        messages.forEach((m, i) => {
          m._agentId = agentId;
          m._agentSeq = i;
        });
        session.messages.push(...messages);
        redactionHits += rh;
        redactedChars += rc;

        files.push({ relPath, sha256: sha256(buf), bytes: statSync(wirePath).size, lines: rawLines.length, malformed });
      }

      if (sessionIsLive) liveSessionsSeenTotal++;

      // Every agent's messages were synthesized independently (their own
      // local uuid/parentUuid chain); merge them into the one session by
      // record time, per the subagent-rollup design (see header). Ties on
      // identical ts are broken by agentId (alphabetical, matching the
      // agentsDir iteration order above) then by each message's own
      // position within its agent's emission order — both fixed,
      // filesystem-independent keys, so identical-ts messages land in the
      // same order on every machine instead of depending on push() order,
      // which used to be at the mercy of POSIX readdir's unspecified
      // enumeration order (see the agentsDir loop above).
      session.messages.sort((a, b) => {
        const byTs = (a.ts || "").localeCompare(b.ts || "");
        if (byTs !== 0) return byTs;
        const byAgent = a._agentId.localeCompare(b._agentId);
        if (byAgent !== 0) return byAgent;
        return a._agentSeq - b._agentSeq;
      });
      session.chain = session.messages.map((m) => ({ uuid: m.uuid, parentUuid: m.parentUuid, ts: m.ts }));
      for (const m of session.messages) {
        delete m._agentId;
        delete m._agentSeq;
      }

      sessions.push({ ...session, models: [...session.models] });
    }
  }

  return {
    source: "kimi",
    root,
    files,
    sessions,
    compactionSummaries: [], // no compaction convention observed yet; see header scope cut
    redaction: { hits: redactionHits, charsRemoved: redactedChars },
    stats: { malformedLines: malformedLinesTotal, liveSessionsSeen: liveSessionsSeenTotal },
  };
}

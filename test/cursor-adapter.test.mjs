// cursor-agent adapter: verifies the blob-DAG reconstruction (meta hex-decode,
// the minimal protobuf root walk, field-1 message ordering), the JSON message
// classification by role (system dropped, user's <user_info> vs <user_query>
// split, assistant reasoning/text/tool-call, tool tool-result), the
// <timestamp> tag parse + ts-inheritance chain, the TOOL_MAP vocabulary, the
// compound-toolCallId-with-embedded-newline linkage, the isError/bytes
// tool-result lens, the null-usage contract, and the walker's robustness to
// malformed/missing blobs and an unopenable db copy. Also smoke-runs the
// bundle through the shared lenses like every other adapter test does.
//
// Skips cleanly on Node < 22.5 (no node:sqlite), exactly like
// test/opencode-db.test.mjs — cursor has no JSON fallback, so there is no
// second backend to fall back to and cover here.
//
// Every fixture is fully synthetic, built under mkdtempSync(tmpdir()). No
// test may open the real ~/.cursor/chats.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readCursor, defaultCursorRoot, pbFields } from "../src/adapters/cursor.mjs";
import { mergeSources } from "../src/adapters/opencode.mjs";
import { buildDigest } from "../src/digest.mjs";
import { computeAgenticLiteracy } from "../src/agentic-literacy.mjs";
import { computeIntensity } from "../src/intensity.mjs";

const require = createRequire(import.meta.url);
let sqlite = null;
try {
  sqlite = require("node:sqlite");
} catch {
  /* Node < 22.5 */
}

const sha256 = (buf) => createHash("sha256").update(buf).digest(); // raw digest, Buffer
const sha256Hex = (buf) => createHash("sha256").update(buf).digest("hex");

// ── Tiny protobuf ENCODER (mirrors the wire format pbFields reads) ─────────
function encodeVarint(n) {
  let v = typeof n === "bigint" ? n : BigInt(n);
  const bytes = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    bytes.push(b);
  } while (v > 0n);
  return Buffer.from(bytes);
}
function encodeTag(fieldNo, wireType) {
  return encodeVarint((fieldNo << 3) | wireType);
}
function fieldBytes(fieldNo, buf) {
  return Buffer.concat([encodeTag(fieldNo, 2), encodeVarint(buf.length), buf]);
}
function fieldString(fieldNo, str) {
  return fieldBytes(fieldNo, Buffer.from(str, "utf8"));
}
function fieldVarint(fieldNo, value) {
  return Buffer.concat([encodeTag(fieldNo, 0), encodeVarint(value)]);
}
function fieldFixed32(fieldNo, n = 0) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return Buffer.concat([encodeTag(fieldNo, 5), b]);
}
function fieldFixed64(fieldNo, n = 0n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(typeof n === "bigint" ? n : BigInt(n), 0);
  return Buffer.concat([encodeTag(fieldNo, 1), b]);
}

// ── Root blob builder ───────────────────────────────────────────────────────
function buildRootBlob({ hashes = [], cwd, originator = "cli", updatedAtMs, extra = [] }) {
  const parts = [];
  for (const h of hashes) parts.push(fieldBytes(1, h));
  if (cwd != null) parts.push(fieldString(9, `file://${cwd}`));
  if (originator != null) parts.push(fieldString(22, originator));
  if (updatedAtMs != null) parts.push(fieldVarint(26, updatedAtMs));
  parts.push(...extra);
  return Buffer.concat(parts);
}

// ── SQLite fixture builder ──────────────────────────────────────────────────
// Builds <root>/<hexDir>/<uuidDir>/store.db with the real two-table schema,
// inserts message blobs (in the given order) plus a root blob referencing
// their hashes via field 1, and a meta row pointing at that root.
//
// `blobs` entries: a plain object -> JSON-stringified message blob (its
// sha256 goes into field 1 in order); `{ raw: Buffer }` -> stored verbatim
// (used for the malformed-JSON case); `{ missing: true }` -> a random 32-byte
// hash is referenced in field 1 but NEVER inserted into the blobs table.
function makeCursorSession(root, { hexDir = "abc123hexdir00000000000000000000", uuidDir = "11111111-1111-1111-1111-111111111111", agentId = uuidDir, createdAtMs = Date.parse("2026-07-18T06:00:00.000Z"), cwd = "/Users/synthetic/proj", name = "SECRET_TITLE_never_stored", mode = "default", lastUsedModel = "default", originator = "cli", updatedAtMs, blobs = [], rootExtra = [] } = {}) {
  const dir = join(root, hexDir, uuidDir);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "store.db");
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE meta (key TEXT, value TEXT);
    CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);
  `);
  const insBlob = db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)");

  const hashes = [];
  for (const b of blobs) {
    if (b && b.missing) {
      // A hash that will be referenced in field 1 but never inserted.
      hashes.push(sha256(Buffer.from(`missing-${Math.random()}`)));
      continue;
    }
    const data = b && b.raw ? b.raw : Buffer.from(JSON.stringify(b), "utf8");
    const h = sha256(data);
    insBlob.run(h.toString("hex"), data);
    hashes.push(h);
  }

  const rootBuf = buildRootBlob({ hashes, cwd, originator, updatedAtMs, extra: rootExtra });
  const rootId = sha256Hex(rootBuf);
  insBlob.run(rootId, rootBuf);

  const metaObj = { agentId, latestRootBlobId: rootId, name, mode, createdAt: createdAtMs, lastUsedModel };
  const metaHex = Buffer.from(JSON.stringify(metaObj), "utf8").toString("hex");
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("0", metaHex);

  db.close();
  return { dbPath, hexDir, uuidDir, agentId };
}

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), "cursor-chats-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── Message-blob factories (real observed shapes) ───────────────────────────
const systemMsg = () => ({ role: "system", content: "You are an AI coding assistant..." });
const userInfoMsg = () => ({ role: "user", content: "<user_info>\nOS Version: darwin\n</user_info>" });
const userQueryMsg = (text, { timestamp, extraBlocks = [] } = {}) => ({
  role: "user",
  content: [
    {
      type: "text",
      text: `${timestamp ? `<timestamp>${timestamp}</timestamp>\n` : ""}<user_query>\n${text}\n</user_query>`,
    },
    ...extraBlocks,
  ],
  providerOptions: { cursor: { requestId: "req-1" } },
});
const assistantMsg = ({ reasoningText = "", signature = "", modelName, text, toolCalls = [] } = {}) => {
  const content = [];
  if (signature || reasoningText || modelName) {
    content.push({
      type: "reasoning",
      text: reasoningText,
      signature,
      providerOptions: modelName ? { cursor: { modelName } } : undefined,
    });
  }
  if (text) content.push({ type: "text", text });
  for (const tc of toolCalls) content.push({ type: "tool-call", toolCallId: tc.id, toolName: tc.name, args: tc.args });
  return { role: "assistant", content, id: "msg_x", providerOptions: { cursor: { modelProviderMessageId: "msg_x" } } };
};
const toolMsg = (toolCallId, { toolName = "Read", result = "ok", isError = false, topLevelIsError } = {}) => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId,
      toolName,
      result,
      experimental_content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }],
    },
  ],
  id: toolCallId,
  providerOptions: { cursor: { highLevelToolCallResult: { isError: topLevelIsError !== undefined ? topLevelIsError : isError } } },
});

const T1 = "Saturday, Jul 18, 2026, 6:16 AM (UTC)";
const T2 = "Saturday, Jul 18, 2026, 7:30 AM (UTC)";

// ── 1. meta hex-decode + root walk: sessionId, cwdRaw, ordering, uuid chain ──

test("root walk: sessionId/cwdRaw from meta+root; messages emitted in field-1 order with correct uuid/parentUuid chain", { skip: sqlite ? false : "node:sqlite unavailable" }, () => {
  withRoot((root) => {
    makeCursorSession(root, {
      agentId: "sess-order-1",
      cwd: "/Users/rinaldofesta/Projects/Work/PlayNew/filopea-poc",
      blobs: [systemMsg(), userQueryMsg("first", { timestamp: T1 }), assistantMsg({ text: "ok" }), userQueryMsg("second", { timestamp: T2 })],
    });
    const parsed = readCursor(root);
    assert.equal(parsed.sessions.length, 1);
    const s = parsed.sessions[0];
    assert.equal(s.sessionId, "sess-order-1");
    assert.equal(s.cwdRaw, "/Users/rinaldofesta/Projects/Work/PlayNew/filopea-poc");
    assert.ok(!s.cwdRedacted.includes("rinaldofesta"));
    // system dropped, 3 messages survive in order
    assert.equal(s.messages.length, 3);
    assert.deepEqual(s.messages.map((m) => m.role), ["user", "assistant", "user"]);
    assert.deepEqual(s.messages.map((m) => m.uuid), ["sess-order-1-m0", "sess-order-1-m1", "sess-order-1-m2"]);
    assert.deepEqual(s.messages.map((m) => m.parentUuid), [null, "sess-order-1-m0", "sess-order-1-m1"]);
    assert.deepEqual(s.chain.map((c) => c.uuid), s.messages.map((m) => m.uuid));
  });
});

// ── 2. system dropped; plain-string user dropped; user_query extraction; ts parse ──

test("classification: system dropped, framework <user_info> dropped, <user_query> extracted without wrapper tags, timestamp parsed to ISO", { skip: sqlite ? false : "node:sqlite unavailable" }, () => {
  withRoot((root) => {
    makeCursorSession(root, {
      agentId: "sess-classify",
      blobs: [systemMsg(), userInfoMsg(), userQueryMsg("create a dynamic html mockup", { timestamp: T1 })],
    });
    const parsed = readCursor(root);
    const s = parsed.sessions[0];
    assert.equal(s.messages.length, 1, "system + user_info must both be dropped, only the user_query message survives");
    const m = s.messages[0];
    assert.equal(m.role, "user");
    assert.equal(m.textRedacted.trim(), "create a dynamic html mockup");
    assert.ok(!m.textRedacted.includes("<user_query>") && !m.textRedacted.includes("<timestamp>"));
    assert.ok(Number.isFinite(Date.parse(m.ts)), `ts not ISO: ${m.ts}`);
    assert.equal(m.ts, new Date(Date.parse("Jul 18, 2026, 6:16 AM UTC")).toISOString());
  });
});

// ── 3. ts inheritance ──

test("ts inheritance: assistant/tool inherit the prior user ts; first message falls back to createdAt; firstTs/lastTs from meta/root", { skip: sqlite ? false : "node:sqlite unavailable" }, () => {
  withRoot((root) => {
    const updatedAtMs = Date.parse("2026-07-18T09:00:00.000Z");
    makeCursorSession(root, {
      agentId: "sess-ts",
      createdAtMs: Date.parse("2026-07-18T05:00:00.000Z"),
      updatedAtMs,
      blobs: [
        assistantMsg({ text: "no ts yet, should fall back to createdAt" }), // first emitted message has no parsed ts
        userQueryMsg("go", { timestamp: T1 }),
        assistantMsg({ text: "working" }),
        toolMsg("call-1", { result: "done" }),
      ],
    });
    const parsed = readCursor(root);
    const s = parsed.sessions[0];
    assert.equal(s.firstTs, new Date(Date.parse("2026-07-18T05:00:00.000Z")).toISOString());
    assert.equal(s.lastTs, new Date(updatedAtMs).toISOString());
    const [m0, m1, m2, m3] = s.messages;
    assert.equal(m0.ts, s.firstTs, "first message (no parsed ts) falls back to createdAt");
    assert.equal(m1.ts, new Date(Date.parse("Jul 18, 2026, 6:16 AM UTC")).toISOString());
    assert.equal(m2.ts, m1.ts, "assistant inherits the prior user ts");
    assert.equal(m3.ts, m1.ts, "tool inherits the prior user ts");
  });
});

// ── 4. reasoning lens + model ──

test("reasoning: empty text + signature length lens; signature never stored; modelName lands in models Set", { skip: sqlite ? false : "node:sqlite unavailable" }, () => {
  withRoot((root) => {
    makeCursorSession(root, {
      agentId: "sess-reasoning",
      blobs: [
        userQueryMsg("think", { timestamp: T1 }),
        assistantMsg({ reasoningText: "", signature: "SECRET_SIGNATURE_BLOB_XYZ", modelName: "cursor-grok-4.5-high-fast", text: "answer" }),
      ],
    });
    const parsed = readCursor(root);
    const s = parsed.sessions[0];
    const asst = s.messages.find((m) => m.role === "assistant");
    assert.equal(asst.thinkingChars, 0);
    assert.equal(asst.signatureChars, "SECRET_SIGNATURE_BLOB_XYZ".length);
    assert.deepEqual([...s.models], ["cursor-grok-4.5-high-fast"]);
    const dump = JSON.stringify(parsed);
    assert.ok(!dump.includes("SECRET_SIGNATURE_BLOB_XYZ"), "signature text leaked into the bundle");
  });
});

// ── 5. TOOL_MAP + compound toolCallId ──

test("tool mapping: Shell->Bash cmd, Read path, Grep pattern->q, Write contents absent; compound toolCallId (embedded newline) links tool-result", { skip: sqlite ? false : "node:sqlite unavailable" }, () => {
  withRoot((root) => {
    const compoundId = "call-f48bc8fc-6593-4fcb-9857-d5e37b47a484-0\nfc_5a551111-25bd-9170-9f2a-a9c7a65adde4_0";
    makeCursorSession(root, {
      agentId: "sess-tools",
      blobs: [
        userQueryMsg("do stuff", { timestamp: T1 }),
        assistantMsg({
          text: "on it",
          toolCalls: [
            { id: compoundId, name: "Shell", args: { command: "rm -rf /API_KEY=supersecretvalue123456", description: "danger" } },
            { id: "call-2", name: "Read", args: { path: "/repo/proj/AGENTS.md" } },
            { id: "call-3", name: "Grep", args: { pattern: "TODO", glob: "*.ts" } },
            { id: "call-4", name: "Write", args: { path: "/repo/proj/out.txt", contents: "SECRET_FILE_CONTENTS_BODY" } },
            { id: "call-5", name: "Read", args: { path: "/Users/leakname/proj/AGENTS.md" } },
          ],
        }),
        toolMsg(compoundId, { result: "ran" }),
      ],
    });
    const parsed = readCursor(root);
    const s = parsed.sessions[0];
    const toolUses = s.messages.flatMap((m) => m.toolUses);
    const byId = Object.fromEntries(toolUses.map((u) => [u.id, u]));
    assert.equal(byId[compoundId].name, "Bash");
    assert.ok(byId[compoundId].cmd.startsWith("rm -rf /"));
    assert.ok(byId[compoundId].cmd.includes("⟨secret⟩"), "API key in the command must be redacted");
    assert.equal(byId["call-2"].name, "Read");
    assert.equal(byId["call-2"].path, "/repo/proj/AGENTS.md");
    assert.equal(byId["call-3"].name, "Grep");
    assert.equal(byId["call-3"].q, "TODO");
    assert.equal(byId["call-4"].name, "Write");
    assert.equal(byId["call-4"].path, "/repo/proj/out.txt");
    assert.equal(byId["call-5"].path, "/Users/⟨user⟩/proj/AGENTS.md", "a toolUse path under /Users/<name> must be redacted like any other path");

    const toolResults = s.messages.flatMap((m) => m.toolResults);
    assert.equal(toolResults.length, 1);
    assert.equal(toolResults[0].forId, compoundId, "compound id with embedded newline must round-trip verbatim");

    const dump = JSON.stringify(parsed);
    assert.ok(!dump.includes("SECRET_FILE_CONTENTS_BODY"), "Write's contents must never be stored");
    assert.ok(!dump.includes("leakname"), "username in a toolUse path must be redacted");
  });
});

// ── 6. isError + bytes ──

test("tool-result: isError true from highLevelToolCallResult; bytes computed; result content never stored", { skip: sqlite ? false : "node:sqlite unavailable" }, () => {
  withRoot((root) => {
    makeCursorSession(root, {
      agentId: "sess-error",
      blobs: [
        userQueryMsg("run something", { timestamp: T1 }),
        assistantMsg({ text: "trying", toolCalls: [{ id: "call-e1", name: "Shell", args: { command: "false" } }] }),
        toolMsg("call-e1", { result: "SECRET_ERROR_OUTPUT_TEXT boom", isError: true }),
      ],
    });
    const parsed = readCursor(root);
    const s = parsed.sessions[0];
    const [tr] = s.messages.flatMap((m) => m.toolResults);
    assert.equal(tr.forId, "call-e1");
    assert.equal(tr.isError, true);
    assert.equal(tr.bytes, JSON.stringify("SECRET_ERROR_OUTPUT_TEXT boom").length);
    const dump = JSON.stringify(parsed);
    assert.ok(!dump.includes("SECRET_ERROR_OUTPUT_TEXT"), "tool-result content leaked into the bundle");
  });
});

// ── 7. usage always null ──

test("usage: null on every message (cursor persists no per-message token usage)", { skip: sqlite ? false : "node:sqlite unavailable" }, () => {
  withRoot((root) => {
    makeCursorSession(root, {
      agentId: "sess-usage",
      blobs: [userQueryMsg("go", { timestamp: T1 }), assistantMsg({ text: "went", toolCalls: [{ id: "c1", name: "Read", args: { path: "/x" } }] }), toolMsg("c1")],
    });
    const parsed = readCursor(root);
    for (const m of parsed.sessions[0].messages) assert.equal(m.usage, null);
  });
});

// ── 8. malformed JSON blob + missing blob hash ──

test("malformed JSON blob increments files[].malformed and is skipped; a root referencing a missing blob hash is skipped without throwing", { skip: sqlite ? false : "node:sqlite unavailable" }, () => {
  withRoot((root) => {
    makeCursorSession(root, {
      agentId: "sess-malformed",
      blobs: [
        userQueryMsg("first", { timestamp: T1 }),
        { raw: Buffer.from("{not valid json,,,") }, // malformed: first byte '{' but JSON.parse fails
        { missing: true }, // field-1 references a hash never inserted into blobs
        userQueryMsg("second", { timestamp: T2 }),
      ],
    });
    assert.doesNotThrow(() => readCursor(root));
    const parsed = readCursor(root);
    assert.equal(parsed.sessions.length, 1);
    const s = parsed.sessions[0];
    assert.equal(s.messages.length, 2, "only the two valid user messages should survive");
    assert.deepEqual(s.messages.map((m) => m.textRedacted.trim()), ["first", "second"]);
    assert.equal(parsed.files.length, 1);
    assert.equal(parsed.files[0].malformed, 1);
  });
});

// ── 9. protobuf walker unit test ──

test("pbFields: hand-encoded fields 1(x3)/9/22/26(>2^32) round-trip; unknown wire type bails gracefully", () => {
  const h1 = Buffer.alloc(32, 1);
  const h2 = Buffer.alloc(32, 2);
  const h3 = Buffer.alloc(32, 3);
  const bigTs = 5_000_000_000_000; // > 2^32 (4294967296)
  const buf = Buffer.concat([
    fieldBytes(1, h1),
    fieldBytes(1, h2),
    fieldBytes(1, h3),
    fieldString(9, "file:///Users/x/proj"),
    fieldString(22, "cli"),
    fieldVarint(26, bigTs),
    fieldFixed32(15), // wire type 5 (skip 4 bytes) must not corrupt subsequent parsing... but it's the LAST field here
  ]);
  const fields = pbFields(buf);
  assert.equal(fields.get(1).length, 3);
  assert.deepEqual([...fields.get(1)[0]], [...h1]);
  assert.deepEqual([...fields.get(1)[2]], [...h3]);
  assert.equal(Buffer.from(fields.get(9)[0]).toString("utf8"), "file:///Users/x/proj");
  assert.equal(Buffer.from(fields.get(22)[0]).toString("utf8"), "cli");
  assert.equal(fields.get(26)[0], bigTs);
  assert.ok(bigTs > 2 ** 32, "sanity: the test timestamp must actually exceed 32 bits");

  // wt5 and wt1 skip correctly when followed by more fields.
  const buf2 = Buffer.concat([fieldFixed32(2, 0xdeadbeef), fieldFixed64(3, 123n), fieldString(9, "after-fixed-fields")]);
  const fields2 = pbFields(buf2);
  assert.equal(Buffer.from(fields2.get(9)[0]).toString("utf8"), "after-fixed-fields");

  // Unknown wire type (6) must bail without throwing, returning fields parsed before it.
  const badTag = encodeTag(30, 6); // wire type 6 does not exist in proto3
  const buf3 = Buffer.concat([fieldString(9, "before-bad-tag"), badTag, fieldString(9, "never-reached")]);
  assert.doesNotThrow(() => pbFields(buf3));
  const fields3 = pbFields(buf3);
  assert.equal(fields3.get(9).length, 1, "only the field before the unknown wire type should be parsed");
  assert.equal(Buffer.from(fields3.get(9)[0]).toString("utf8"), "before-bad-tag");
});

// ── 10. absent root / unreadable db ──

test("absent root returns an EMPTY bundle; an unreadable (garbage) store.db is skipped with stats.unreadableSessions = 1", { skip: sqlite ? false : "node:sqlite unavailable" }, () => {
  const missing = join(tmpdir(), "cursor-does-not-exist-" + Math.random().toString(36).slice(2));
  const empty = readCursor(missing);
  assert.equal(empty.source, "cursor");
  assert.deepEqual(empty.sessions, []);
  assert.deepEqual(empty.files, []);
  assert.equal(empty.stats.backend, null);

  withRoot((root) => {
    const dir = join(root, "deadbeefdeadbeefdeadbeefdeadbeef", "22222222-2222-2222-2222-222222222222");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "store.db"), Buffer.from("this is not a sqlite database at all"));
    assert.doesNotThrow(() => readCursor(root));
    const parsed = readCursor(root);
    assert.equal(parsed.sessions.length, 0);
    assert.equal(parsed.stats.unreadableSessions, 1);
  });
});

// ── 11. title never stored ──

test("PRIVACY: meta.name (the conversation title) never appears anywhere in the serialized bundle", { skip: sqlite ? false : "node:sqlite unavailable" }, () => {
  withRoot((root) => {
    makeCursorSession(root, {
      agentId: "sess-title",
      name: "SECRET_TITLE_never_stored",
      blobs: [userQueryMsg("hello", { timestamp: T1 }), assistantMsg({ text: "hi" })],
    });
    const parsed = readCursor(root);
    const dump = JSON.stringify(parsed);
    assert.ok(!dump.includes("SECRET_TITLE_never_stored"), "conversation title leaked into the bundle");
  });
});

// ── 12. lens smoke-run ──

test("smoke: bundle flows through buildDigest + computeAgenticLiteracy + computeIntensity without throwing, session is counted", { skip: sqlite ? false : "node:sqlite unavailable" }, () => {
  withRoot((root) => {
    makeCursorSession(root, {
      agentId: "sess-smoke",
      cwd: "/Users/synthetic/product",
      blobs: [
        userQueryMsg("fix the bug in app.py", { timestamp: T1 }),
        assistantMsg({ modelName: "cursor-grok-4.5-high-fast", text: "fixed it, tests pass", toolCalls: [{ id: "call-1", name: "Shell", args: { command: "pytest" } }] }),
        toolMsg("call-1", { result: "all green" }),
      ],
    });
    const parsed = mergeSources(readCursor(root));
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

// ── extra: defaultCursorRoot shape (no filesystem assumptions) ──

test("defaultCursorRoot points at ~/.cursor/chats", () => {
  const p = defaultCursorRoot();
  assert.ok(p.endsWith(join(".cursor", "chats")), p);
});

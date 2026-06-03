// Internal-consistency forensics.
//
// None of these prove authenticity — logs are unsigned and the file is fully
// under the candidate's control. What they catch is the *cheap* fake: a hand
// edited transcript, a generated highlight reel, someone else's logs stitched
// in. A real session keeps timestamps, uuid chains, token accounting and
// tool pairing mutually consistent for free; a forgery has to keep all of them
// consistent at once, which is where it slips. The live reproduction gate is
// what handles the expensive fakes.
//
// Hardening note: every threshold here was calibrated against KNOWN-GENUINE
// logs that initially tripped naive checks. Claude Code interleaves sub-agent
// sidechains, resumes sessions across files, and injects <synthetic> messages —
// so "file order = time order" and "cache_read needs an earlier cache_write in
// this session" are both false. We check causality along the parent→child DAG
// (with clock-skew tolerance) and judge token caching dataset-wide. See
// test/forensics.test.mjs for the regression fixtures.

const now = () => Date.now();
const ms = (iso) => (iso ? Date.parse(iso) : NaN);
const SKEW_TOLERANCE_MS = 2000;
const SYNTHETIC = "<synthetic>";

function check(id, label, severity, status, detail) {
  return { id, label, severity, status, detail };
}

export function computeForensics(parsed) {
  const checks = [];
  const sessions = parsed.sessions;

  // Global maps across all files/sidechains: a parent may live in another file
  // of the same (resumed or sub-agent) session.
  const tsByUuid = new Map();
  const parentByUuid = new Map();
  for (const s of sessions)
    for (const c of s.chain) {
      if (c.uuid) {
        tsByUuid.set(c.uuid, ms(c.ts));
        parentByUuid.set(c.uuid, c.parentUuid ?? null);
      }
    }

  // 1. Malformed JSONL lines — a clean log has none.
  const malformed = parsed.files.reduce((n, f) => n + f.malformed, 0);
  checks.push(
    malformed === 0
      ? check("malformed_lines", "JSONL ben formato", "high", "pass", "nessuna riga corrotta")
      : check("malformed_lines", "JSONL ben formato", "high", "flag", `${malformed} righe non parsabili`),
  );

  // 2. UUID chain integrity — non-null parents must resolve in the global set.
  //    A handful of unresolved parents are normal resume boundaries.
  let orphans = 0;
  let withParent = 0;
  for (const [uuid, parent] of parentByUuid) {
    if (parent) {
      withParent++;
      if (!tsByUuid.has(parent)) orphans++;
    }
  }
  const orphanRate = withParent ? orphans / withParent : 0;
  checks.push(
    orphanRate <= 0.01
      ? check("uuid_chain", "Catene UUID integre", "high", "pass", `${withParent} archi, ${orphans} orfani (${(orphanRate * 100).toFixed(2)}%)`)
      : check("uuid_chain", "Catene UUID integre", "high", "flag", `${orphans}/${withParent} genitori irrisolti (${(orphanRate * 100).toFixed(1)}%)`),
  );

  // 3. Causal ordering: a child must not predate its parent (beyond clock skew).
  let causalViol = 0;
  let edges = 0;
  for (const [uuid, parent] of parentByUuid) {
    if (parent && tsByUuid.has(parent)) {
      const cu = tsByUuid.get(uuid);
      const pu = tsByUuid.get(parent);
      if (Number.isFinite(cu) && Number.isFinite(pu)) {
        edges++;
        if (cu < pu - SKEW_TOLERANCE_MS) causalViol++;
      }
    }
  }
  // Flag by rate, not count: months of sessions accumulate a few sub-2s clock
  // corrections (sleep/NTP) past tolerance; mass timestamp editing would not.
  const causalRate = edges ? causalViol / edges : 0;
  checks.push(
    causalRate <= 0.005
      ? check("ts_causal", "Ordine causale dei timestamp", "high", "pass", `${edges} archi, ${causalViol} oltre tolleranza (${(causalRate * 100).toFixed(3)}%)`)
      : check("ts_causal", "Ordine causale dei timestamp", "high", "flag", `${causalViol}/${edges} figli datati prima del genitore (${(causalRate * 100).toFixed(1)}%)`),
  );

  // 4. No future timestamps.
  let future = 0;
  const t0 = now();
  for (const t of tsByUuid.values()) if (t > t0) future++;
  checks.push(
    future === 0
      ? check("ts_future", "Nessun timestamp nel futuro", "high", "pass", "ok")
      : check("ts_future", "Nessun timestamp nel futuro", "high", "flag", `${future} eventi datati nel futuro`),
  );

  // 5. ID prefixes (Anthropic: req_… / msg_…). Skip <synthetic> harness messages.
  let badId = 0;
  let idTotal = 0;
  for (const s of sessions)
    for (const m of s.messages)
      if (m.role === "assistant" && m.model && m.model !== SYNTHETIC) {
        idTotal++;
        const okReq = !m.requestId || m.requestId.startsWith("req_");
        const okMsg = !m.messageId || m.messageId.startsWith("msg_");
        if (!okReq || !okMsg) badId++;
      }
  checks.push(
    badId === 0
      ? check("id_format", "Formato ID coerente", "medium", "pass", `${idTotal} messaggi assistant`)
      : check("id_format", "Formato ID coerente", "medium", "flag", `${badId} ID con prefisso anomalo`),
  );

  // 6. Token accounting, dataset-wide. Per-session is unreliable (resumes read a
  //    cache created by a prior process), so only a global impossibility flags.
  let cacheRead = 0, cacheCreate = 0, withUsage = 0;
  for (const s of sessions)
    for (const m of s.messages)
      if (m.usage) {
        withUsage++;
        cacheRead += m.usage.cacheRead;
        cacheCreate += m.usage.cacheCreate;
      }
  const cacheImpossible = cacheRead > 0 && cacheCreate === 0;
  checks.push(
    !cacheImpossible
      ? check("token_accounting", "Contabilità token coerente", "low", "pass", `${withUsage} messaggi con usage, cache create/read = ${cacheCreate}/${cacheRead}`)
      : check("token_accounting", "Contabilità token coerente", "low", "flag", `cache-read ${cacheRead} senza alcuna cache-write nel dataset`),
  );

  // 7. Tool pairing: every tool_use should have a matching tool_result.
  let unmatched = 0;
  let toolUses = 0;
  for (const s of sessions) {
    const resultIds = new Set();
    for (const m of s.messages) for (const r of m.toolResults) resultIds.add(r.forId);
    for (const m of s.messages)
      for (const u of m.toolUses) {
        toolUses++;
        if (!resultIds.has(u.id)) unmatched++;
      }
  }
  const unmatchedRate = toolUses ? unmatched / toolUses : 0;
  checks.push(
    unmatchedRate <= 0.02
      ? check("tool_pairing", "Pairing tool_use/result", "medium", "pass", `${toolUses} chiamate, ${unmatched} senza risultato`)
      : check("tool_pairing", "Pairing tool_use/result", "medium", "flag", `${unmatched}/${toolUses} chiamate senza risultato (${(unmatchedRate * 100).toFixed(0)}%)`),
  );

  // Score: weighted deductions. A screen, not a verdict.
  const weights = { high: 25, medium: 12, low: 5 };
  let score = 100;
  for (const c of checks) if (c.status === "flag") score -= weights[c.severity] || 5;
  score = Math.max(0, score);

  return { score, checks };
}

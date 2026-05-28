// Trajectory: what changed in how this person works over the window.
//
// Three deterministic signals, each computed across ALL sessions (not per
// project), splitting the window in half by time:
//
//   1. Behavioral shifts — same metric measured early vs late.
//      Median prompt length, delegation rate, research:mutation, verification
//      frequency. Each gets a magnitude (number) and a direction tag.
//
//   2. Topic clusters — web queries grouped by theme, chronological. Tells
//      the cultural reading list, not just "which framework".
//
//   3. New vocabulary — words that show up only in the late half AND recur
//      across multiple distinct prompts (one-offs filtered out).
//
// Output goes into the digest, the candidate.json (under `trajectory`), and is
// rendered both in profile.md and on the dashboard detail page.

const ms = (iso) => (iso ? Date.parse(iso) : NaN);

const MUTATION = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const RESEARCH = new Set(["Read", "Grep", "Glob", "WebSearch", "WebFetch"]);
const DELEGATION = new Set(["Task", "Agent"]);
const CHECK_RE = /\b(eslint|tsc|typecheck|playwright|npm (run )?(build|test)|pnpm (build|test)|vitest|jest)\b/i;

// Theme clusters for web queries — broad on purpose. The point is to surface
// the cultural reading list, not to classify with precision.
const TOPIC_RULES = [
  ["agent architecture", /agent|mcp\b|skill|claude code|subagent|orchestrat|sdk/i],
  ["design & UI", /design|typograph|figma|swiss|grid|color|spacing|aesthet|ui\b|notebooklm|shadcn/i],
  ["security & auth", /auth\b|oauth|jwt|rls|injection|security|csrf|cors|encryption/i],
  ["dev tooling", /eslint|prettier|tsc|playwright|vitest|jest|next\.config|build|vercel|deploy/i],
  ["data & schema", /supabase|postgres|sql|schema|migration|drizzle|prisma|index\b/i],
  ["AI patterns", /prompt|caching|tool use|streaming|context window|anthropic|llm\b|reasoning/i],
  ["business & domain", /booking\.com|hotel|venue|invoice|fic\b|crm|brand|creator|youtube|instagram|tiktok/i],
];

// Stop words: common function words in EN and IT, plus high-frequency
// non-content words specific to coding chats. The signal we want is concepts
// adopted, not connective tissue.
const STOPWORDS = new Set([
  // EN function words
  "the","and","for","with","this","that","from","into","onto","when","then","else","over","than","more","less",
  "have","has","had","what","which","there","here","just","also","like","want","need","make","made","does","done","very",
  "these","those","some","other","such","each","both","most","many","much","only","even","still","they",
  "their","them","your","yours","ours","mine","about","after","before","while","where","because","been",
  "being","its","not","but","can","cannot","could","would","should","shall","will","please","using","use","used","one","two",
  "let","yes","okay","fine","needs","got","get","see","look","files","file","line","code","thanks","really","truly",
  "say","said","saying","tell","told","think","thought","know","knew","known","find","found","right","wrong",
  "good","bad","new","old","next","previous","last","first","second","third","another","example","every","always","never",
  "between","without","within","through","throughout","across","along","around","without","via","per","upon","unless","until",
  "instead","whether","though","although","however","therefore","thus","hence","indeed","actually","essentially",
  // IT function words and very common verbs
  "puoi","sono","sei","della","dello","delle","degli","alla","allo","alle","agli","negli","nello","nelle",
  "questo","questa","questi","queste","cosa","come","dove","quando","perche","perché","tutto","tutti","tutte",
  "anche","molto","solo","ancora","gia","già","mai","sempre","ora","adesso","forse","tipo","fatto","fare","fai",
  "ho","ha","hai","hanno","cui","gli","io","tu","lui","lei","loro","noi","voi","della","del","dell","nel",
  "facciamo","faccio","facevo","fece","fatto","fatti","fatta","fatte","detto","detti","dico","dici","dice",
  "vedere","vedo","vedi","vede","visto","vista","visti","viste","quello","quella","quelli","quelle","quale",
  "ecco","poi","quindi","invece","mentre","sotto","sopra","sempre","ancora","subito","spesso","mai","ogni",
  "altro","altra","altri","altre","stesso","stessa","stessi","stesse","prima","dopo","durante","oltre",
  "perfetto","esempio","esempi","parte","parti","modo","modi","cose","cosa","caso","casi","punto","punti",
  "magari","credo","penso","pensavo","sembra","sembrava","mostra","mostri","mostro","metti","metto","mette","messo",
  "vorrei","volere","voglio","vogliamo","puoi","posso","possiamo","può","possono","provo","provare","prova",
  "fammi","dimmi","sai","so","sappiamo","sapere","capito","capire","capisco","grazie","ciao","salve",
  "che","chi","con","per","tra","fra","una","uno","una","alle","del","dal","dai","dagli","sulle","sui","sul",
  "avere","aver","mettere","dentro","fuori","sopra","tutta","senso","giusto","nulla","niente","forse","probabilmente",
  "molto","poco","spesso","mai","sempre","ovviamente","sicuramente","ovvio","semplice","facile","difficile","meglio","peggio",
]);

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function direction(early, late, threshold = 0.15) {
  if (early == null || late == null) return "n/a";
  if (early === 0 && late === 0) return "stable";
  const base = Math.max(Math.abs(early), 1e-9);
  const delta = (late - early) / base;
  if (Math.abs(delta) < threshold) return "stable";
  return delta > 0 ? "up" : "down";
}

// Split sessions by their first timestamp at the midpoint of the global window.
function splitHalves(parsed) {
  const sessTs = parsed.sessions
    .map((s) => ({ s, t: Number.isFinite(ms(s.firstTs)) ? ms(s.firstTs) : null }))
    .filter((x) => x.t != null)
    .sort((a, b) => a.t - b.t);
  if (sessTs.length < 4) return { early: [], late: [], midpoint: null };
  const tMin = sessTs[0].t;
  const tMax = sessTs.at(-1).t;
  const mid = (tMin + tMax) / 2;
  return {
    early: sessTs.filter((x) => x.t < mid).map((x) => x.s),
    late: sessTs.filter((x) => x.t >= mid).map((x) => x.s),
    midpoint: new Date(mid).toISOString().slice(0, 7),
  };
}

// Exclude system-injected user messages from the median: compaction summary
// requests are 1000+ words and dwarf the candidate's own input, and task
// notifications are XML noise.
const SYSTEM_PROMPT_RE = /^(<task-notification>|Your task is to create a detailed summary of the conversation|This session is being continued from a previous conversation)/i;

function metricsFor(sessions) {
  let userMsgs = 0;
  let delegations = 0;
  let mutations = 0;
  let research = 0;
  const promptWords = [];
  let sessWithChecks = 0;

  for (const s of sessions) {
    let hasCheck = false;
    for (const m of s.messages) {
      if (m.role === "user" && m.textRedacted.trim() && !SYSTEM_PROMPT_RE.test(m.textRedacted.trim())) {
        userMsgs++;
        const w = m.textRedacted.trim().split(/\s+/).length;
        if (w > 0) promptWords.push(w);
      }
      for (const u of m.toolUses) {
        if (DELEGATION.has(u.name)) delegations++;
        if (MUTATION.has(u.name)) mutations++;
        if (RESEARCH.has(u.name)) research++;
        if (u.cmd && CHECK_RE.test(u.cmd)) hasCheck = true;
      }
    }
    if (hasCheck) sessWithChecks++;
  }

  return {
    sessions: sessions.length,
    medianPromptWords: median(promptWords),
    delegationRate: userMsgs ? +(delegations / userMsgs).toFixed(3) : 0,
    researchToMutation: mutations ? +(research / mutations).toFixed(2) : null,
    verificationRate: sessions.length ? +(sessWithChecks / sessions.length).toFixed(2) : 0,
  };
}

function computeShifts(parsed) {
  const { early, late, midpoint } = splitHalves(parsed);
  if (!early.length || !late.length) return { available: false };
  const e = metricsFor(early);
  const l = metricsFor(late);
  return {
    available: true,
    midpoint,
    early: e,
    late: l,
    deltas: [
      { metric: "median prompt words",  format: "number",  early: e.medianPromptWords,   late: l.medianPromptWords,   dir: direction(e.medianPromptWords, l.medianPromptWords) },
      { metric: "delegation rate",      format: "percent", early: e.delegationRate,      late: l.delegationRate,      dir: direction(e.delegationRate, l.delegationRate) },
      { metric: "research:mutation",    format: "ratio",   early: e.researchToMutation,  late: l.researchToMutation,  dir: direction(e.researchToMutation, l.researchToMutation) },
      { metric: "verification rate",    format: "percent", early: e.verificationRate,    late: l.verificationRate,    dir: direction(e.verificationRate, l.verificationRate) },
    ],
  };
}

function computeTopics(parsed) {
  const buckets = new Map(); // quarter -> theme -> count
  for (const s of parsed.sessions) {
    for (const m of s.messages) {
      for (const u of m.toolUses) {
        if (!u.q) continue;
        const t = ms(m.ts);
        if (!Number.isFinite(t)) continue;
        const q = `${new Date(t).getUTCFullYear()}-Q${Math.floor(new Date(t).getUTCMonth() / 3) + 1}`;
        let theme = "other";
        for (const [name, re] of TOPIC_RULES) if (re.test(u.q)) { theme = name; break; }
        if (theme === "other") continue;
        if (!buckets.has(q)) buckets.set(q, new Map());
        const m2 = buckets.get(q);
        m2.set(theme, (m2.get(theme) || 0) + 1);
      }
    }
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([quarter, themes]) => ({
      quarter,
      themes: [...themes.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([name, count]) => ({ name, count })),
    }));
}

function computeNewVocabulary(parsed) {
  const earlyTs = [];
  // First pass to find median session timestamp = "midpoint"
  for (const s of parsed.sessions) if (s.firstTs && ms(s.firstTs)) earlyTs.push(ms(s.firstTs));
  if (earlyTs.length < 6) return [];
  earlyTs.sort((a, b) => a - b);
  const mid = earlyTs[Math.floor(earlyTs.length / 2)];

  // word -> { firstSeenTs, latePrompts, total }
  // Note: we deliberately DON'T filter proper nouns. A capitalised word can be
  // a client name (problem) but also a researcher, a framework, a library
  // (signal). Distinguishing is hard automatically; the candidate sees the
  // list before submission and can regenerate if anything looks off.
  const word = new Map();
  const promptId = (s, m) => `${s.sessionId}:${m.uuid || m.ts}`;
  const wordRe = /[A-Za-z][A-Za-z-]{3,}/g;

  for (const s of parsed.sessions) {
    for (const m of s.messages) {
      if (m.role !== "user" || !m.textRedacted) continue;
      if (SYSTEM_PROMPT_RE.test(m.textRedacted.trim())) continue;
      const t = ms(m.ts);
      if (!Number.isFinite(t)) continue;
      const seen = new Set();
      const pid = promptId(s, m);
      const tokens = m.textRedacted.toLowerCase().match(wordRe) || [];
      for (const w of tokens) {
        if (STOPWORDS.has(w)) continue;
        if (seen.has(w)) continue;
        seen.add(w);
        if (!word.has(w)) word.set(w, { first: t, latePrompts: new Set(), total: 0 });
        const entry = word.get(w);
        entry.total++;
        if (t < entry.first) entry.first = t;
        if (t >= mid) entry.latePrompts.add(pid);
      }
    }
  }

  const candidates = [];
  for (const [w, e] of word) {
    if (e.first >= mid && e.latePrompts.size >= 3) {
      candidates.push({ word: w, count: e.total, distinctLate: e.latePrompts.size });
    }
  }
  candidates.sort((a, b) => b.distinctLate - a.distinctLate || b.count - a.count);
  return candidates.slice(0, 12).map((c) => c.word);
}

export function buildTrajectory(parsed) {
  return {
    shifts: computeShifts(parsed),
    topics: computeTopics(parsed),
    newVocabulary: computeNewVocabulary(parsed),
  };
}

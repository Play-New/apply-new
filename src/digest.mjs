// Per-project digest: the deep, LLM-ready material the profile is written from.
//
// Beyond sampled prompts, this reconstructs project CONTEXT from the tool inputs
// (the files touched draw the domain), detects the stack, reads "landing"
// signals (did checks run, did work get committed vs reverted), and the
// learning trajectory (what was searched for). Everything stays redacted and
// keyed by repo, so worktrees of one product collapse into one project.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ms = (iso) => (iso ? Date.parse(iso) : NaN);
const month = (iso) => (iso ? new Date(ms(iso)).toISOString().slice(0, 7) : null);

const DELEGATION = new Set(["Task", "Agent"]);
const PLANNING = new Set(["TodoWrite", "ExitPlanMode"]);
const MUTATION = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const RESEARCH = new Set(["Read", "Grep", "Glob", "WebSearch", "WebFetch"]);

// Ephemeral sandboxes (background tasks) are not real projects. Anchored to
// the scratch ROOTS (/tmp, /var/folders, with the macOS /private alias) —
// matching anywhere in the path silently dropped real projects under
// directories merely named tmp/ or private/ (e.g. ~/tmp/scratchpad-app).
const isEphemeral = (cwd) => /^\/(?:private\/)?(?:tmp|var\/folders)\//.test(cwd);

// Cluster sessions by product: the repo segment of the working dir.
function repoKey(cwd) {
  const m = cwd.match(/\/(?:Github|github|repos?|Projects|Desktop|src|code|dev|work)\/([^/]+)/);
  if (m) return m[1];
  const parts = cwd.split("/").filter((p) => p && p !== "⟨user⟩" && p !== "Users");
  return parts.at(-1) || "unknown";
}

// Reduce an absolute (redacted) path to a 2-3 level repo-relative "area".
function toArea(path, key) {
  const i = path.indexOf("/" + key + "/");
  if (i < 0) return null;
  let parts = path.slice(i + key.length + 2).split("/").filter(Boolean);
  if (parts.length > 1 && /(-(app|web|api|server|client))$|^(apps|packages|src|web|app)$/.test(parts[0])) {
    parts = parts.slice(1);
  }
  return parts.slice(0, 3).join("/") || null;
}

// --- Stack detection -------------------------------------------------------
//
// Two evidence streams, merged. They answer different questions and both belong:
//   1. package.json DEPENDENCIES across workspaces — what the project *uses*.
//   2. The files and commands the sessions actually TOUCHED — what the candidate
//      *worked with*, anchored to evidence (file extensions + command text).
//
// We never read .env, not even key names (CONTRIBUTING: privacy — "the tool
// never opens your secrets file"). The cost is that services integrated only
// over REST (an API key, no npm package) are not auto-detected; that is a
// disclosed boundary (see the stack note in src/profile.mjs), not a silent miss.
//
// Path heuristics are NOT used for libraries: a route that contains the word
// "prisma" or a stray vite.config is not evidence the project depends on it.
// Libraries come from dependencies; languages/formats from touched extensions;
// runnable tools from command text.

// File extension -> language/format label. The "extension tally": a touched
// file is direct evidence the candidate worked with that language/format.
const EXT_LABELS = {
  py: "Python", rb: "Ruby", go: "Go", rs: "Rust", java: "Java", kt: "Kotlin",
  swift: "Swift", php: "PHP", sql: "SQL", sh: "Shell", vue: "Vue",
  svelte: "Svelte", mdx: "MDX", tf: "Terraform", proto: "Protobuf",
};

// Command-text evidence: tools that surface in what the candidate actually RAN
// and that dependency scanning can't see (Python-ecosystem tools, deploy CLIs).
// LIBRARIES are deliberately NOT detected here — they come from dependencies
// only, so a library merely mentioned in a command never becomes a false
// positive (this is what produced the spurious "Prisma" the issue flagged).
// Anchored to a whitespace-delimited token so `cat docs/fastapi-notes.md` does
// NOT match — only a tool in executable/argument position does.
const CMD_LABELS = [
  [/(?:^|\s)(?:uvicorn|fastapi|starlette)(?:\s|$)/im, "FastAPI"],
  [/(?:^|\s)pytest(?:\s|$)/im, "pytest"],
  [/(?:^|\s)wrangler(?:\s|$)/im, "Cloudflare"],
];

// Dependency name -> label. Authoritative for libraries.
const DEP_LABELS = [
  [/^next$|^react$/, "Next.js/React"], [/^typescript$/, "TypeScript"], [/^vite$/, "Vite"],
  [/supabase/, "Supabase"], [/^pg$|^postgres/, "Postgres"], [/^firebase/, "Firebase/Firestore"],
  [/inngest/, "Inngest (event-driven jobs)"], [/strapi/, "Strapi (headless CMS)"], [/cloudinary/, "Cloudinary"],
  [/^stripe$/, "Stripe"], [/next-auth/, "NextAuth"], [/resend/, "Resend (email)"],
  [/posthog/, "PostHog (analytics)"], [/anthropic/, "Anthropic SDK"], [/^openai$/, "OpenAI"],
  [/google\/gen|generative-ai/, "Google Gemini"], [/elevenlabs/, "ElevenLabs"], [/vercel/, "Vercel"],
  [/tailwind/, "Tailwind"], [/shadcn/, "shadcn/ui"], [/radix/, "Radix UI"],
  [/framer-motion/, "Framer Motion"], [/recharts/, "Recharts"], [/tiptap/, "TipTap (rich text)"],
  [/react-pdf|jspdf/, "React-PDF"], [/puppeteer|chromium/, "Puppeteer (PDF)"], [/^docx$|mammoth/, "docx/mammoth"],
  [/mdx/, "MDX"], [/react-hook-form/, "React Hook Form"], [/^zod$/, "Zod"],
  [/vitest/, "Vitest"], [/playwright/, "Playwright (E2E)"], [/^turbo$|turborepo/, "Turborepo (monorepo)"],
  [/^prisma$|@prisma/, "Prisma"], [/drizzle-orm/, "Drizzle"],
];

const readJSON = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

// Resolve a working dir to its repo root: the nearest ancestor holding a .git
// entry (the repo boundary). A session run in a subdir (e.g. apps/web) thus
// scans the whole repo, not just its corner. Falls back to the dir itself.
function findRepoRoot(cwd) {
  let dir = cwd;
  for (let i = 0; i < 64 && dir; i++) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dir.slice(0, dir.lastIndexOf("/"));
    if (!parent || parent === dir) break;
    dir = parent;
  }
  return cwd;
}

function listDirs(parent) {
  if (!existsSync(parent)) return [];
  try { return readdirSync(parent, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(parent, e.name)); }
  catch { return []; }
}

// Workspace package dirs: honor the root package.json "workspaces" globs when
// present (npm/yarn array, or { packages: [...] }); fall back to the common
// apps/* + packages/* layout otherwise.
function workspaceDirs(root, rootPkg) {
  const globs = Array.isArray(rootPkg?.workspaces) ? rootPkg.workspaces
    : Array.isArray(rootPkg?.workspaces?.packages) ? rootPkg.workspaces.packages : null;
  if (!globs) return [...listDirs(join(root, "apps")), ...listDirs(join(root, "packages"))];
  const dirs = [];
  for (const g of globs) {
    if (g.endsWith("/*")) dirs.push(...listDirs(join(root, g.slice(0, -2))));
    else dirs.push(join(root, g));
  }
  return dirs;
}

// Dependency names across the repo root and its workspaces. npm manifests only.
function workspaceDepNames(root) {
  const names = new Set();
  const rootPkgPath = join(root, "package.json");
  const rootPkg = readJSON(rootPkgPath);
  const pkgPaths = rootPkg ? [rootPkgPath] : [];
  for (const d of workspaceDirs(root, rootPkg)) {
    const pj = join(d, "package.json");
    if (existsSync(pj)) pkgPaths.push(pj);
  }
  for (const pj of pkgPaths) {
    const j = readJSON(pj);
    if (j) for (const k of Object.keys({ ...(j.dependencies || {}), ...(j.devDependencies || {}) })) names.add(k.toLowerCase());
  }
  return names;
}

// Merge the two evidence streams into one deduped stack list. Exported so it can
// be unit-tested against an on-disk fixture directly (buildDigest applies the
// ephemeral-path filter, which would drop a fixture created under /tmp).
export function detectStack({ cwdRaw, exts, cmdsText }) {
  const labels = new Set();
  if (cwdRaw && existsSync(cwdRaw)) {
    for (const name of workspaceDepNames(findRepoRoot(cwdRaw))) {
      for (const [re, l] of DEP_LABELS) if (re.test(name)) labels.add(l);
    }
  }
  for (const ext of Object.keys(exts || {})) if (EXT_LABELS[ext]) labels.add(EXT_LABELS[ext]);
  for (const [re, l] of CMD_LABELS) if (re.test(cmdsText || "")) labels.add(l);
  return [...labels];
}

// Every label the detector can emit. Exported so the groundedness verifier
// derives its tech lexicon from the SAME source as detection (tokenising these
// the same way it tokenises the stack), instead of a separate hardcoded list
// that silently drifts as the maps grow.
export function labelVocabulary() {
  return [...new Set([...Object.values(EXT_LABELS), ...CMD_LABELS.map(([, l]) => l), ...DEP_LABELS.map(([, l]) => l)])];
}

// First cwd in a cluster that still exists on disk (else the first seen).
function resolveCwd(cwds, fallback) {
  for (const c of cwds) if (c && existsSync(c)) return c;
  return cwds[0] || fallback || "";
}

// Extension of a (POSIX-normalised) file path, lowercased; null when none.
function fileExt(path) {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,5}$/.test(ext) ? ext : null;
}

function classify(p) {
  const tags = [];
  const days = p.firstTs && p.lastTs ? (p.lastTs - p.firstTs) / 86400000 : 0;
  const areas = p.areasText;
  const htmlHeavy = (areas.match(/\.html/g) || []).length >= 3;

  if (htmlHeavy && p.mutations > 20) tags.push("static-site");
  if (/api\/agent|api\/chat|api\/connectors|\/agents?\//i.test(areas)) tags.push("ai-platform");
  if (/skills?\/[\w.-]+\/SKILL|\/SKILL\.md|commands?\/[\w.-]+\.md/i.test(areas)) tags.push("agent-tooling");
  if (p.researchToMutation != null && p.researchToMutation > 10) tags.push("audit-research");
  if (!tags.includes("static-site")) {
    if (p.mutations > 200 && days > 14) tags.push("product-build");
    else if (p.mutations > 30) tags.push("feature-work");
  }
  if (/migration|schema|\.sql/i.test(areas)) tags.push("data-migration");
  if (/e2e|playwright|\.test\.|\.spec\./i.test(areas)) tags.push("testing");
  if (p.delegation >= 8) tags.push("orchestrated");
  if (p.designQueries >= 5) tags.push("design-research");
  return tags.length ? [...new Set(tags)] : ["exploration"];
}

const DESIGN_RE = /design|ui\b|typograph|layout|figma|css|color|grid|font|spacing|aesthet/i;

// Generic agent-launcher commands: a session that runs one of these dispatched
// work to another agent CLI — evidence of orchestration, independent of any one
// framework. Extend the list as new agent CLIs appear.
//
// A launcher only counts as a dispatch when it is the EXECUTABLE of a
// (sub)command, not a substring of an argument or path: anchored at `^` with a
// trailing `(?=\s|$)`, so `cd my-codex-tests` (codex inside a path) does not
// count while `cd x && opencode run ...` does. `\b` was wrong here precisely
// because `-` is a word boundary, so the old pattern fired inside hyphenated
// tokens. No /i flag: executables are case-sensitive, and case-insensitive
// matching re-admits sentence-initial prose ("Aider is my favorite tool") at
// a fragment start as a phantom dispatch.
//
// Interactive / housekeeping invocations are NOT dispatches — only the
// HEADLESS mode of each launcher is, uniformly: `claude -p`/`--print` (not
// bare `claude`, the REPL), `codex exec` (not `codex login`/`mcp`/`resume`),
// `aider -m`/`--msg`/`--message[-file]` (not bare `aider` or `aider --yes`),
// `cursor-agent -p`/`--print` (not `cursor-agent login`), `pi -p`/`--print`
// (not bare `pi`, the REPL), and `opencode|crush|goose run`. LAUNCHER_FLAGS
// lets ordinary flags (with optional values, quoted or bare) sit between the
// executable and the headless marker, so `claude --model opus -p "x"` still
// counts. aider alone also skips POSITIONAL tokens (`aider app.py -m "fix"`
// is its canonical form, and aider has no subcommands to misread); the
// others stay flags-only so a subcommand's flag never reads as the top-level
// headless marker (`claude mcp add -p x` is not a dispatch).
//
// Every alternative in these fragments is first-char-disjoint on purpose:
// `--?\w` (not `--?[\w-]+`, which parses `--flag` two ways) and a bare value
// that cannot start a quote. Same-span ambiguity under the outer `*` is
// exponential backtracking, and one flag-heavy non-matching command in the
// logs would hang the whole digest.
const LAUNCHER_FLAGS = `(?:--?\\w[\\w-]*(?:=\\S*)?(?:\\s+(?:"[^"]*"|'[^']*'|[^-\\s"']\\S*))?\\s+)*`;
const LAUNCHER_TOKENS = `(?:(?:"[^"]*"|'[^']*'|[^\\s"'])+\\s+)*?`;
const AGENT_LAUNCHER_RE = new RegExp(
  "^(?:" +
    [
      `claude\\s+${LAUNCHER_FLAGS}(?:-p|--print)`,
      `(?:opencode|crush|goose)\\s+${LAUNCHER_FLAGS}run`,
      `codex\\s+${LAUNCHER_FLAGS}exec`,
      `aider\\s+${LAUNCHER_TOKENS}(?:-m|--msg|--message(?:-file)?)`,
      `cursor-agent\\s+${LAUNCHER_FLAGS}(?:-p|--print)`,
      `pi\\s+${LAUNCHER_FLAGS}(?:-p|--print)`,
    ].join("|") +
    ")(?=\\s|$)",
);

// Leading env assignments (`FOO=bar`, `FOO="two words"`, `FOO=a\ b`) before
// the executable. Value atoms are first-char-disjoint (quote, backslash,
// plain) — linear matching, and an escaped space stays part of the value so
// `FOO=a\ claude -p x` correctly leaves `-p` as the executable.
const ENV_ASSIGN_RE = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"(?:[^"\\]|\\.)*"|'[^']*'|\\.|[^\s"'\\])*\s+)+/;

// Drop heredoc bodies before splitting: `cat > run.sh <<'EOF' … EOF` carries
// arbitrary text (often agent-written scripts that themselves mention
// launchers) that never executes in this command. `<<<` here-strings are not
// heredocs; plain `<<` closes only at an unindented delimiter line, `<<-` also
// at a tab-indented one (shell semantics — an indented "EOF" inside a plain
// heredoc is still body, and counting its text would break the lower bound).
// A `<<` inside quoted or commented prose can over-strip the following lines —
// that errs toward undercount, which the lower-bound contract absorbs.
function stripHeredocs(text) {
  if (!text.includes("<<")) return text;
  const out = [];
  let term = null;
  let dashed = false;
  for (const line of text.split("\n")) {
    if (term) {
      if ((dashed ? line.replace(/^\t+/, "") : line) === term) term = null;
      continue;
    }
    out.push(line);
    const m = line.match(/(?<!<)<<(?!<)(-?)\s*(["']?)([A-Za-z_][\w.-]*)\2/);
    if (m) { term = m[3]; dashed = m[1] === "-"; }
  }
  return out.join("\n");
}

// Split a command at top-level shell separators (&&, ||, ;, |, single & and
// newline) with quote awareness: a separator inside '…' or "…" (or escaped)
// is argument text, not a boundary — `git commit -m "a; claude -p b"` is one
// sub-command whose executable is git. A `#` at word start opens a comment
// (skipped to end of line), so an apostrophe in `# can't wait` never opens a
// phantom quote that would swallow the next line's dispatch.
function splitTopLevel(text) {
  const parts = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      cur += c;
      if (c === "\\" && quote === '"' && i + 1 < text.length) cur += text[++i];
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (c === "\\") { cur += c; if (i + 1 < text.length) cur += text[++i]; continue; }
    if (c === "#" && (cur === "" || /\s$/.test(cur))) {
      while (i + 1 < text.length && text[i + 1] !== "\n") i++;
      continue;
    }
    if (c === "&" || c === "|" || c === ";" || c === "\n") {
      parts.push(cur);
      cur = "";
      if ((c === "&" || c === "|") && text[i + 1] === c) i++;
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

// Count agent-launcher invocations in a product's shell history. Heredoc
// bodies are dropped, then each command splits at top-level separators
// (quote-aware) and the matcher sees the executable position of each
// sub-command: leading subshell/brace openers and control-flow keywords
// (`(cd x && claude -p y)`, `do claude -p "$f"`) are transparent, as are env
// assignments. Launchers behind a wrapper (npx/sudo/time) or inside $()
// substitutions are still NOT counted — dispatchCommands is a lower bound,
// consistent with the toolCount note below.
function countDispatch(cmds) {
  let n = 0;
  for (const cmd of cmds) {
    for (const raw of splitTopLevel(stripHeredocs(String(cmd)))) {
      const part = raw
        .trim()
        .replace(/^[({\s]+/, "")
        .replace(/^(?:do|then|else)\s+/, "")
        .replace(ENV_ASSIGN_RE, "");
      if (AGENT_LAUNCHER_RE.test(part)) n++;
    }
  }
  return n;
}

export function buildDigest(parsed) {
  const byRepo = new Map();

  for (const s of parsed.sessions) {
    const cwd = s.cwdRaw || s.cwdRedacted || "";
    if (isEphemeral(cwd)) continue;
    const key = repoKey(s.cwdRedacted || cwd);
    if (!byRepo.has(key)) {
      byRepo.set(key, {
        repo: key, cwdRaw: s.cwdRaw || "", cwds: [], sessions: 0, userMessages: 0, prompts: [],
        toolHist: {}, areas: {}, exts: {}, cmds: [], webQueries: [], sources: {}, sourceSpans: {},
        delegation: 0, planning: 0, firstTs: null, lastTs: null,
      });
    }
    const p = byRepo.get(key);
    if (s.cwdRaw && !p.cwds.includes(s.cwdRaw)) p.cwds.push(s.cwdRaw);
    p.sessions++;
    // Which tool produced this session. mergeSources guarantees the tag for
    // everything the shipped adapters emit; "unknown" is the honest bucket for
    // hand-built bundles and never counts as a distinct CLI (see toolCount).
    const src = s.source || "unknown";
    p.sources[src] = (p.sources[src] || 0) + 1;
    for (const m of s.messages) {
      const t = ms(m.ts);
      if (Number.isFinite(t)) {
        if (!p.firstTs || t < p.firstTs) p.firstTs = t;
        if (!p.lastTs || t > p.lastTs) p.lastTs = t;
        // Per-source activity span, to tell concurrent fan-out apart from a
        // sequential migration between tools (see toolOverlap below).
        const span = p.sourceSpans[src] || (p.sourceSpans[src] = { first: t, last: t });
        if (t < span.first) span.first = t;
        if (t > span.last) span.last = t;
      }
      if (m.role === "user" && m.textRedacted.trim()) {
        p.userMessages++;
        p.prompts.push(m.textRedacted.trim().replace(/\s+/g, " "));
      }
      for (const u of m.toolUses) {
        p.toolHist[u.name] = (p.toolHist[u.name] || 0) + 1;
        if (DELEGATION.has(u.name)) p.delegation++;
        if (PLANNING.has(u.name)) p.planning++;
        const area = u.path ? toArea(u.path, key) : null;
        if (area) p.areas[area] = (p.areas[area] || 0) + 1;
        if (u.path) { const e = fileExt(u.path); if (e) p.exts[e] = (p.exts[e] || 0) + 1; }
        if (u.cmd) p.cmds.push(u.cmd);
        if (u.q) p.webQueries.push(u.q);
      }
    }
  }

  const projects = [...byRepo.values()]
    .sort((a, b) => b.sessions - a.sessions)
    .map((p) => {
      const mutations = Object.entries(p.toolHist).filter(([k]) => MUTATION.has(k)).reduce((n, [, v]) => n + v, 0);
      const research = Object.entries(p.toolHist).filter(([k]) => RESEARCH.has(k)).reduce((n, [, v]) => n + v, 0);
      const topAreas = Object.entries(p.areas).sort((a, b) => b[1] - a[1]).slice(0, 12);
      const cmdsText = p.cmds.join(" \n ");
      const commits = (cmdsText.match(/git commit/g) || []).length;
      const reverts = (cmdsText.match(/git revert|git reset --hard|git checkout -- /g) || []).length;
      const designQueries = p.webQueries.filter((q) => DESIGN_RE.test(q)).length;
      // First cluster cwd that still exists — a deleted first worktree must not
      // disable dependency detection for the whole cluster.
      const cwdRaw = resolveCwd(p.cwds, p.cwdRaw);
      const dispatchCommands = countDispatch(p.cmds);
      const knownTools = Object.keys(p.sources).filter((k) => k !== "unknown");
      const knownSpans = Object.entries(p.sourceSpans)
        .filter(([k]) => k !== "unknown")
        .map(([, v]) => v);
      let toolOverlap = null;
      if (knownTools.length >= 2 && knownSpans.length >= 2) {
        toolOverlap = knownSpans.some((a, i) =>
          knownSpans.slice(i + 1).some((b) => a.first <= b.last && b.first <= a.last));
      }
      const ctx = {
        mutations, designQueries,
        researchToMutation: mutations ? +(research / mutations).toFixed(2) : null,
        firstTs: p.firstTs, lastTs: p.lastTs,
        areasText: topAreas.map(([a]) => a).join(" "),
        delegation: p.delegation,
      };
      return {
        repo: p.repo,
        cwdRaw, // local-only; first existing cwd in the cluster
        type: classify(ctx),
        // Null when no message carried a timestamp — never the epoch. A
        // fabricated "1970-01" is a claimed date the logs can't back.
        from: p.firstTs ? month(new Date(p.firstTs).toISOString()) : null,
        to: p.lastTs ? month(new Date(p.lastTs).toISOString()) : null,
        sessions: p.sessions,
        userMessages: p.userMessages,
        // Code-volume signal for representative selection (edits/writes landed).
        mutations,
        topAreas: Object.fromEntries(topAreas),
        tech: detectStack({ cwdRaw, exts: p.exts, cmdsText }),
        landing: {
          checksRun: /eslint|tsc|typecheck|playwright|npm (run )?build|pnpm build|npm test|pnpm test/i.test(cmdsText),
          commits, reverts,
          revertChurn: commits ? (reverts / Math.max(commits, 1) > 0.3 ? "high" : reverts > 0 ? "med" : "low") : "n/d",
        },
        delegation: p.delegation,
        // Orchestration, three components together: delegating WITHIN a session
        // (sub-agent Task calls), fanning out ACROSS CLIs (distinct tools in one
        // product), and dispatching agent processes (launcher commands). Carried
        // as one object so the narrative input sees all three, not just fan-out.
        // Framework-agnostic. The counts DESCRIBE; nothing ranks (ADR-001).
        //
        // toolCount counts distinct KNOWN tools ("unknown" is honest bucketing
        // for an untagged session, not a distinct CLI — the rest of the
        // pipeline would call the same session claude-code, and a tag can't
        // manufacture fan-out). toolOverlap tells concurrent fan-out apart
        // from sequential migration: true when at least two known tools'
        // activity spans intersect, false when their eras are disjoint (the
        // candidate switched tools, nothing orchestrated anything), null when
        // fewer than two spans exist to compare.
        //
        // NOTE: every count is a LOWER BOUND. Under single-source capture
        // every session is tagged with the one tool that was ingested, so
        // toolCount is pinned at 1 until a second source lands — absence of
        // fan-out here is never evidence that no fan-out happened, only that
        // one tool was read.
        orchestration: {
          delegation: p.delegation,
          tools: p.sources,
          toolCount: Math.max(knownTools.length, 1),
          toolOverlap,
          dispatchCommands,
        },
        researchToMutation: ctx.researchToMutation,
        learningTopics: [...new Set(p.webQueries)].slice(0, 12),
        promptSamples: samplePrompts(p.prompts),
      };
    });

  return { source: parsed.source, projectCount: projects.length, projects };
}

function samplePrompts(prompts, max = 8, cap = 300) {
  const sub = prompts.filter((p) => p.split(/\s+/).length >= 3 && !p.startsWith("<task-notification>") && !p.startsWith("Your task is to create a detailed summary"));
  if (sub.length <= max) return sub.map((p) => p.slice(0, cap));
  const step = sub.length / max;
  return Array.from({ length: max }, (_, i) => sub[Math.floor(i * step)].slice(0, cap));
}

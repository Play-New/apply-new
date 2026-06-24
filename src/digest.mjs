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
// tokens.
//
// Interactive / housekeeping invocations are intentionally NOT dispatches —
// only the HEADLESS mode of each launcher is: `claude -p`/`--print` (not bare
// `claude`, the REPL), and `codex exec` (not bare `codex`, the TUI, nor
// `codex login`/`mcp`/`resume`). Requiring the headless subcommand keeps the
// two consistent; without it `codex login` would read as farmed-out work.
const AGENT_LAUNCHER_RE = /^(?:claude\s+(?:-p|--print)|(?:opencode|crush|goose)\s+run|codex\s+exec|aider|cursor-agent)(?=\s|$)/i;

// Count agent-launcher invocations in a product's shell history. Splits each
// command on TOP-LEVEL shell separators (&&, ||, ;, |, newline) and strips
// leading env assignments so the matcher sees the executable position of each
// top-level sub-command. Launchers behind a wrapper (npx/sudo/time) or nested in
// $()/subshells/control-flow bodies are NOT counted — dispatchCommands is a
// lower bound, consistent with the toolCount note below.
function countDispatch(cmds) {
  let n = 0;
  for (const cmd of cmds) {
    for (const raw of String(cmd).split(/&&|\|\||[;|\n]/)) {
      const part = raw.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "");
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
        toolHist: {}, areas: {}, exts: {}, cmds: [], webQueries: [], sources: {},
        delegation: 0, planning: 0, firstTs: null, lastTs: null,
      });
    }
    const p = byRepo.get(key);
    if (s.cwdRaw && !p.cwds.includes(s.cwdRaw)) p.cwds.push(s.cwdRaw);
    p.sessions++;
    // Which tool produced this session — a product touched by more than one
    // agent CLI is a fan-out signal: one tool is orchestrating the others.
    p.sources[s.source || "unknown"] = (p.sources[s.source || "unknown"] || 0) + 1;
    for (const m of s.messages) {
      const t = ms(m.ts);
      if (Number.isFinite(t)) {
        if (!p.firstTs || t < p.firstTs) p.firstTs = t;
        if (!p.lastTs || t > p.lastTs) p.lastTs = t;
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
        // Multi-tool or dispatchCommands > 0 ⇒ work was farmed out to other
        // agents, not all hands-on. Framework-agnostic.
        //
        // NOTE: toolCount is a LOWER BOUND. Under single-source capture every
        // session is tagged with the one tool that was ingested, so toolCount is
        // pinned at 1 until a second source lands — absence of fan-out here is
        // never evidence that no fan-out happened, only that one tool was read.
        orchestration: {
          delegation: p.delegation,
          tools: p.sources,
          toolCount: Object.keys(p.sources).length,
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

// Per-project digest: the deep, LLM-ready material the profile is written from.
//
// Beyond sampled prompts, this reconstructs project CONTEXT from the tool inputs
// (the files touched draw the domain), detects the stack, reads "landing"
// signals (did checks run, did work get committed vs reverted), and the
// learning trajectory (what was searched for). Everything stays redacted and
// keyed by repo, so worktrees of one product collapse into one project.

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

const TECH = [
  [/supabase/i, "Supabase/Postgres"],
  [/inngest/i, "Inngest (job event-driven)"],
  [/playwright|\/e2e\//i, "Playwright (E2E)"],
  [/tailwind/i, "Tailwind"],
  [/shadcn/i, "shadcn/ui"],
  [/\bzod\b/i, "Zod"],
  [/prisma/i, "Prisma"],
  [/next\.config|\/app\/.*\.tsx?$/i, "Next.js/React"],
  [/vite\.config|\bvite\b/i, "Vite/React"],
  [/drizzle/i, "Drizzle"],
  [/stripe/i, "Stripe"],
  [/fastapi|uvicorn|\bstarlette\b/i, "FastAPI"],
  [/\.py$|pyproject\.toml|requirements\.txt/i, "Python"],
];
const detectTech = (blobs) => {
  const f = new Set();
  for (const s of blobs) for (const [re, l] of TECH) if (re.test(s)) f.add(l);
  return [...f];
};

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

export function buildDigest(parsed) {
  const byRepo = new Map();

  for (const s of parsed.sessions) {
    const cwd = s.cwdRaw || s.cwdRedacted || "";
    if (isEphemeral(cwd)) continue;
    const key = repoKey(s.cwdRedacted || cwd);
    if (!byRepo.has(key)) {
      byRepo.set(key, {
        repo: key, cwdRaw: s.cwdRaw || "", sessions: 0, userMessages: 0, prompts: [],
        toolHist: {}, areas: {}, cmds: [], webQueries: [],
        delegation: 0, planning: 0, firstTs: null, lastTs: null,
      });
    }
    const p = byRepo.get(key);
    p.sessions++;
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
      const ctx = {
        mutations, designQueries,
        researchToMutation: mutations ? +(research / mutations).toFixed(2) : null,
        firstTs: p.firstTs, lastTs: p.lastTs,
        areasText: topAreas.map(([a]) => a).join(" "),
        delegation: p.delegation,
      };
      return {
        repo: p.repo,
        cwdRaw: p.cwdRaw, // local-only
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
        tech: detectTech([...topAreas.map(([a]) => a), cmdsText]),
        landing: {
          checksRun: /eslint|tsc|typecheck|playwright|npm (run )?build|pnpm build|npm test|pnpm test/i.test(cmdsText),
          commits, reverts,
          revertChurn: commits ? (reverts / Math.max(commits, 1) > 0.3 ? "high" : reverts > 0 ? "med" : "low") : "n/d",
        },
        delegation: p.delegation,
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

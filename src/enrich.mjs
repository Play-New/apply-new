// Local repo enrichment: the highest-signal context per token, read straight
// from the candidate's machine. package.json gives the exact stack; CLAUDE.md /
// README describe the project in words; git log says what actually shipped.
//
// This is LOCAL CONTEXT for the narrative step only. It contains real names and
// MUST NOT be copied into the sent bundle — the LLM consumes it and emits an
// anonymized, context-only description.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

function repoRoot(cwd) {
  const m = cwd.match(/^(.*\/(?:Github|github|repos?|Projects|src|code|dev|work)\/[^/]+)/);
  return m ? m[1] : cwd;
}

// Find the dir that actually holds package.json (root, or a common monorepo app dir).
function pkgDir(root) {
  if (existsSync(join(root, "package.json"))) return root;
  let subs = [];
  try {
    subs = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return root;
  }
  const prefer = subs.filter((s) => /-(app|web)$|^(app|web|apps|packages|src|client|frontend)$/.test(s));
  for (const s of [...prefer, ...subs]) if (existsSync(join(root, s, "package.json"))) return join(root, s);
  return root;
}

const readMaybe = (p, cap = 1800) => {
  try {
    return existsSync(p) ? readFileSync(p, "utf8").slice(0, cap) : null;
  } catch {
    return null;
  }
};

export function enrichRepo(cwdRaw) {
  const out = { found: false };
  if (!cwdRaw) return out;
  const root = repoRoot(cwdRaw);
  if (!existsSync(root)) return out;
  out.found = true;
  const dir = pkgDir(root);

  // package.json: name, description, dependency names (the stack).
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    out.pkgName = pkg.name || null;
    out.pkgDescription = pkg.description || null;
    out.deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).slice(0, 60);
  } catch {}

  // Project self-description.
  out.doc =
    readMaybe(join(dir, "CLAUDE.md")) ||
    readMaybe(join(root, "CLAUDE.md")) ||
    readMaybe(join(dir, "README.md")) ||
    readMaybe(join(root, "README.md")) ||
    null;

  // What actually shipped (commit subjects), and recency.
  try {
    out.commits = execSync(`git -C "${root}" log --pretty=%s -n 20`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n").map((s) => s.trim()).filter(Boolean);
    out.totalCommits = +execSync(`git -C "${root}" rev-list --count HEAD`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {}

  // "Codified principles": lines ADDED over time to the project's doctrine
  // files (CLAUDE.md, README.md). These are rules the candidate wrote for
  // their future self and their agent — strategic, not technical.
  out.principlesDiff = collectAddedDoctrineLines(root);

  return out;
}

// One honest line about what the enrichment could NOT see. The empty catches
// above encode expected absence (a Python repo has no package.json, a non-git
// dir has no log), so this is computed from the OUTPUT shape instead: an entry
// that found a root but produced no stack, no doc, and no commits contributed
// nothing to the narrative. Local-only data — one aggregate note, no per-error
// noise.
export function describeContextGaps(enrichments) {
  const list = enrichments ?? [];
  const gaps = list.filter((e) => !e?.found || (!e.pkgName && !e.doc && !e.commits?.length)).length;
  if (!gaps) return null;
  return `repo context unavailable for ${gaps} of ${list.length} selected project${list.length === 1 ? "" : "s"} (the narrative leans on prompts and logs for those)`;
}

function collectAddedDoctrineLines(root) {
  const candidates = [];
  for (const file of ["CLAUDE.md", "README.md"]) {
    try {
      const patch = execSync(
        `git -C "${root}" log --reverse --pretty=format:"||COMMIT %ad" --date=short -p -50 -- "${file}"`,
        { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
      );
      if (!patch) continue;
      let date = null;
      for (const line of patch.split("\n")) {
        if (line.startsWith("||COMMIT ")) { date = line.slice(9).trim(); continue; }
        if (!date) continue;
        if (!line.startsWith("+") || line.startsWith("+++")) continue;
        const text = line.slice(1).trim();
        if (text.length < 20 || text.length > 300) continue;
        if (/^[#`*\-_=>\[\]<]/.test(text)) continue; // headings, code, lists, html
        if (/^[A-Z][\w\s]*:$/.test(text)) continue;  // "Section:" headers
        candidates.push({ date, file, text });
      }
    } catch {}
  }
  // Dedupe by text, keep earliest date; sort ascending; cap.
  const byText = new Map();
  for (const c of candidates) if (!byText.has(c.text) || c.date < byText.get(c.text).date) byText.set(c.text, c);
  return [...byText.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-30);
}

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

  return out;
}

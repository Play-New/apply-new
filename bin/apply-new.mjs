#!/usr/bin/env node
// apply-new — turn your Claude Code logs into a tamper-evident, PII-redacted
// work profile (playnew-profile/v1).
//
// Sub-commands (default: generate — save locally, no submit):
//
//   apply-new                      # = apply-new generate
//   apply-new generate             # build profile.md + candidate.json locally
//   apply-new prepare              # only emit narrative-input.json (no narrative)
//   apply-new finalize             # finalize using --narrative-file narrative.json
//   apply-new submit               # POST candidate.json to Play New intake
//
// Common flags:
//   --root <dir>                   # logs root (default ~/.claude/projects)
//   --name "Giulia" --email g@x.io --city Milano --status freelance
//   --top 4                        # how many representative projects
//   --narrative-file narrative.json
//   --endpoint https://...         # override PLAYNEW_INTAKE_URL for submit
//
// Three ways to provide the narrative step (the qualitative prose):
//   A. Inside Claude Code via .claude/commands/apply-new.md — uses the
//      candidate's own subscription, no API key needed.
//   B. With the Claude API:  set ANTHROPIC_API_KEY and run `generate`.
//   C. Manually:  `prepare` -> hand-write narrative.json -> `finalize`.

import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { readClaudeCode } from "../src/adapters/claude-code.mjs";
import { computeFingerprint } from "../src/fingerprint.mjs";
import { computeForensics } from "../src/forensics.mjs";
import { buildDigest } from "../src/digest.mjs";
import { enrichRepo } from "../src/enrich.mjs";
import { generateNarrative } from "../src/profile-llm.mjs";
import { selectRepresentatives, assembleProfile, renderMarkdown } from "../src/profile.mjs";
import { buildContact } from "../src/contact.mjs";
import { submitProfile } from "../src/submit.mjs";
import { buildTrajectory } from "../src/trajectory.mjs";

const SUB_COMMANDS = new Set(["generate", "prepare", "finalize", "submit"]);

const argv = process.argv.slice(2);
const sub = argv[0] && !argv[0].startsWith("--") ? argv[0] : "generate";
if (!SUB_COMMANDS.has(sub)) {
  console.error(`Unknown command: ${sub}. Expected: ${[...SUB_COMMANDS].join(" | ")}`);
  process.exit(1);
}
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const has = (n) => argv.includes(`--${n}`);
const tryGit = (k) => { try { return execSync(`git config ${k}`, { encoding: "utf8" }).trim() || null; } catch { return null; } };

async function loadProfileInputs(out) {
  let root = flag("root", join(homedir(), ".claude", "projects"));
  if (flag("project")) root = join(root, flag("project"));
  if (!existsSync(root)) { console.error(`No logs at ${root}.`); process.exit(1); }

  console.log(`[1/5] Reading ${root} ...`);
  const parsed = readClaudeCode(root);
  console.log(`      ${parsed.sessions.length} sessions, ${parsed.files.length} files`);

  console.log(`[2/5] Fingerprint, manifest, consistency ...`);
  const fingerprint = computeFingerprint(parsed);
  const forensics = computeForensics(parsed);

  console.log(`[3/5] Deep digest + per-repo clustering (PII redacted: ${parsed.redaction.hits}) ...`);
  const digest = buildDigest(parsed);
  const projects = selectRepresentatives(digest.projects, +flag("top", "4"));
  const selected = projects.filter((p) => p.selected);
  console.log(`      ${digest.projectCount} products, ${selected.length} representative: ${selected.map((p) => `${p.repo}[${p.type[0]}]`).join(", ")}`);

  const enrichments = selected.map((p) => enrichRepo(p.cwdRaw));
  const trajectory = buildTrajectory(parsed);
  return { parsed, fingerprint, forensics, projects, selected, enrichments, trajectory, out };
}

function resolveContact() {
  const { contact, errors } = buildContact({
    name: flag("name", tryGit("user.name")),
    email: flag("email", tryGit("user.email")),
    city: flag("city"),
    status: flag("status"),
  });
  return { contact, errors };
}

function writeProfile(out, profile) {
  writeFileSync(join(out, "candidate.json"), JSON.stringify(profile, null, 2));
  const md = renderMarkdown(profile);
  writeFileSync(join(out, "profile.md"), md);
  console.log(md);
  console.log(`Saved: candidate.json + profile.md`);
  console.log(`To submit to Play New when ready:  apply-new submit`);
}

async function cmdGenerate() {
  const out = process.cwd();
  console.log(`\napply-new generate\n`);
  const { parsed, fingerprint, forensics, projects, selected, enrichments, trajectory } = await loadProfileInputs(out);
  const { contact, errors } = resolveContact();
  if (errors.length) {
    console.error("\nMissing contact fields:");
    for (const e of errors) console.error("  - " + e);
    process.exit(2);
  }

  console.log(`[4/5] Narrative ...`);
  const narrativeFile = flag("narrative-file");
  const { narrative, input } = await generateNarrative(selected, enrichments, {
    overrideFile: narrativeFile,
    trajectory,
    compactionSummaries: parsed.compactionSummaries,
  });
  if (!narrative) {
    writeFileSync(join(out, "narrative-input.json"), JSON.stringify(input, null, 2));
    console.log(`      no narrative yet (no API key, no --narrative-file).`);
    console.log(`      Inside Claude Code:  /apply-new   (writes narrative.json and finalizes)`);
    console.log(`      Manual:  write narrative.json, then  apply-new finalize`);
    return;
  }

  console.log(`[5/5] Assembling and saving ...\n`);
  writeProfile(out, assembleProfile({
    contact, projects, narrative, fingerprint, forensics, trajectory,
    manifestHash: fingerprint.manifest.bundleHash,
  }));
}

async function cmdPrepare() {
  const out = process.cwd();
  console.log(`\napply-new prepare\n`);
  const { parsed, selected, enrichments, trajectory } = await loadProfileInputs(out);
  const { input } = await generateNarrative(selected, enrichments, {
    overrideFile: null,
    trajectory,
    compactionSummaries: parsed.compactionSummaries,
  });
  writeFileSync(join(out, "narrative-input.json"), JSON.stringify(input, null, 2));
  console.log(`Wrote narrative-input.json.`);
  console.log(`Next: write narrative.json (rules in the slash command), then  apply-new finalize`);
}

async function cmdFinalize() {
  const out = process.cwd();
  console.log(`\napply-new finalize\n`);
  const narrativeFile = flag("narrative-file", join(out, "narrative.json"));
  if (!existsSync(narrativeFile)) {
    console.error(`Missing ${narrativeFile}. Run apply-new prepare first, then write narrative.json.`);
    process.exit(2);
  }
  const { parsed, fingerprint, forensics, projects, selected, enrichments, trajectory } = await loadProfileInputs(out);
  const { contact, errors } = resolveContact();
  if (errors.length) {
    console.error("\nMissing contact fields:");
    for (const e of errors) console.error("  - " + e);
    process.exit(2);
  }
  const { narrative } = await generateNarrative(selected, enrichments, {
    overrideFile: narrativeFile,
    trajectory,
    compactionSummaries: parsed.compactionSummaries,
  });
  writeProfile(out, assembleProfile({
    contact, projects, narrative, fingerprint, forensics, trajectory,
    manifestHash: fingerprint.manifest.bundleHash,
  }));
}

async function cmdSubmit() {
  const out = process.cwd();
  const profilePath = join(out, "candidate.json");
  if (!existsSync(profilePath)) {
    console.error("No candidate.json yet. Generate the profile first:  apply-new generate");
    process.exit(2);
  }
  const profile = JSON.parse(readFileSync(profilePath, "utf8"));
  const c = profile.contact || {};

  console.log(`\napply-new submit\n`);
  console.log(`About to submit to Play New:`);
  console.log(`  name:   ${c.name}`);
  console.log(`  email:  ${c.email}`);
  console.log(`  city:   ${c.city}    status: ${c.status}`);
  console.log(`  profile: ${profile.volume?.sessions} sessions, ${profile.volume?.products} products`);
  console.log(`  artifacts: ${(profile.projects || []).filter((p) => p.artifact).length}`);
  console.log(`\nNOT submitted: raw logs, local repo context, third-party proper names.`);

  if (!has("yes")) {
    console.log(`\nTo confirm:  apply-new submit --yes`);
    return;
  }

  const endpoint = flag("endpoint");
  try {
    const res = await submitProfile(profilePath, { endpoint });
    console.log(`\nSubmitted. id: ${res.id || "(n/a)"}, status: ${res.status || "ok"}`);
  } catch (e) {
    console.error(`\nSubmit failed: ${e.message}`);
    process.exit(1);
  }
}

const main = { generate: cmdGenerate, prepare: cmdPrepare, finalize: cmdFinalize, submit: cmdSubmit }[sub];
main().catch((e) => { console.error("Error:", e.message); process.exit(1); });

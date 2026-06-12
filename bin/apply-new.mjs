#!/usr/bin/env node
// apply-new — turn your Claude Code logs into a tamper-evident, PII-redacted
// work profile (playnew-profile/v1).
//
// Sub-commands (default: generate — save locally, no submit):
//
//   apply-new                      # = apply-new generate
//   apply-new generate             # build out/profile.md + out/candidate.json locally
//   apply-new prepare              # only emit out/narrative-input.json (no narrative)
//   apply-new finalize             # finalize using --narrative-file out/narrative.json
//   apply-new submit               # POST out/candidate.json to Play New intake
//
// Everything generated lands in ./out — one folder to inspect, one to delete,
// one line of .gitignore. Nothing is written to the repo root.
//
// Common flags:
//   --root <dir>                   # logs root (default ~/.claude/projects)
//   --name "Giulia" --email g@x.io --city Milano --status freelance
//   --top 4                        # force the number of representative projects
//                                  # (default: adaptive, 3 to 5)
//   --tz Europe/Rome               # timezone for day-based counts (activeDays,
//                                  # streak). Default UTC; recorded in the profile.
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
import { writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { readClaudeCode } from "../src/adapters/claude-code.mjs";
import { computeFingerprint } from "../src/fingerprint.mjs";
import { computeForensics } from "../src/forensics.mjs";
import { buildDigest } from "../src/digest.mjs";
import { enrichRepo, describeContextGaps } from "../src/enrich.mjs";
import { generateNarrative } from "../src/profile-llm.mjs";
import { selectRepresentatives, assembleProfile, renderMarkdown, summarizeSources } from "../src/profile.mjs";
import { buildContact } from "../src/contact.mjs";
import { submitProfile } from "../src/submit.mjs";
import { buildTrajectory } from "../src/trajectory.mjs";
import { assessGroundedness } from "../src/groundedness.mjs";
import { assessStructure, assessAgainstLogs } from "../src/consistency.mjs";
import { computeAiRelationship } from "../src/ai-relationship.mjs";
import { computeAgenticLiteracy } from "../src/agentic-literacy.mjs";
import { computeIntensity } from "../src/intensity.mjs";
import { computeDistribution } from "../src/distribution.mjs";
import { DEFAULT_TZ } from "../src/days.mjs";

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

// Validate --tz up front, before reading any logs — an unknown zone should fail
// fast, not throw mid-pipeline from inside Intl.DateTimeFormat.
const tzFlag = flag("tz", DEFAULT_TZ);
try {
  new Intl.DateTimeFormat("en-CA", { timeZone: tzFlag }).format(0);
} catch {
  console.error(`Invalid --tz "${tzFlag}". Expected an IANA timezone, e.g. UTC or Europe/Rome.`);
  process.exit(2);
}

// Every generated file (narrative-input.json, narrative.json, candidate.json,
// profile.md) lands in ./out — never in the repo root.
const OUT_DIR = "out";
const outDir = () => {
  const out = join(process.cwd(), OUT_DIR);
  mkdirSync(out, { recursive: true });
  return out;
};

async function loadProfileInputs(out) {
  let root = flag("root", join(homedir(), ".claude", "projects"));
  if (flag("project")) root = join(root, flag("project"));
  if (!existsSync(root)) { console.error(`No logs at ${root}.`); process.exit(1); }

  console.log(`[1/5] Reading ${root} ...`);
  const parsed = readClaudeCode(root);
  console.log(`      ${parsed.sessions.length} sessions, ${parsed.files.length} files`);

  // Timezone the day-based counts (activeDays, streak) are bucketed in. Default
  // UTC (machine-independent); recorded in the profile so the count reproduces.
  // Validated at startup (tzFlag) before any logs are read.
  const tz = tzFlag;

  console.log(`[2/5] Fingerprint, manifest, consistency ...`);
  const fingerprint = computeFingerprint(parsed, { tz });
  const forensics = computeForensics(parsed);

  console.log(`[3/5] Deep digest + per-repo clustering (PII redacted: ${parsed.redaction.hits}) ...`);
  const digest = buildDigest(parsed);
  const projects = selectRepresentatives(digest.projects, flag("top") ? +flag("top") : "auto");
  const selected = projects.filter((p) => p.selected);
  console.log(`      ${digest.projectCount} products, ${selected.length}${flag("top") ? "" : " (adaptive 3-5)"} representative: ${selected.map((p) => `${p.repo}[${p.type[0]}]`).join(", ")}`);

  const enrichments = selected.map((p) => enrichRepo(p.cwdRaw));
  const contextGap = describeContextGaps(enrichments);
  if (contextGap) console.error(`      note: ${contextGap}`);
  const trajectory = buildTrajectory(parsed);
  const aiRelationship = computeAiRelationship(parsed);
  const agenticLiteracy = computeAgenticLiteracy(parsed);
  const intensity = computeIntensity(parsed, { tz });
  const distribution = computeDistribution(projects);
  const sources = summarizeSources(parsed);
  return { parsed, fingerprint, forensics, projects, selected, enrichments, trajectory, aiRelationship, agenticLiteracy, intensity, distribution, sources, out };
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
  console.log(`Saved: ${OUT_DIR}/candidate.json + ${OUT_DIR}/profile.md`);
  console.log(`To submit to Play New when ready:  apply-new submit`);
}

async function cmdGenerate() {
  const out = outDir();
  console.log(`\napply-new generate\n`);
  const { parsed, fingerprint, forensics, projects, selected, enrichments, trajectory, aiRelationship, agenticLiteracy, intensity, distribution, sources } = await loadProfileInputs(out);
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
    aiRelationship,
    agenticLiteracy,
    intensity,
    distribution,
    allProjects: projects,
    compactionSummaries: parsed.compactionSummaries,
  });
  if (!narrative) {
    writeFileSync(join(out, "narrative-input.json"), JSON.stringify(input, null, 2));
    console.log(`      no narrative yet (no API key, no --narrative-file).`);
    console.log(`      Inside Claude Code:  /apply-new   (writes ${OUT_DIR}/narrative.json and finalizes)`);
    console.log(`      Manual:  write ${OUT_DIR}/narrative.json, then  apply-new finalize`);
    return;
  }

  console.log(`[5/5] Assembling and saving ...\n`);
  writeProfile(out, assembleWithGroundedness({
    contact, projects, narrative, fingerprint, forensics, trajectory, aiRelationship, agenticLiteracy, intensity, distribution, sources,
    manifestHash: fingerprint.manifest.bundleHash,
  }));
}

// Assemble + compute groundedness on the assembled draft + re-assemble with
// the score embedded. Centralised so generate and finalize share it.
function assembleWithGroundedness(args) {
  // The raw vocabularyCandidates never enter the profile (they can carry
  // client names) — so a narrative that omitted its filtered pick leaves
  // newVocabulary empty. Say so instead of failing silently.
  if (args.narrative && args.trajectory?.vocabularyCandidates?.length && !args.narrative.trajectory?.vocabulary_adopted?.length) {
    console.error(`      note: the narrative has no trajectory.vocabulary_adopted — newVocabulary stays empty (raw candidates are never used; re-run the narrative step to fill it)`);
  }
  const draft = assembleProfile(args);
  const groundedness = assessGroundedness(draft);
  return assembleProfile({ ...args, groundedness });
}

async function cmdPrepare() {
  const out = outDir();
  console.log(`\napply-new prepare\n`);
  const { parsed, projects, selected, enrichments, trajectory, aiRelationship, agenticLiteracy, intensity, distribution } = await loadProfileInputs(out);
  const { input } = await generateNarrative(selected, enrichments, {
    overrideFile: null,
    trajectory,
    aiRelationship,
    agenticLiteracy,
    intensity,
    distribution,
    allProjects: projects,
    compactionSummaries: parsed.compactionSummaries,
  });
  writeFileSync(join(out, "narrative-input.json"), JSON.stringify(input, null, 2));
  console.log(`Wrote ${OUT_DIR}/narrative-input.json.`);
  console.log(`Next: write ${OUT_DIR}/narrative.json (rules in the slash command), then  apply-new finalize`);
}

async function cmdFinalize() {
  const out = outDir();
  console.log(`\napply-new finalize\n`);
  const narrativeFile = flag("narrative-file", join(out, "narrative.json"));
  if (!existsSync(narrativeFile)) {
    console.error(`Missing ${narrativeFile}. Run apply-new prepare first, then write ${OUT_DIR}/narrative.json.`);
    process.exit(2);
  }
  const { parsed, fingerprint, forensics, projects, selected, enrichments, trajectory, aiRelationship, agenticLiteracy, intensity, distribution, sources } = await loadProfileInputs(out);
  const { contact, errors } = resolveContact();
  if (errors.length) {
    console.error("\nMissing contact fields:");
    for (const e of errors) console.error("  - " + e);
    process.exit(2);
  }
  const { narrative } = await generateNarrative(selected, enrichments, {
    overrideFile: narrativeFile,
    trajectory,
    aiRelationship,
    agenticLiteracy,
    intensity,
    distribution,
    allProjects: projects,
    compactionSummaries: parsed.compactionSummaries,
  });
  writeProfile(out, assembleWithGroundedness({
    contact, projects, narrative, fingerprint, forensics, trajectory, aiRelationship, agenticLiteracy, intensity, distribution, sources,
    manifestHash: fingerprint.manifest.bundleHash,
  }));
}

async function cmdSubmit() {
  // Profiles live in ./out; fall back to the repo root for profiles
  // generated by a version that still wrote there.
  let profilePath = join(process.cwd(), OUT_DIR, "candidate.json");
  if (!existsSync(profilePath) && existsSync(join(process.cwd(), "candidate.json"))) {
    profilePath = join(process.cwd(), "candidate.json");
    console.log(`(using ./candidate.json from an older run — new runs write to ${OUT_DIR}/)`);
  }
  if (!existsSync(profilePath)) {
    console.error(`No ${OUT_DIR}/candidate.json yet. Generate the profile first:  apply-new generate`);
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

  // Pre-flight groundedness: how much of the prose is anchored in the data.
  // Recomputed on the file as it is NOW, not trusted from the embedded score.
  const g = assessGroundedness(profile);
  console.log(`\nGroundedness check`);
  if (g.score == null) {
    console.log(`  not enough verifiable anchors in the prose (n/a)`);
  } else {
    console.log(`  ${g.score}% of prose anchors are supported by the structured data (${g.supported}/${g.total})`);
  }
  if (g.anomalies.length) {
    console.log(`  Unverifiable in your logs:`);
    for (const a of g.anomalies) console.log(`    - ${a.where}: "${a.anchor}" (${a.kind})`);
    console.log(`  Consider regenerating, or editing candidate.json before submitting.`);
  }
  const embedded = profile.groundedness?.score;
  if (g.score != null && embedded != null && Math.abs(g.score - embedded) > 5) {
    console.log(`  Note: the file says groundedness ${embedded}% but it recomputes to ${g.score}% — candidate.json was edited after generation.`);
  }

  // Pre-flight consistency: structural invariants, then re-derivation from
  // the logs (the ground truth the profile claims to describe).
  console.log(`\nConsistency check`);
  const issues = [...assessStructure(profile).issues];
  let excessClaims = 0;
  let root = flag("root", join(homedir(), ".claude", "projects"));
  if (flag("project")) root = join(root, flag("project"));
  if (existsSync(root)) {
    const parsed = readClaudeCode(root);
    const digest = buildDigest(parsed);
    // Re-derive day-based intensity in the zone the profile RECORDED — never
    // the machine zone — so the comparison measures the data, not the bucketing.
    const intensity = computeIntensity(parsed, { tz: profile.intensity?.timezone || DEFAULT_TZ });
    const logs = assessAgainstLogs(profile, digest.projects, { intensity });
    issues.push(...logs.issues);
    excessClaims = logs.excessClaims || 0;
    for (const w of logs.warnings) console.log(`  ~ ${w}`);
  } else {
    console.log(`  ~ no logs at ${root}, skipping log re-derivation (pass --root if they live elsewhere)`);
  }
  if (issues.length) {
    console.log(`  The structured data does not match ${existsSync(root) ? "your logs / its own invariants" : "its own invariants"}:`);
    for (const i of issues) console.log(`    - ${i}`);
    if (excessClaims > 0) {
      // Claims exceed what the logs can prove now. Since normal use only ever
      // GROWS the logs, the usual cause is Claude Code's cleanup pruning the
      // oldest sessions between generation and submit — not anything the
      // candidate did wrong.
      console.log(`  Your profile claims more than your logs can prove right now. The usual cause:`);
      console.log(`  Claude Code prunes sessions older than its cleanup period (~30 days by default),`);
      console.log(`  and the oldest part of your window aged out after the profile was generated.`);
      console.log(`  Nothing is wrong with what you did — the numbers are just stale.`);
      console.log(`  Fix: regenerate now and submit right away (apply-new generate, or re-run /apply-new).`);
    } else {
      console.log(`  If your logs were pruned since generation, regenerate (apply-new generate).`);
    }
  } else {
    console.log(`  structured data is internally consistent and matches your logs`);
  }

  if (!has("yes")) {
    console.log(`\nTo confirm:  apply-new submit --yes`);
    return;
  }
  if (issues.length && !has("force")) {
    console.error(`\nConsistency check failed (${issues.length} issue${issues.length > 1 ? "s" : ""}). Submission blocked.`);
    console.error(`Regenerate the profile (apply-new generate) or pass --force to bypass.`);
    console.error(`Note: the intake re-checks groundedness and these invariants server-side.`);
    process.exit(2);
  }
  if (g.score != null && g.score < 60 && !has("force")) {
    console.error(`\nGroundedness is low (${g.score}%). Submission blocked.`);
    console.error(`Regenerate the profile (apply-new generate) or pass --force to bypass.`);
    process.exit(2);
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

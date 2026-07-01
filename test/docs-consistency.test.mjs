// Defect-to-test: every one of these was first caught by hand.
//
// 1. The slash command's narrative.json schema lagged behind the fields
//    assembleProfile actually consumes (ai_relationship and intensity were
//    missing — the model only wrote them by accident).
// 2. The slash command quoted a CLI output string ("… rappresentativi: …")
//    that the CLI no longer prints (output was translated to English).
// 3. The slash command used a REAL repo name of a real candidate as its
//    example repoLabel — a proper-name leak in the public repo of a tool
//    whose privacy rule is "counts, not names".

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const command = readFileSync(new URL("../.claude/commands/apply-new.md", import.meta.url), "utf8");
const profileSrc = readFileSync(new URL("../src/profile.mjs", import.meta.url), "utf8");
const llmSrc = readFileSync(new URL("../src/profile-llm.mjs", import.meta.url), "utf8");
const binSrc = readFileSync(new URL("../bin/apply-new.mjs", import.meta.url), "utf8");

test("slash command schema covers every narrative key assembleProfile consumes", () => {
  const keys = new Set([...profileSrc.matchAll(/narrative\?\.([a-z_]+)/g)].map((m) => m[1]));
  keys.delete("projects"); // rendered as the projects array, present in the schema by example
  for (const key of keys) {
    assert.ok(command.includes(`"${key}"`), `slash command schema is missing narrative key "${key}"`);
  }
});

test("LLM system prompt schema covers the same narrative keys", () => {
  const keys = new Set([...profileSrc.matchAll(/narrative\?\.([a-z_]+)/g)].map((m) => m[1]));
  keys.delete("projects");
  for (const key of keys) {
    assert.ok(llmSrc.includes(`"${key}"`), `profile-llm SYSTEM schema is missing narrative key "${key}"`);
  }
});

test("CLI output strings quoted in the slash command still exist in the CLI", () => {
  assert.ok(!/rappresentativ/i.test(command), "slash command quotes the old Italian CLI output");
  assert.ok(binSrc.includes("representative:"), "CLI no longer prints the 'representative:' line the slash command refers to");
  assert.ok(command.includes("representative:"), "slash command no longer quotes the 'representative:' CLI line");
});

test("slash command does not hardcode the representative-project count (it's adaptive 3-5)", () => {
  // 4. The slash command said "the four that were auto-selected" while the CLI
  //    moved to an adaptive 3-5 selection — a hardcoded count in the docs that
  //    silently lies as soon as the selection logic changes.
  assert.ok(
    !/\b(four|three|five) (representative|auto-selected)\b|\bthe (four|three|five) that were\b/i.test(command),
    "slash command hardcodes a representative-project count",
  );
});

test("slash command paths match the out/ folder bin actually writes to", () => {
  // 5. Generated files moved from the repo root to out/; any doc still
  //    telling the model to read/write the bare filename would make the
  //    narrative step look in the wrong place.
  const outDir = binSrc.match(/const OUT_DIR = "([^"]+)"/)?.[1];
  assert.ok(outDir, "bin must declare OUT_DIR");
  for (const f of ["narrative-input.json", "narrative.json", "candidate.json", "profile.md", "payload-preview.json"]) {
    assert.ok(command.includes(`\`${outDir}/${f}\``), `slash command must reference ${outDir}/${f}`);
    assert.ok(!command.includes(`\`${f}\``), `slash command references ${f} without the ${outDir}/ prefix`);
  }
});

test("example repoLabels in the slash command are fictional (acme-*)", () => {
  // Any italicised repo-style example must be an obviously fake name. A real
  // repoLabel here is a privacy leak in a public file.
  const examples = [...command.matchAll(/\*([a-z][a-z0-9]*(?:-[a-z0-9]+)+)\*/g)].map((m) => m[1]);
  assert.ok(examples.length > 0, "expected at least one italicised repoLabel example");
  for (const e of examples) {
    assert.ok(e.startsWith("acme-"), `example repoLabel "${e}" must start with "acme-" so it can never be a real repo`);
  }
});

// --- the Node floor and the payload preview (defect-to-test) -----------------
// 6. engines >=20 was advisory only: `node bin/apply-new.mjs` bypassed npm's
//    check entirely and died on old Node with a bare ReferenceError. The floor
//    now lives in three places that must not drift: engines, the README
//    requirement line, and the runtime check in bin.
// 7. The repoLabel strip ran invisibly inside submitProfile; --dry-run makes
//    the exact payload inspectable and must stay documented where users look.
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const privacy = readFileSync(new URL("../PRIVACY.md", import.meta.url), "utf8");

test("the Node floor is pinned in engines, README, and the runtime check", () => {
  assert.equal(pkg.engines?.node, ">=20", "package.json engines must state >=20");
  assert.ok(readme.includes("Node 20"), "README must state the Node requirement");
  assert.match(binSrc, /process\.versions\.node/, "bin must check the running Node version");
  assert.match(binSrc, /nodeMajor < 20/, "the runtime floor must match engines (20)");
});

test("submit --dry-run and its output file are documented in all three user surfaces", () => {
  for (const [name, text] of [["README", readme], ["PRIVACY", privacy], ["slash command", command]]) {
    assert.ok(text.includes("--dry-run"), `${name} must mention submit --dry-run`);
    assert.ok(text.includes("payload-preview.json"), `${name} must name the preview file`);
  }
});

// --- orchestration disclosure (review follow-up on #5) -------------------------
// 8. PR #5 added per-project orchestration metrics to the submitted payload but
//    PRIVACY.md's consent enumeration (§2) was not updated — the previous two
//    payload-shape changes (sources block, intensity) both updated PRIVACY in
//    the same commit, and nothing catches the drift class. Pin the disclosure.
test("PRIVACY §2 consent enumeration discloses the per-project orchestration counts", () => {
  const sec2 = privacy.slice(privacy.indexOf("## 2. What we collect"), privacy.indexOf("## 2a."));
  assert.ok(sec2.length > 0, "PRIVACY must keep §2 and §2a headings");
  assert.ok(/orchestration/i.test(sec2), "PRIVACY §2 must disclose the orchestration counts");
  assert.ok(/agent CLI|per-CLI/i.test(sec2), "PRIVACY §2 must say the split is per agent CLI");
});

test("PRIVACY §7 transparency list names the orchestration signals", () => {
  const sec7 = privacy.slice(privacy.indexOf("## 7."), privacy.indexOf("## 8."));
  assert.ok(/orchestration/i.test(sec7), "PRIVACY §7 must name the orchestration counts among the measured signals");
});

// 9. The narrative model receives per-project orchestration data, but neither
//    narrative surface (the SYSTEM prompt, the slash command) described the
//    field — and the "toolCount is a LOWER BOUND under single-source capture"
//    caveat lived only as a code comment in digest.mjs, invisible to the one
//    consumer that interprets the data. Without it the model is invited to
//    read {toolCount: 1, dispatchCommands: 0} as "no fan-out happened", and
//    disjoint-era multi-tool as concurrent orchestration.
test("both narrative surfaces describe the orchestration input and its caveats", () => {
  for (const [name, text] of [["profile-llm SYSTEM", llmSrc], ["slash command", command]]) {
    assert.ok(text.includes("orchestration"), `${name} must describe the orchestration field`);
    assert.ok(/lower bound/i.test(text), `${name} must carry the lower-bound caveat`);
    assert.ok(text.includes("toolOverlap"), `${name} must explain toolOverlap`);
    assert.ok(/migration/i.test(text), `${name} must warn that multi-tool without overlap may be migration, not fan-out`);
  }
});

// 10. PRIVACY §7 says "This file and the README describe ... the per-product
//     orchestration counts" — so the README half of that claim must be true,
//     and stay true.
test("README describes the per-product orchestration counts PRIVACY §7 attributes to it", () => {
  assert.ok(/orchestration counts/i.test(readme), "README must describe the per-product orchestration counts");
  assert.ok(/agent CLI/i.test(readme), "README must say the split is per agent CLI");
});

// 11. dispatchCommands counts headless agent dispatch INCLUDING the same CLI
//     (claude -p from a Claude Code session is the most common case). A surface
//     that presents dispatchCommands > 0 as evidence of CROSS-CLI fan-out
//     licenses a claim the data does not show.
test("all three surfaces say dispatch may target the same CLI, not only another", () => {
  for (const [name, text] of [["profile-llm SYSTEM", llmSrc], ["slash command", command], ["PRIVACY", privacy]]) {
    assert.ok(/same (CLI|tool)/i.test(text), `${name} must say dispatch may target the same CLI/tool`);
  }
});

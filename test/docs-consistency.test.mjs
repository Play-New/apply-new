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

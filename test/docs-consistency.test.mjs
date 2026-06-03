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

test("example repoLabels in the slash command are fictional (acme-*)", () => {
  // Any italicised repo-style example must be an obviously fake name. A real
  // repoLabel here is a privacy leak in a public file.
  const examples = [...command.matchAll(/\*([a-z][a-z0-9]*(?:-[a-z0-9]+)+)\*/g)].map((m) => m[1]);
  assert.ok(examples.length > 0, "expected at least one italicised repoLabel example");
  for (const e of examples) {
    assert.ok(e.startsWith("acme-"), `example repoLabel "${e}" must start with "acme-" so it can never be a real repo`);
  }
});

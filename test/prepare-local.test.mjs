// `prepare` is the manual path: PRIVACY.md promises nothing leaves the machine
// until `submit`. It must not reach the Anthropic API even when a key is set.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/apply-new.mjs", import.meta.url));

test("prepare writes narrative-input.json without calling the API when a key is set", () => {
  const tmp = mkdtempSync(join(tmpdir(), "prep-local-"));
  try {
    const home = join(tmp, "home");
    const root = join(tmp, "projects");
    const work = join(tmp, "work");
    const proj = join(root, "-tmp-demo");
    for (const d of [home, proj, work]) mkdirSync(d, { recursive: true });
    const cwd = join(tmp, "demo");
    const lines = [
      { type: "user", sessionId: "s1", cwd, timestamp: "2026-05-01T10:00:00.000Z", uuid: "u1", version: "1.0.0",
        message: { role: "user", content: "let's build the agent route and the api" } },
      { type: "assistant", sessionId: "s1", cwd, timestamp: "2026-05-01T10:01:00.000Z", uuid: "u2", parentUuid: "u1", version: "1.0.0",
        message: { role: "assistant", model: "claude-x", content: [{ type: "text", text: "ok" }] } },
    ];
    writeFileSync(join(proj, "s1.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const r = spawnSync(
      process.execPath,
      [BIN, "prepare", "--root", root, "--no-opencode", "--no-codex", "--no-pi", "--no-cursor", "--no-kimi"],
      {
        cwd: work,
        encoding: "utf8",
        env: { ...process.env, HOME: home, USERPROFILE: home, ANTHROPIC_API_KEY: "sk-test-not-a-key" },
        timeout: 60000,
      }
    );
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(work, "out", "narrative-input.json")), "narrative-input.json written");
    assert.doesNotMatch(r.stderr, /ANTHROPIC_API_KEY is set/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

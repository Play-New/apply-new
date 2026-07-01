// Review follow-ups on the per-product orchestration signal (PR #5, 180d2a5).
// Each test pins a defect the review reproduced against the shipped code:
//
//  1. countDispatch split commands with no quote/heredoc awareness, so
//     launcher names inside quoted strings and heredoc bodies counted as real
//     dispatches (and a dispatch whose quoted prompt contained a separator
//     was double-counted) — the opposite of the documented lower bound.
//  2. The separator list omitted single `&`, so PARALLEL fan-out — the exact
//     pattern the signal measures — went uncounted.
//  3. AGENT_LAUNCHER_RE required the headless flag as the FIRST token after
//     `claude`, so `claude --model opus -p "x"` counted 0.
//  4. Bare `aider`/`cursor-agent` counted interactive/housekeeping runs while
//     `codex login` was excluded — the same headless-only rule, applied to
//     some launchers and not others.
//  5. The /i flag admitted sentence-initial prose ("Aider is ...") and
//     never-typed forms like "CLAUDE -P"; executables are case-sensitive.
//  6. A quoted env value containing a space broke the env strip and hid a
//     genuine dispatch.
//  7. Launchers directly inside a subshell counted or not depending on which
//     separator preceded them, contradicting the documented contract.
//  8. An untagged session bucketed as "unknown" counted as a distinct CLI,
//     manufacturing a fan-out signal the sources block contradicted.
//  9. Multi-tool with disjoint eras (sequential migration between CLIs) was
//     indistinguishable from concurrent fan-out: toolOverlap carries that.
// 10. The human review surface (profile.md) hid the orchestration data that
//     candidate.json submits.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDigest } from "../src/digest.mjs";
import { renderMarkdown } from "../src/profile.mjs";
import { mergeSources } from "../src/adapters/opencode.mjs";
import { sess } from "./factories.mjs";

const dispatches = (cmds) =>
  buildDigest({ sessions: [sess("claude-code", "z", cmds)] }).projects[0].orchestration.dispatchCommands;

// --- 1. quote/heredoc awareness ----------------------------------------------

test("launcher names inside quoted arguments are not dispatches", () => {
  assert.equal(dispatches(['git commit -m "docs: usage; claude -p prompts explained"']), 0);
  assert.equal(dispatches(['grep -E "x|claude -p y" file.txt']), 0);
  assert.equal(dispatches(["echo 'a; codex exec b'"]), 0);
});

test("a dispatch whose quoted prompt contains separators counts exactly once", () => {
  assert.equal(dispatches(["claude -p 'fix a; claude -p b'"]), 1);
});

test("heredoc bodies are not scanned for launchers", () => {
  assert.equal(dispatches(['cat > run.sh <<\'EOF\'\nclaude -p "$1"\nEOF']), 0);
  assert.equal(dispatches(["cat > README.md <<EOF\nAider is my favorite tool\nEOF"]), 0);
});

// --- 2. single & is a top-level separator ------------------------------------

test("parallel dispatches separated by single & are counted", () => {
  assert.equal(dispatches(['claude -p "a" & claude -p "b" & wait']), 2);
  assert.equal(dispatches(['npm run dev & claude -p "check it"']), 1);
});

// --- 3. flags before the headless marker --------------------------------------

test("flags between the launcher and -p/--print/exec still count", () => {
  assert.equal(dispatches(['claude --model opus -p "fix tests"']), 1);
  assert.equal(dispatches(['claude --dangerously-skip-permissions -p "go"']), 1);
  assert.equal(dispatches(['codex --model o3 exec "do x"']), 1);
  assert.equal(dispatches(["claude --model opus"]), 0); // still the REPL
});

// --- 4. headless-only rule applies to every launcher --------------------------

test("aider and cursor-agent count only headless, like claude and codex", () => {
  assert.equal(dispatches(['aider --message "fix the tests"']), 1);
  assert.equal(dispatches(['aider -m "fix"']), 1);
  assert.equal(dispatches(['cursor-agent -p "review this"']), 1);
  assert.equal(dispatches(["aider"]), 0); // interactive TUI
  assert.equal(dispatches(["aider --yes"]), 0); // interactive with autoconfirm
  assert.equal(dispatches(["aider --version"]), 0); // housekeeping
  assert.equal(dispatches(["cursor-agent"]), 0); // interactive TUI
  assert.equal(dispatches(["cursor-agent login"]), 0); // housekeeping
});

// --- 5. case-sensitive matching -----------------------------------------------

test("matching is case-sensitive: prose at a fragment start is not a dispatch", () => {
  assert.equal(dispatches(["CLAUDE -P hello"]), 0);
  assert.equal(dispatches(["echo x; Aider is my favorite tool"]), 0);
});

// --- 6. env assignments with quoted values -------------------------------------

test("a quoted env value with spaces does not hide the dispatch", () => {
  assert.equal(dispatches(['FOO="bar baz" claude -p x']), 1);
  assert.equal(dispatches(['A=1 B="two words" opencode run "/task"']), 1);
});

// --- 7. subshells and loop bodies count position-independently -----------------

test("launchers directly inside a subshell count regardless of position", () => {
  assert.equal(dispatches(['(claude -p "a"; claude -p "b")']), 2);
  assert.equal(dispatches(['(cd /tmp && claude -p "x")']), 1);
});

test("a dispatch in a for-loop body counts", () => {
  assert.equal(dispatches(['for f in a b; do claude -p "$f"; done']), 1);
});

// --- 8. unknown sources never manufacture fan-out ------------------------------

test("an untagged session is bucketed honestly but is not a distinct CLI", () => {
  const d = buildDigest({ sessions: [sess("claude-code", "x"), sess(undefined, "x")] });
  const p = d.projects.find((p) => p.repo === "x");
  assert.deepEqual(p.orchestration.tools, { "claude-code": 1, unknown: 1 });
  assert.equal(p.orchestration.toolCount, 1);
});

test("mergeSources guarantees the per-session source tag at the seam", () => {
  const merged = mergeSources({ source: "claude-code", sessions: [{ id: 1 }, { id: 2, source: "claude-code" }] });
  assert.deepEqual(merged.sessions.map((s) => s.source), ["claude-code", "claude-code"]);
});

// --- 9. fan-out vs migration ----------------------------------------------------

test("disjoint eras across two CLIs read as migration, not concurrent fan-out", () => {
  const p = buildDigest({
    sessions: [
      sess("opencode", "m", [], { ts: "2026-01-10T10:00:00.000Z" }),
      sess("claude-code", "m", [], { ts: "2026-03-15T10:00:00.000Z" }),
    ],
  }).projects[0];
  assert.equal(p.orchestration.toolCount, 2);
  assert.equal(p.orchestration.toolOverlap, false);
});

test("interleaved sessions across two CLIs report overlapping tools", () => {
  const p = buildDigest({
    sessions: [
      sess("claude-code", "m", [], { ts: "2026-03-01T10:00:00.000Z" }),
      sess("opencode", "m", [], { ts: "2026-02-20T10:00:00.000Z" }),
      sess("claude-code", "m", [], { ts: "2026-02-01T10:00:00.000Z" }),
    ],
  }).projects[0];
  assert.equal(p.orchestration.toolOverlap, true);
});

test("toolOverlap is null when a single tool touched the product", () => {
  const p = buildDigest({ sessions: [sess("claude-code", "x")] }).projects[0];
  assert.equal(p.orchestration.toolOverlap, null);
});

// --- 10. the human review surface shows what is submitted -----------------------

const renderProfile = () => ({
  contact: { name: "X" },
  window: { from: "2026-01", to: "2026-05" },
  volume: { products: 1, sessions: 12, instructions: 100 },
  authenticity: { score: 100, note: "screen, not proof" },
  summary: null,
  domains: [],
  projects: [{
    id: "p1", repoLabel: "acme-app", type: ["product-build"], domain: "x",
    span: { from: "2026-01", to: "2026-05" }, sessions: 12,
    did: null, whyRepresentative: null, tech: [],
    landing: { commits: 3, reverts: 0, revertChurn: "low", checksRun: false },
    metrics: {
      researchToMutation: null, delegation: 4,
      orchestration: { delegation: 4, tools: { "claude-code": 8, opencode: 4 }, toolCount: 2, toolOverlap: true, dispatchCommands: 7 },
    },
    artifact: null,
  }],
  otherProjects: [],
  cognitive: { tags: [], narrative: null },
});

test("profile.md shows the orchestration data that candidate.json submits", () => {
  const md = renderMarkdown(renderProfile());
  assert.ok(md.includes("claude-code 8"), md);
  assert.ok(md.includes("opencode 4"), md);
  assert.match(md, /7 agent dispatch/);
  assert.match(md, /4 sub-agent delegation/);
});

test("a single-tool, no-dispatch, no-delegation project renders no orchestration line", () => {
  const p = renderProfile();
  p.projects[0].metrics.orchestration = { delegation: 0, tools: { "claude-code": 12 }, toolCount: 1, toolOverlap: null, dispatchCommands: 0 };
  assert.doesNotMatch(renderMarkdown(p), /orchestration:/);
});

test("multi-tool without overlap renders as different periods, not concurrency", () => {
  const p = renderProfile();
  p.projects[0].metrics.orchestration = { delegation: 0, tools: { "claude-code": 8, opencode: 4 }, toolCount: 2, toolOverlap: false, dispatchCommands: 0 };
  assert.match(renderMarkdown(p), /different periods/);
});

// --- 11. pathological inputs must not hang the digest (ReDoS) ------------------
// The first fix round introduced LAUNCHER_FLAGS with two same-span ambiguities
// (`--?[\w-]+` parsing `--flag` two ways; a quoted value matching both the
// quoted and the bare-value alternative), giving exponential backtracking on
// flag-heavy commands with NO headless marker — one such logged command hung
// the whole digest. The alternatives must be first-char-disjoint.
test("flag-heavy non-headless commands complete fast (no catastrophic backtracking)", () => {
  const pathological = [
    'claude ' + '--a "b" '.repeat(12) + "q",
    "claude " + "--flag value ".repeat(24) + "x",
    "aider " + "--no-auto-commits ".repeat(24) + "files.py",
  ];
  const t0 = Date.now();
  const n = dispatches(pathological);
  const elapsed = Date.now() - t0;
  assert.equal(n, 0);
  assert.ok(elapsed < 250, `took ${elapsed}ms — the launcher regex is backtracking catastrophically`);
});

// --- 12. shell syntax the quote-aware splitter must still respect --------------

test("shell comments do not open phantom quotes", () => {
  assert.equal(dispatches(["echo done # can't wait\nclaude -p \"next\""]), 1);
  assert.equal(dispatches(["claude -p a # don't\nclaude -p b"]), 2);
  assert.equal(dispatches(["curl http://x/#fragment && claude -p go"]), 1); // mid-word # is literal
});

test("a <<< here-string is not an open heredoc", () => {
  assert.equal(dispatches(['grep -c foo <<< bar\nclaude -p "analyze"']), 1);
});

test("heredoc delimiters with dashes close correctly", () => {
  assert.equal(dispatches(["cat <<END-MARKER\nbody\nEND-MARKER\nclaude -p after"]), 1);
});

test("a plain << heredoc does not close at an indented delimiter (only <<- does)", () => {
  assert.equal(dispatches(["cat <<EOF\ntext\n  EOF\nclaude -p leak\nEOF"]), 0);
  assert.equal(dispatches(["cat <<-EOF\n\tbody\n\tEOF\nclaude -p after"]), 1);
});

test("escaped spaces in bare env values strip correctly in both directions", () => {
  assert.equal(dispatches(["FOO=a\\ b claude -p x"]), 1); // dispatch was hidden (undercount)
  assert.equal(dispatches(["FOO=a\\ claude -p x"]), 0); // "claude" is the env value, `-p` runs (overcount)
});

// --- 13. aider's canonical file-first invocation ---------------------------------
// aider has no subcommands, so positional file args before --message are safe
// to skip over; claude/codex keep the flags-only rule (a subcommand's -p must
// not read as the top-level headless flag).
test("aider file-first headless invocations count; subcommand flags still don't", () => {
  assert.equal(dispatches(['aider app.py tests.py -m "fix the failing tests"']), 1);
  assert.equal(dispatches(['aider src/main.py --message "refactor"']), 1);
  assert.equal(dispatches(["claude mcp add -p x"]), 0);
});

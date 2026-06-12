// Defect-to-test: three empty catch{} blocks in enrich.mjs meant a candidate
// whose repos had moved or weren't git repos got a silently thinner narrative
// with no explanation. The catches stay (they encode expected absence); the
// fix is one aggregate, output-shape-derived note.
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeContextGaps } from "../src/enrich.mjs";

const rich = { found: true, pkgName: "app", doc: "README text", commits: ["fix: x"] };

test("no note when every selected project produced context", () => {
  assert.equal(describeContextGaps([rich, rich]), null);
  assert.equal(describeContextGaps([]), null);
});

test("counts repos that were not found at all", () => {
  const msg = describeContextGaps([rich, { found: false }]);
  assert.match(msg, /1 of 2 selected projects/);
});

test("counts repos that were found but yielded nothing usable", () => {
  // found a root, but no package.json, no doc, no git log — contributed nothing.
  const empty = { found: true, pkgName: null, doc: null, commits: [] };
  const msg = describeContextGaps([rich, empty, { found: false }]);
  assert.match(msg, /2 of 3 selected projects/);
});

test("a repo with only ONE context source still counts as covered", () => {
  assert.equal(describeContextGaps([{ found: true, pkgName: null, doc: "CLAUDE.md", commits: [] }]), null);
});

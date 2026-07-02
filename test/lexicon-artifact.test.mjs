// The checked-in lexicon artifact (share/tech-lexicon.json) is the cross-repo
// contract: play-new-dashboard vendors it verbatim so its intake groundedness
// recompute extracts the same tech anchors this repo's client does. A digest
// label-map change that isn't regenerated into the artifact would silently
// drift the two implementations apart — the exact failure mode the intake's
// claimed-vs-recomputed delta flag then blames on the candidate. This test
// turns that drift into a red build instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TECH_LEXICON } from "../src/groundedness.mjs";

const artifact = () =>
  JSON.parse(readFileSync(new URL("../share/tech-lexicon.json", import.meta.url), "utf8"));

test("share/tech-lexicon.json matches the live TECH_LEXICON (run `npm run lexicon` after changing the label maps)", () => {
  assert.deepEqual(artifact().tokens, [...TECH_LEXICON].sort());
});

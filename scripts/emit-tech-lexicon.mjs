// Regenerates share/tech-lexicon.json from the live TECH_LEXICON in
// src/groundedness.mjs. Run after any change to the digest label maps or the
// hardcoded TECH_NAMES/stoplist: `npm run lexicon`. The artifact is the
// cross-repo contract the play-new-dashboard intake vendors verbatim so both
// sides extract identical tech anchors; test/lexicon-artifact.test.mjs keeps
// it honest.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TECH_LEXICON } from "../src/groundedness.mjs";

const out = fileURLToPath(new URL("../share/tech-lexicon.json", import.meta.url));
const artifact = {
  $comment:
    "GENERATED — do not edit by hand. Source: src/groundedness.mjs TECH_LEXICON (TECH_NAMES + digest labelVocabulary(), splitTech-tokenised, stoplist-filtered). Regenerate with `npm run lexicon`. Vendored verbatim by play-new-dashboard (src/lib/apply-tech-lexicon.json) so the intake recompute extracts the same tech anchors.",
  tokens: [...TECH_LEXICON].sort(),
};
writeFileSync(out, JSON.stringify(artifact, null, 2) + "\n");
console.log(`share/tech-lexicon.json: ${artifact.tokens.length} tokens`);

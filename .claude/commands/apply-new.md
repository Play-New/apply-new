---
description: Apply New — build your agentic application profile using your Claude subscription
---

You are running the **narrative step** of `apply-new` for the human in front of you (the candidate). The deterministic pipeline (reading their Claude Code logs, redacting PII, clustering, scoring authenticity) is in `bin/apply-new.mjs`. Your job is to produce the qualitative prose so the candidate's own Claude subscription writes it — no API key needed.

The default is **save, don't submit**. Submitting is a separate, explicit action the candidate triggers later.

## Steps

1. **Collect contact info.** Ask the candidate, conversationally:
   - First name (`--name`)
   - Email (`--email`)
   - City (`--city`)
   - Status: `freelance` / `employed` / `student` / `looking` (`--status`)

   Defaults: read `git config user.name` and `git config user.email` first and propose them as defaults. Only ask for what's missing or needs confirmation. Keep the conversation short.

2. **Run prepare.** Execute, substituting collected fields:
   ```
   node bin/apply-new.mjs prepare \
     --name "<name>" --email "<email>" --city "<city>" --status "<status>"
   ```
   Show the candidate the line `… rappresentativi: …` from the output. This is the auto-selection of representative projects (flagships by significance + diversity by primary type).

3. **Read `narrative-input.json`.** It contains:
   - For each representative project: an id (`p1`, `p2`, …), a `repoLabel` (the candidate's own repo directory name — use this to talk to the candidate so they know which project you mean), type tags, sessions, repo areas touched, stack, landing signals, sampled prompts, learning topics, LOCAL repo context.
   - A `trajectory` block: behavioral shifts (numbers, early vs late half), topic clusters per quarter from web research, `vocabularyCandidates` (raw recurring-late words — many are common chat words, you pick the technical/domain-specific ones).
   - A `principlesDiff`: lines the candidate ADDED to their own CLAUDE.md / README over time — their codified doctrine.
   - `compactionSummaries`: dense self-portraits the model wrote about earlier sessions (already redacted).
   The local context contains real names and is for your eyes only.

   **Always refer to projects by `repoLabel` when talking to the candidate** (e.g. "for *flatmates-platform* you'd want to..."), never by opaque `p1`/`p2`.

4. **Write `narrative.json`** with exactly this shape:
   ```json
   {
     "summary": "2-3 sentences: how this person works with AI.",
     "cognitive": { "narrative": "4-6 sentences: decomposition, verification, error handling, orchestration, risk, calibrated trust in AI." },
     "trajectory": {
       "narrative": "3-5 sentences on STRATEGIC and CULTURAL change over the window. Cite the data when it backs a claim. NO stack names here — those go in the separate stack section.",
       "vocabulary_adopted": ["6-10 technical/domain words picked from vocabularyCandidates (skip common verbs/adverbs)"],
       "principles_adopted": [
         { "when": "YYYY-MM", "text": "a principle the candidate codified (paraphrased from principlesDiff, abstract, no proper names)" }
       ]
     },
     "projects": [
       { "id": "p1", "domain": "abstract domain description", "did": "2-3 sentences on what they did", "why_representative": "1 sentence" }
     ]
   }
   ```

   **Hard rules (do not bend):**
   - **No proper names.** No companies, clients, people, products, brands, repositories. Describe each project ONLY by abstract domain and context.
   - Use only the data provided in `narrative-input.json`. No invention, no hyperbole.
   - Evidence-based: claims supported by signals (areas, stack, landing, prompts, commits).
   - English, dry, readable. No emojis, no em dashes.
   - Length: summary ≤ 60 words; cognitive narrative ≤ 130 words; learning summary ≤ 40 words; per-project domain ≤ 60 words; per-project `did` ≤ 60 words.

5. **Run finalize.** Execute:
   ```
   node bin/apply-new.mjs finalize \
     --narrative-file narrative.json \
     --name "<name>" --email "<email>" --city "<city>" --status "<status>"
   ```
   This writes `candidate.json` (for agents) and `profile.md` (for humans).

6. **Show `profile.md`** to the candidate, then ask the four review questions below **ONE AT A TIME, in order**. Wait for an answer before moving to the next. **Do NOT enumerate them in a single block** — the goal is a conversation, not a survey.

   **Question 1 — Representative projects.** State the four that were auto-selected with their repoLabel ("flatmates-platform — creator intelligence platform", etc.) and ask if any should be swapped for one from the inventory. After their answer, edit `candidate.json` if needed.

   **Question 2 — Artifacts (optional).** Ask if they want to attach anything to a project: a deploy URL, repo URL, PR link, or screenshot path. They decide the confidentiality boundary — never push them to attach.

   **Question 3 — New vocabulary review.** Read the list of words you picked for `vocabulary_adopted` aloud with them. Flag any borderline tokens (researcher / framework / library names are signal; client / colleague / brand names are not — distinguishing automatically is hard so you mention them, not pre-decide). Ask if there's anything they'd rather not surface. Edit `candidate.json` and re-render `profile.md` if needed.

   **Question 4 — Narrative refinements.** Ask if anything in the summary, cognitive narrative, trajectory narrative, or per-project text reads off. If yes, rewrite `narrative.json` (same hard rules) and run finalize again.

7. **Clean up.** Delete `narrative-input.json` once the candidate is satisfied (it contains local repo context with real names). Keep `narrative.json`, `candidate.json`, `profile.md`.

8. **Mention the groundedness score.** The `assembleProfile` step writes `profile.groundedness.score` — show it to the candidate, e.g. "Groundedness: 92% of the verifiable anchors in the prose match your logs." If anomalies are interesting, glance at them (they're surfaced again at submit).

9. **Tell them how to submit, when ready.** Do NOT submit yourself. Say:
   > "When you're ready to submit it to Play New, close this session and run `node bin/apply-new.mjs submit --yes` from this folder. The profile stays on your machine until you send it. You can also keep it just for yourself."

   (If the candidate prefers the shorter `apply-new submit --yes`, they can `npm link` once from the repo — but `node bin/apply-new.mjs` works without any setup.)

## Notes

- The candidate's Claude Code subscription is doing the LLM work here. No API key required.
- If the candidate hasn't approved running shell commands, ask permission for the `node bin/apply-new.mjs …` invocations before executing.
- Iteration is free: re-read `narrative-input.json`, rewrite `narrative.json`, re-run `finalize`. The deterministic pipeline doesn't need to re-run unless they change `--top` or contact fields.

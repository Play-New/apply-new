# Contributing

Real contributions land here — adapters, signal fixes, metric corrections. This file
exists because the repo has a few rules that are unusual, and knowing them up front
makes review fast.

## Quick start

```
git clone https://github.com/Play-New/apply-new
cd apply-new
npm test          # node --test, zero dependencies, Node >= 20
```

There is no build step and there are **no runtime dependencies** — a PR that adds one
needs a very good reason stated in its description.

## The frame (the review criterion)

Apply New is a **report, not a selection instrument** — [ADR-001](docs/adr/001-just-a-report.md).
Counts and observations describe how a person works; nothing in the pipeline may
grade, rank, recommend, or pass/fail a person. The two embedded scores
(authenticity, groundedness) measure the *artifact* — log integrity and
prose-vs-data agreement — never the candidate. Every PR is reviewed against this
line. A feature that emits a number about a person surfaces it as an anchored count
("seen in 3 of 40 sessions"), never as a score.

## Schema discipline

The profile is read by people making real decisions, so its numbers carry weight:

- **New `candidate.json` fields must be optional/nullable.** The frozen fixture in
  `test/fixture.test.mjs` pins the old shape and must keep passing unmodified.
- **New numbers must be verifiable.** Anything a narrative could cite joins the
  groundedness support pool (`src/groundedness.mjs`); anything claimed at submit
  time joins the log re-derivation (`src/consistency.mjs`). A number that can't be
  re-derived is unverifiable surface and won't be merged.
- **Determinism matters.** Counts must re-derive identically from the same logs. If
  a computation depends on timezone or locale, record the offset used in the
  profile so the number is reproducible.
- **Load-bearing small integers are rendered deterministically**, never routed
  through the LLM narrative.

## Privacy boundaries (hard rules)

- **Never read `.env`** — not even key names. "The tool never opens your secrets
  file" is a promise we make to candidates under NDA.
- **`repoLabel` never leaves the machine.** It exists only so candidates recognise
  their own projects during local curation; submit strips it.
- **Custom MCP servers, skills, and commands surface as counts only**, never names
  (they can carry client information).
- PII redaction (`src/redact.mjs`) runs before anything else sees the logs.
- Nothing is transmitted until the candidate explicitly runs `submit --yes`. See
  [PRIVACY.md](PRIVACY.md) — including §2a on the three narrative paths.

## Log sources

Current policy: **Claude Code (primary), opencode (open-source fallback), and codex**
— three sources done properly before more are added; codex landed via issue #15. A
new source needs a provenance and `capture_level` story, not just a parser: open an
issue to discuss it **before** writing an adapter PR. The adapter seam
(`src/adapters/`, shared session model) is built for expansion, so the conversation
is about trust, not plumbing.

## Process

1. **Behavior changes: open an issue first.** Small fixes with tests can go
   straight to PR.
2. CI must pass (`npm test` on Node 20/22/26, plus Windows).
3. Maintainers: @rinaldofesta and @matteoroversi. Decisions that change what the
   tool *is* are recorded in [docs/adr/](docs/adr/) — feel free to cite them in
   review, and to argue with them in issues.
4. Security issues: **not** public issues — see [SECURITY.md](SECURITY.md).

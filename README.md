# Apply New

> `apply-new` — a new way to apply for a job at Play New.

A CV tells us what you did. We want to see *how* you think. If you work with AI tools every day, the way you reason, decompose, verify, and recover from mistakes is already written down — it's in your Claude Code logs. Apply New turns those logs into a short, anonymised work profile, and lets you decide what to do with it.

- **Your data stays yours.** Everything runs on your laptop. Client, product and people names are stripped out. You see the profile before anyone else does — and you can keep it just for yourself.
- **You write it, your AI helps.** The qualitative parts use *your* Claude Code subscription — no API key, no extra cost. The profile sounds like you.

> Today Apply New reads **Claude Code** logs. Codex CLI, Gemini CLI, and ChatGPT / Claude.ai exports are on the roadmap.

## How to use it

You need [Claude Code](https://claude.com/claude-code) and a Claude subscription (Pro, Max, or Enterprise).

```
git clone https://github.com/Play-New/apply-new
cd apply-new
claude
> /apply-new
```

The slash command:

1. Asks for four contact fields (name, email, city, status: `freelance` / `employed` / `student` / `looking`).
2. Reads your Claude Code history locally and reconstructs your projects.
3. Lets your Claude write a short profile in your voice.
4. Shows you `profile.md` so you can adjust it.
5. Tells you how to submit when you're ready — **submission is a separate step**.

You'll end up with two files:
- `profile.md` — readable by you and a recruiter
- `candidate.json` — readable by an agent (matching, ranking)

## Submit when (and if) you want

```
apply-new submit --yes
```

Shows what's about to be sent, asks for confirmation, sends it to Play New. You can also keep the profile just for yourself and never run this.

## Commands

| Command | What it does |
|---|---|
| `apply-new generate` *(default)* | full profile, locally |
| `apply-new prepare` | only `narrative-input.json` (if you want to write the narrative manually) |
| `apply-new finalize --narrative-file narrative.json` | finalize after `prepare` |
| `apply-new submit --yes` | send to Play New |

Common flags: `--name`, `--email`, `--city`, `--status`, `--top N`, `--root <dir>`.

If you don't have Claude Code, you can also: `ANTHROPIC_API_KEY=… apply-new generate` (automates the narrative via the Claude API), or `prepare` → write `narrative.json` by hand → `finalize`.

## What we collect, what we don't

With your consent, the submitted bundle contains:
- the four contact fields you typed
- a `playnew-profile/v1` JSON (window, volumes, representative projects with abstract domains, cognitive tags, trajectory, stack adopted)
- artifacts you explicitly chose to attach

It does **not** contain:
- names of companies, clients, people, products, brands, or repositories
- your code
- your raw logs

**What we do with it.** A human at Play New reads it and matches you against open projects. We don't pass your data outside Play New, train models on it, or include it in client-facing dashboards.

**Want it gone?** Email `hey@playnew.com` and we delete your application and any attached artifacts. Locally, just remove `profile.md` and `candidate.json` — they're plain files.

## How we build the profile

The profile is a **portrait, not a grade** — useful for you (to see how you actually work) as much as for whoever reads it.

**Project types** — descriptive tags computed from the files you touched:

| Tag | Trigger |
|---|---|
| `product-build` | sustained work on one product (>200 mutations over >14 days) |
| `audit-research` | heavy reading and analysis, light changes (R:M > 10) |
| `agent-tooling` | skill / command / hook files for AI agents |
| `data-migration` | schema, SQL, or migration files |
| `static-site` | HTML-heavy |
| `ai-platform` | API routes for chat / agent / connectors |
| `feature-work`, `testing`, `quality-gating`, `orchestrated`, `design-research` | self-explanatory |

**Cognitive tags** — derived from thresholds on objective signals:

| Tag | Threshold |
|---|---|
| `research-first` | average Research:Mutation above 2 |
| `decomposer` | median prompt length ≥ 25 words |
| `orchestrator` | Task/Agent delegations ≥ 15 |
| `verification-heavy` | checks (tsc/eslint/test/build) in ≥ half the projects |
| `risk-calibrated` | revert/commit ratio < 10% over 20+ commits |

These are descriptors, not grades. There is no "better" cognitive tag.

**Cognitive narrative** — 4–6 sentences written by *your* Claude instance, constrained on six dimensions: *decomposition · verification · error handling · orchestration · risk · calibrated trust in AI*. Hard rules: no proper names, evidence-based only, no hyperbole.

**AI relationship** — a single continuous axis from *directing* (you treat the model like a careful junior with long structured prompts) to *co-thinking* (you think out loud, short conversational turns, open questions). The midpoint of the axis is co-construction: using the model to define the problem, not just execute it. The split is computed from prompt-level signals in EN and IT; your own Claude writes 2–3 sentences about *when* you switch modes.

**Trajectory** — what changed strategically over the window:
- *Behavioral shifts*: four metrics (decomposition, delegation, research:mutation, verification) measured on the early vs late half. When they move, there's an apprenticeship.
- *Topic clusters*: web queries grouped by theme, by quarter.
- *New vocabulary*: words that appear only in the late half and recur across multiple distinct prompts.
- *Principles codified*: lines you added to your own CLAUDE.md / README over time.

**Groundedness check** — before submission we extract verifiable anchors from the prose (numbers, technology names, type tags, year-months) and check they exist in the structured data the prose came from. The score is the percentage with a match. Below 60% the submit is blocked; you can regenerate or pass `--force`.

The one external reference: [claude-session-analyzer](https://github.com/lucemia/claude-session-analyzer) by lucemia, for the Research:Mutation idea.

### What this is *not*

- Not a personality test. No Big Five, no MBTI, no DISC.
- Not automatic scoring or ranking. A human reads each profile.
- Not a performance prediction.
- Not a comparison between candidates.

### What it does *not* replace

A profile is a starting point. It does not replace a real conversation, or a real meeting between humans deciding about humans.

### Limits, owned

- *Sample bias.* You decide which projects we see.
- *Tool bias.* Solo-work logs show execution; leadership and pair-work are invisible here.
- *Threshold bias.* Cutoffs are empirical, not validated against a large population.
- *LLM bias.* The narrative is written by a model with its own patterns. The prompt constrains it but doesn't make it neutral.

If you spot a way to make this less biased or more useful, [open an issue](https://github.com/Play-New/apply-new/issues).

## Purpose, policy, AI Act

Apply New helps us understand *how you work with AI*, to match you with the right project. **The decision is human** — the AI generates the profile, it does not score or rank candidates.

- **Legal basis (GDPR Art. 6(1)(a)):** explicit consent. You run `apply-new submit --yes` knowing what is sent.
- **Retention:** while there's active interest, or up to 12 months. You can ask for earlier deletion at any time.
- **Your rights:** access, rectification, erasure, portability, objection, restriction — write to `hey@playnew.com`. Your `candidate.json` is already a copy.
- **EU AI Act (2024/1689) Annex III §4(a):** systems used to "analyse and filter job applications and evaluate candidates" are classified as high-risk. We treat Apply New as such — transparency (this README + open source), human oversight (no automated decision), disclosure (you're using an AI tool), data governance (logs stay local).

Full policy in [PRIVACY.md](PRIVACY.md). If you'd rather not use the tool, write to `hey@playnew.com` for a no-tool conversation.

## Tests

```
npm test
```

## License

MIT. See [LICENSE](LICENSE).

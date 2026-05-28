# Apply New

> `apply-new` — a new way to apply for a job at Play New.

We don't read CVs. A CV tells us what you did; we want to see *how* you think. If you work with AI tools every day, the way you reason, decompose, verify, and recover from mistakes is already written down — it's sitting in your Claude Code logs. Apply New turns those logs into a short, anonymized work profile, and lets you decide what to do with it.

Two things matter:

- **Your data stays yours.** Everything runs on your laptop. Names of clients, products, people are stripped out. You see the profile before anyone else does, and you can keep it just for yourself.
- **You write it, your AI helps.** The qualitative parts use *your* Claude Code subscription — no API key, no extra cost. The profile sounds like you.

> Today Apply New reads **Claude Code** logs. Codex CLI, Gemini CLI, and ChatGPT / Claude.ai exports are on the roadmap — coming soon.

## How to use it

You need [Claude Code](https://claude.com/claude-code) installed and a Claude subscription (Pro, Max, or Enterprise).

```
git clone https://github.com/Play-New/apply-new
cd apply-new
claude
> /apply-new
```

The slash command will:

1. ask you for a few contact fields (name, email, city, status)
2. read your Claude Code history locally and reconstruct your projects
3. let your Claude write a short profile in your voice
4. show you the result and help you adjust it
5. tell you how to submit when you're ready — **submission is a separate step**

You'll end up with two files on your computer:
- `profile.md` — readable by you and a recruiter
- `candidate.json` — readable by an agent (for matching and ranking)

## Submit when (and if) you want

```
apply-new submit --yes
```

Shows you what's about to be sent, asks for confirmation, sends it to Play New. You can also keep the profile just for yourself and never run this.

## What we collect, what we don't

**We collect, with your consent:**
- the four contact fields you typed
- the volume of your work (sessions, products, time window, models used)
- per representative project: an abstract description, the kind of work, the stack, signals like commits/reverts/checks passed
- a few cognitive tags (e.g. *research-first*, *orchestrator*, *verification-heavy*) derived from numbers, not opinions
- artifacts you explicitly chose to attach

**We never collect:**
- names of companies, clients, people, products, brands, or repositories
- your code
- your raw logs

**Want it gone?** Email `hey@playnew.com` and we will delete your application and all attached artifacts from our side. Locally, just remove `profile.md` and `candidate.json` — they're plain files.

## Available commands

| Command | What it does |
|---|---|
| `apply-new generate` *(default)* | full profile, locally |
| `apply-new prepare` | only writes `narrative-input.json` (if you want to write the narrative manually) |
| `apply-new finalize --narrative-file narrative.json` | finalize after `prepare` |
| `apply-new submit --yes` | send to Play New |

Common flags: `--name`, `--email`, `--city`, `--status`, `--top N`, `--root <dir>`.

Alternative paths if you don't have Claude Code:
- `ANTHROPIC_API_KEY=… apply-new generate` automates the narrative via the Claude API.
- Manual: `prepare` → write `narrative.json` by hand → `finalize`.

## How we build the cognitive profile

We didn't want to build "AI judges humans". The profile is a **portrait, not a grade** — useful for the candidate (to see how they actually work) as much as for whoever reads it (to start a real conversation).

### What we measure, and how

**Project types** — descriptive tags computed from the files you actually touched:

| Tag | When it appears |
|---|---|
| `product-build` | sustained work on a single product (>200 mutations over >14 days) |
| `audit-research` | heavy on reading and analysis, light on changes (Research:Mutation > 10) |
| `agent-tooling` | skill/command/hook files for AI agents |
| `data-migration` | schema, SQL, or migration files involved |
| `static-site` | HTML-heavy mutations |
| `ai-platform` | API routes for chat/agent/connectors |
| `feature-work`, `testing`, `quality-gating`, `orchestrated`, `design-research` | self-explanatory |

**Cognitive tags** — derived from thresholds on objective signals in your logs:

| Tag | Threshold |
|---|---|
| `research-first` | average Research:Mutation ratio above 2 |
| `decomposer` | median prompt length ≥ 25 words |
| `orchestrator` | Task/Agent delegations total ≥ 15 |
| `verification-heavy` | checks (tsc/eslint/test/build) run in at least half the projects |
| `risk-calibrated` | revert/commit ratio < 10% on 20+ commits |

These are descriptors, not grades. There's no "better" cognitive tag — they're meant to **start a conversation**, not to compare you to anyone else.

**Cognitive narrative** — 4–6 sentences written by *your* Claude instance, constrained on six dimensions: **decomposition · verification · error handling · orchestration · risk · calibrated trust in AI**. Hard rules in the prompt: no proper names, evidence-based only, no hyperbole.

**Groundedness check** — before submission we run a small deterministic check on the prose fields (`summary`, `cognitive narrative`, `trajectory narrative`, per-project `did`, `why representative`, `domain`, `principles adopted`). For every verifiable anchor in the prose — a number, a technology name, a type tag, a year-month — we check that it exists in the structured data the prose was generated from. The score is the percentage of anchors with a match (`92%` = "9 anchors in 10 trace back to your logs"). If the score is below 60% the submission is blocked; you can re-generate the profile or pass `--force` if you have a reason. Visible to you locally before submit, and stored next to the profile so Play New can see it too.

**Trajectory** — what changed strategically/culturally over the window, from four sources:
- **Behavioral shifts**: same four metrics (decomposition, delegation, research:mutation, verification) measured on the early vs late half of the window. When they move, there's an apprenticeship.
- **Topic clusters**: web queries grouped by theme (agent architecture, design, data, AI patterns, …) and ordered by quarter. The cultural reading list.
- **New vocabulary**: words that appear only in the late half and recur across multiple distinct prompts. One-offs are filtered out.
- **Principles codified**: lines the candidate added to their own CLAUDE.md / README over time — the rules they wrote for their future self and their agent.

The reference we leaned on (the only one): [claude-session-analyzer](https://github.com/lucemia/claude-session-analyzer) by lucemia, for the Research:Mutation idea and the thinking-signature length as a depth proxy.

### What this is not

- **Not a personality test.** No Big Five, no MBTI, no DISC. Logs are not psychology.
- **Not automatic scoring or ranking.** No "fit score", no leaderboard. A human reads each profile.
- **Not a performance prediction.** Past patterns don't determine future outcomes.
- **Not a comparison between candidates.** Each profile stands on its own.

### What this does not replace

A profile is a starting point. It does not replace:

- **A real conversation.** A 30-minute interview tells you more than any log can.
- **A real meeting.** Humans deciding about humans.

### Limits, owned

- **Sample bias.** You decide which projects we see. The tool can't tell what's missing.
- **Tool bias.** Solo-work logs mostly show execution. Leadership, mentoring, pair-working with humans — invisible here.
- **Threshold bias.** Our cutoffs are empirical, not validated against a large population. We will refine them as more applications come in.
- **LLM bias.** The narrative is written by a model that has its own patterns. The prompt constrains it but does not make it neutral.

If you spot a way to make this less biased, less grade-shaped, more useful: [open an issue](https://github.com/Play-New/apply-new/issues). We'd rather get this right than ship something clever.

## Tests

```
npm test
```

## License

MIT. See [LICENSE](LICENSE).

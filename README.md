# apply-new

**A new way to apply for a job at Play New.**

We don't read CVs. A CV tells us what you did; we want to see *how* you think. If you work with AI tools every day, the way you reason, decompose, verify, and recover from mistakes is already written down — it's sitting in your Claude Code logs. This tool turns those logs into a short, anonymized work profile, and lets you decide what to do with it.

Two things matter:

- **Your data stays yours.** Everything runs on your laptop. Names of clients, products, people are stripped out. You see the profile before anyone else does, and you can keep it just for yourself.
- **You write it, your AI helps.** The qualitative parts use *your* Claude Code subscription — no API key, no extra cost. The profile sounds like you.

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

## Tests

```
npm test
```

## License

MIT. See [LICENSE](LICENSE).

# apply-new

Agentic job application for Play New. No CV: your Claude Code logs tell how you work, the tool reads them locally, anonymizes everything (clients, people, products, secrets) except your declared contact fields, and produces a profile that's readable by both a human and an agent.

**Save by default.** The profile stays on your machine until *you* decide to submit. You can also generate it just for yourself.

## Requirements

Claude Code installed and your Claude subscription (Pro, Max, or Enterprise). No API key.

## How to use

```
git clone https://github.com/playnew/apply-new
cd apply-new
claude                        # open Claude Code in this folder
> /apply-new                  # the slash command walks you through it
```

The slash command:
1. asks for your contact fields (name, email, city, status: `freelance` / `employed` / `student` / `looking`)
2. runs the deterministic pipeline (parse + redact + fingerprint + consistency screen)
3. uses your own subscription to write the qualitative parts (summary, cognitive profile, per project)
4. shows you `profile.md`, helps you adjust the representative projects and attach optional artifacts
5. tells you how to submit when you're ready — submission is a separate step

Output: `profile.md` (for humans) and `candidate.json` (for agents, schema `playnew-profile/v1`).

## Submit (separate, when you want)

```
apply-new submit --yes
```

Shows you what's about to be sent, requires `--yes` to confirm, and POSTs to `PLAYNEW_INTAKE_URL`. Custom endpoint: `--endpoint https://...`.

## Commands

| Command | What it does |
|---|---|
| `apply-new generate` (default) | full profile, locally |
| `apply-new prepare` | only writes `narrative-input.json` (so you can write the narrative manually) |
| `apply-new finalize --narrative-file narrative.json` | finalize after `prepare` |
| `apply-new submit --yes` | submit to Play New (explicit action) |

Common flags: `--name`, `--email`, `--city`, `--status`, `--top N`, `--root <dir>`.

## What it collects

- **Declared contact**: name, email, city, status.
- **Volume**: number of sessions, products, time window, models used.
- **Per product**: abstract domain, work type (product-build, audit, agent-tooling, data-migration, ...), detected stack, landing signals (commits/reverts/checks), anonymized code areas.
- **Cognitive profile**: how you decompose, delegate, verify.
- **What you've learned**: stack adopted, topics researched.
- **Log consistency screen** (not a proof of authenticity).

## What it does NOT collect

- Names of companies, clients, people, products, brands, or repositories.
- Code. Ever. Only logs + repo self-description (`package.json`, `CLAUDE.md`/`README`) for local generation.

## Alternative paths

- `ANTHROPIC_API_KEY=… apply-new generate` — automate via API.
- Manual: `prepare` → write `narrative.json` → `finalize`.

## Play New side (intake)

The intake endpoint and the candidates dashboard live in `play-new-dashboard`:
- `supabase/migrations/138_applications.sql` — table + artifacts bucket + RLS
- `src/app/api/apply/route.ts` — `POST /api/apply`, validates the v1 schema, writes to DB, stores artifacts
- `src/app/(authenticated)/applications/` — list + detail UI

## Tests

```
npm test
```

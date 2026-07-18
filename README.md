# Apply New

> `apply-new`: apply to Play New by showing how you work.

A CV is a list of what you did, formatted for keyword scans. For work that happens inside agent logs, it's the wrong surface. The signal we care about (how you decompose, how you verify, what you do when the model misunderstands) already exists in your agent sessions, whichever CLI they happen to live in. A resume can't see it.

Apply New makes it visible. You run it on your laptop, you see the profile before anyone else does, and you decide whether to share it. There's no scoring or ranking. The profile describes how you work, and it opens a conversation.

## You'll need

Node 20 or newer, Claude Code installed, and a Claude subscription (Pro, Max, or Enterprise). No API key.

## How it goes

```
git clone https://github.com/Play-New/apply-new
cd apply-new
claude
> /apply-new
```

The slash command asks for four contact fields (name, email, city, status), reads your Claude Code history, and lets your own Claude write a short profile about you. Two files come out in `out/`: `profile.md` for humans, `candidate.json` for agents. Submission is a second step. You can keep the profile for yourself.

```
node bin/apply-new.mjs submit --yes
```

## Sources

The tool reads every supported agent CLI it finds on your machine and folds them into one profile. Each source is disclosed in the profile's `sources` block with its capture level: *full* means tamper-evident records the authenticity screen can verify, *structural* means well-formed data without a verification story.

| | Reads from | Skip with | Capture |
|---|---|---|---|
| [![Claude Code](https://img.shields.io/badge/Claude_Code-555?logo=claudecode&logoColor=white)](https://claude.com/claude-code) | `~/.claude/projects` | always read (`--root` points it elsewhere) | full |
| [![opencode](https://img.shields.io/badge/opencode-555?logo=opencode&logoColor=white)](https://opencode.ai) | `~/.local/share/opencode` (sqlite; JSON fallback via `--opencode-json`) | `--no-opencode` | structural |
| [![Codex CLI](https://img.shields.io/badge/Codex_CLI-555)](https://github.com/openai/codex) | `~/.codex/sessions` | `--no-codex` | structural |
| [![pi](https://img.shields.io/badge/pi-555?logo=pi&logoColor=white)](https://pi.dev) | `~/.pi/agent/sessions` | `--no-pi` | structural |
| [![cursor-agent](https://img.shields.io/badge/cursor--agent-555?logo=cursor&logoColor=white)](https://cursor.com/cli) | `~/.cursor/chats` (sqlite; needs Node 22.5+, otherwise read as empty and disclosed) | `--no-cursor` | structural |
| ![kimi-code](https://img.shields.io/badge/kimi--code-555?logo=moonshotai&logoColor=white) | `~/.kimi-code/sessions` | `--no-kimi` | structural |

Every source normalizes into the same session model, so all six lenses below read them identically. Each `--<source>-root <dir>` flag overrides the default location. What never gets opened per source (credential files, config, telemetry) is enumerated in [PRIVACY.md](PRIVACY.md). Gemini CLI and ChatGPT / Claude.ai exports are on the roadmap.

## What we look at

Six lenses, all built from your logs.

**What you work on.** Three to five fields of work, derived from the evidence of every product in your logs (type of work, stack, code areas, research topics). Each domain carries a count of products and sessions, never a name: "talent operations, 8 products, 14 sessions".

**How you reason.** Cognitive tags derived from concrete signals: *research-first* if your read-to-edit ratio is above 2, *orchestrator* if you delegate to sub-agents 15+ times, *verification-heavy* if checks run in half your projects, *risk-calibrated* if your revert-to-commit ratio stays below 10%. A short paragraph from your Claude on decomposition, verification, error handling, calibrated trust.

**How you work with the model.** One continuous axis from *directing* (long structured prompts, file paths, acceptance criteria) to *co-thinking* (short conversational turns, open questions, the model as a partner). The midpoint is co-construction. Most people switch by context, and the narrative says when.

**How deeply Claude is your practice.** Active days over the observed window, median sessions per active day, session depth, longest streak, peak day. The difference between *daily driver, deep sessions* and *occasional, short bursts on specific tasks*.

**How you spread your work.** Sessions per product, concentration on your top products, products carried across months. Two sessions each across twenty products reads as portfolio steering; nine sessions each across nine products reads as sustained building. Both are legitimate shapes, and they match different projects.

**How fluent you are in the agentic stack.** Three axes: what you use (sub-agents, MCP servers, slash commands you invoke), what you build (skills, commands, hooks, the `CLAUDE.md` files you maintain), and how you organise work (planning, subtask tracking, clarifying before assuming). All counts. Custom MCP servers and custom skills are counted but never named (they can carry client information).

Plus a trajectory block (how your behavior shifted across the observed window), three to five representative projects (adaptive: flagships by significance, extra slots only for type diversity or comparable significance) — each carrying per-product orchestration counts: sessions per agent CLI (with overlapping vs disjoint activity periods), sub-agent delegations, and headless agent-dispatch commands (to the same tool or another; all lower bounds) — and a groundedness check (the prose has to track back to the data; below 60%, submission is blocked).

At submit time everything is re-checked, not trusted: groundedness is recomputed on the file as it is now, the structured numbers are re-derived from your logs (the profile can't claim more sessions or commits than the logs contain), and the intake recomputes groundedness and the structural invariants server-side on what it receives. An incoherent hand-edit of `candidate.json` doesn't survive the trip; the log-level re-derivation runs only on your machine, since your logs never leave it.

The profile also discloses its own coverage: a `sources` block records which log sources were read, at what capture level (*full* = tamper-evident records the authenticity screen can verify; *structural* = well-formed data without a verification story), and how many sessions each contributed. The window and every count are **lower bounds** of your real activity — logs rotate and old sessions are pruned, so what the tool can still see is never more than what you did. Like the authenticity score, this is a screen, not proof.

## What it isn't

It isn't a personality test, and the cognitive tags are descriptive: there's no "better" tag, only different patterns. The profile doesn't compare you with anyone else, and it doesn't predict performance.

It doesn't evaluate you, and nothing downstream does either. The only scores in the pipeline (authenticity, groundedness) measure the *report's* integrity — whether the logs are internally consistent and the prose tracks the data — never you. On our side, profiles reach humans unranked: nothing sorts, filters, or thresholds candidates on any profile field. A person reads the report and decides whether to invite you to a conversation. This is a recorded commitment ([ADR-001](docs/adr/001-just-a-report.md)), not marketing.

It doesn't replace a conversation, or a live task in our repo. The decision about humans stays with humans.

## What we collect, what we don't

We collect the four contact fields you typed, the profile JSON, and any artifact you explicitly chose to attach. We don't see client names, product names, person names, your code, or your raw logs. The redaction runs on your machine before anything leaves it.

Want it gone? Reach us via [playnew.com](https://playnew.com) and we delete your application and any attached artifacts. Locally, everything the tool generated lives in the `out/` folder — delete it and it's gone.

## Policy

Legal basis: explicit consent (GDPR Art. 6(1)(a)). You run `submit --yes` after seeing what's in the payload. Retention: while we're talking, or up to 12 months. Your rights (access, rectification, erasure, portability, objection) are exercised by writing to us via [playnew.com](https://playnew.com).

Under the EU AI Act (Regulation 2024/1689), systems that filter job applications and evaluate candidates are classified high-risk (Annex III §4(a)). We treat Apply New that way. Transparency: this README and the source on GitHub. Human oversight: no automated decision; a person reads each profile. Disclosure: you're interacting with an AI tool. Data governance: raw logs stay local, only a consented subset is transmitted, retention is declared. Full text in [PRIVACY.md](PRIVACY.md).

## Limits

You decide which projects we see, so the tool can't see what's missing. Logs of solo work mostly show execution, which means leadership, mentoring, and the work of being with humans is invisible from here. Our thresholds (read-to-edit above 2, ≥15 delegations) are empirical: we don't know yet how they hold across hundreds of candidates. The narrative is written by a model; the prompt constrains it, it doesn't make it neutral. We read each profile by hand, and we're still learning what to look for.

If you spot something we should change, [open an issue](https://github.com/Play-New/apply-new/issues).

## Commands

| | |
|---|---|
| `generate` *(default)* | full profile, locally |
| `prepare` | only `out/narrative-input.json`, for writing the narrative manually |
| `finalize --narrative-file out/narrative.json` | finalize after `prepare` |
| `submit --dry-run` | write the exact outgoing payload to `out/payload-preview.json`, send nothing |
| `submit --yes` | send to Play New |

All commands run as `node bin/apply-new.mjs <sub>` or as `apply-new <sub>` after `npm link`. Common flags: `--name`, `--email`, `--city`, `--status`, `--top N` (force the project count; default is adaptive 3–5), `--root <dir>`, the per-source roots and opt-outs from the Sources table above, `--tz <IANA zone>` (bucket the day-based counts — active days, streak — in your timezone instead of the UTC default; the zone you choose is recorded in the profile, which is also why UTC is the default: a zone names a place, and nothing location-shaped should leave your machine unless you opt in). Without Claude Code, set `ANTHROPIC_API_KEY` and the narrative goes through the API instead of your subscription — note that on this path the narrative input (project labels, README/CLAUDE.md excerpts, dependency names, commit subjects, sampled prompts) is sent to api.anthropic.com under your own key, before any name-stripping; the tool warns when this happens, and an explicit `--narrative-file` always takes precedence over the key. The subscription and manual paths stay fully local until submit. Details in [PRIVACY.md](PRIVACY.md).

## Tests

```
npm test
```

## Contributing

PRs and issues are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the rules
that make this repo unusual (schema discipline, privacy boundaries, the
[ADR-001](docs/adr/001-just-a-report.md) frame, the current six-source policy).
Security issues go privately via [SECURITY.md](SECURITY.md), never as public issues.

## License

MIT. See [LICENSE](LICENSE).

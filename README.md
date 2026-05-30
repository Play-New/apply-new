# Apply New

> `apply-new`: apply to Play New by showing how you work.

A CV is a list of what you did, formatted for keyword scans. For work that happens inside agent logs, it's the wrong surface. The signal we care about (how you decompose, how you verify, what you do when the model misunderstands) already exists in your Claude Code sessions. A resume can't see it.

Apply New makes it visible. You run it on your laptop, you see the profile before anyone else does, and you decide whether to share it. There's no scoring or ranking. The profile is a portrait, and a portrait opens a conversation.

## You'll need

Claude Code installed and a Claude subscription (Pro, Max, or Enterprise). No API key.

## How it goes

```
git clone https://github.com/Play-New/apply-new
cd apply-new
claude
> /apply-new
```

The slash command asks for four contact fields (name, email, city, status), reads your Claude Code history, and lets your own Claude write a short profile about you. Two files come out: `profile.md` for humans, `candidate.json` for agents. Submission is a second step. You can keep the profile for yourself.

```
node bin/apply-new.mjs submit --yes
```

> Today the tool reads Claude Code logs. Codex CLI, Gemini CLI, and ChatGPT / Claude.ai exports are on the roadmap.

## What we look at

Four lenses, all built from your logs.

**How you reason.** Cognitive tags derived from concrete signals: *research-first* if your read-to-edit ratio is above 2, *orchestrator* if you delegate to sub-agents 15+ times, *verification-heavy* if checks run in half your projects, *risk-calibrated* if your revert-to-commit ratio stays below 10%. A short paragraph from your Claude on decomposition, verification, error handling, calibrated trust.

**How you work with the model.** One continuous axis from *directing* (long structured prompts, file paths, acceptance criteria) to *co-thinking* (short conversational turns, open questions, the model as a partner). The midpoint is co-construction. Most people switch by context, and the narrative says when.

**How deeply Claude is your practice.** Active days over the observed window, median sessions per active day, session depth, longest streak, peak day. The difference between *daily driver, deep sessions* and *occasional, short bursts on specific tasks*.

**How fluent you are in the agentic stack.** Three axes: what you use (sub-agents, MCP servers, slash commands you invoke), what you build (skills, commands, hooks, the `CLAUDE.md` files you maintain), and how you organise work (planning, subtask tracking, clarifying before assuming). All counts. Custom MCP servers and custom skills are counted but never named (they can carry client information).

Plus a trajectory block (how your behavior shifted across the observed window) and a groundedness check (the prose has to track back to the data; below 60%, submission is blocked).

## What it isn't

It isn't a personality test, and the cognitive tags are descriptive: there's no "better" tag, only different patterns. The profile doesn't compare you with anyone else, and it doesn't predict performance.

It doesn't replace a conversation, or a live task in our repo. The decision about humans stays with humans.

## What we collect, what we don't

We collect the four contact fields you typed, the profile JSON, and any artifact you explicitly chose to attach. We don't see client names, product names, person names, your code, or your raw logs. The redaction runs on your machine before anything leaves it.

Want it gone? Reach us via [playnew.com](https://playnew.com) and we delete your application and any attached artifacts. Locally, `profile.md` and `candidate.json` are plain files you can remove yourself.

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
| `prepare` | only `narrative-input.json`, for writing the narrative manually |
| `finalize --narrative-file narrative.json` | finalize after `prepare` |
| `submit --yes` | send to Play New |

All commands run as `node bin/apply-new.mjs <sub>` or as `apply-new <sub>` after `npm link`. Common flags: `--name`, `--email`, `--city`, `--status`, `--top N`, `--root <dir>`. Without Claude Code, set `ANTHROPIC_API_KEY` and the narrative goes through the API instead of your subscription.

## Tests

```
npm test
```

## License

MIT. See [LICENSE](LICENSE).

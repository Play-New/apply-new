# Privacy & policy — Apply New

Last updated: 2026-07-01

Apply New is a tool that turns your Claude Code logs into an anonymised work profile, submitted as a job application to Play New (a business unit of Cosmico Srl). It is a report — a photograph of how you work with AI — not a score, a ranking, or an automated decision about you: a person reads it and decides whether to start a conversation ([ADR-001](docs/adr/001-just-a-report.md)).

This document explains what we do with the data you choose to send.

---

## 1. Who we are

**Data controller:** Cosmico Srl — Play New
Viale Pasubio 5, 20154 Milano, Italy · VAT IT 11186440969
Contact: [playnew.com](https://playnew.com)

## 2. What we collect, with your consent

When you run `apply-new submit --yes`, the following is transmitted:

- **Contact fields you typed:** first name, email, city, status (`freelance` / `employed` / `student` / `looking`).
- **A `playnew-profile/v1` JSON** containing: time window, session and product counts, a sources block (which log sources were read, their capture level and session counts — no paths or machine identifiers), per representative project (abstract domain description, type tags, technology stack, signals like commits/reverts/checks, and orchestration counts — how many sessions each agent CLI contributed to the product, whether their activity periods overlapped, sub-agent delegation counts, and how many shell commands dispatched work to an agent CLI headless (the same tool or another); tool names and counts only, never the commands themselves), cognitive tags (e.g. *research-first*), a short narrative written by your own Claude instance, a learning trajectory block (behavioral shifts, topic clusters, vocabulary adopted, principles codified), an AI-relationship axis (*directing* ↔ *co-thinking* split), an agentic-literacy block (counts of how you use / build / design with the agentic stack — never names), a practice-intensity block (how deeply Claude is embedded in your daily workflow — including the timezone the day counts are bucketed in, which is `UTC` unless you pass `--tz`), and a list of other projects in inventory.
- **Opt-in artifacts** you explicitly attach (a deploy URL, a repo URL, a PR link, a screenshot — your choice, never required).

What we **never** collect: client names, product names, person names, repository names, your code, your raw logs. Framework-injected text in the logs — tool reminders, instruction dumps, attached-file wrappers — is filtered out before anything is counted or sampled, and is never treated as your own words.

The narrative is written under hard constraints: no proper names, evidence-based only, no hyperbole. A pre-submit *groundedness check* verifies that the prose anchors (numbers, technology names, type tags, year-months) trace back to the structured data.

**Sources we read locally.** Apply New reads your Claude Code logs (`~/.claude/projects`) and, when present, your [opencode](https://github.com/sst/opencode) logs (its `~/.local/share/opencode/opencode.db`, or the JSON cache under `…/storage` with `--opencode-json`; skip opencode entirely with `--no-opencode`), your [Codex CLI](https://github.com/openai/codex) logs (`~/.codex/sessions/**/*.jsonl` only — `auth.json`, `config.toml`, `history.jsonl`, and any sqlite files under `~/.codex` are never opened; skip codex entirely with `--no-codex`), your [pi](https://pi.dev) logs (`~/.pi/agent/sessions/**/*.jsonl` only — `auth.json`, `settings.json`, `models.json`/`models-store.json`, and `trust.json` are never opened; skip pi entirely with `--no-pi`), your [cursor-agent](https://cursor.com) logs (`~/.cursor/chats/**/store.db` only — each per-session database is copied and opened read-only; `prompt_history.json`, `cli-config.json`, `projects/`, and macOS Keychain are never opened; skip cursor entirely with `--no-cursor`), and your kimi-code logs (`~/.kimi-code/sessions/**/wire.jsonl` plus each session's own `state.json` only — `config.toml`, `device_id`, `credentials/`, `telemetry/`, `user-history/`, and `session_index.jsonl` are never opened; skip kimi entirely with `--no-kimi`). All six are read on your machine and reduced to the same redacted, counts-based subset described above. From opencode specifically we keep only what the Claude Code path keeps: tool **outputs** and assistant **error** payloads are dropped (we retain a byte count, never the text), reasoning is reduced to a character count, and file paths and shell commands are passed through the same PII redaction. From codex specifically, the same posture holds: tool output, reasoning text, and `apply_patch` diff bodies are never stored — only character/byte counts survive. From pi specifically, the same posture holds too: tool output, reasoning text, and thinking-signature bytes are never stored, and a local model's filesystem-path model id (which can carry your OS username, including dash-encoded path forms and bare mentions of the local account name) is redacted before it is ever kept. From cursor-agent specifically, the same posture holds too: tool outputs (Write's file contents, an edit's old/new text, a tool-result body) and the model-generated conversation title are never stored — only paths, truncated commands/queries, and byte counts survive; reasoning text is reduced to a character count and its signature to a length; cursor keeps no per-message token usage anywhere in its local storage, so none is read. From kimi-code specifically, the same posture holds too: thinking text, tool outputs, and `config.update`'s system prompt are never stored — only lengths and byte counts survive — and `state.json`'s `title`/`lastPrompt` fields (confirmed verbatim prompt text) are parsed only to read `workDir` and never kept. The same "counts, not names" rule applies to every source.

## 2a. The narrative step: three paths, one caveat

The short prose in your profile is generated in one of three ways, and they differ in what leaves your machine **before** submit:

- **Subscription path (default, recommended):** the `/apply-new` slash command runs inside your own Claude Code session. The narrative input never goes anywhere your ordinary Claude usage doesn't already go. Fully local until submit.
- **Manual path:** `prepare` writes the narrative input to a local file; you hand-write `narrative.json` and run `finalize`. Nothing leaves your machine until submit. An explicit `--narrative-file` always takes precedence over an API key in your environment.
- **API path:** if `ANTHROPIC_API_KEY` is set and no narrative file is given, the narrative input — the real labels of your selected projects, a README/CLAUDE.md excerpt (up to 1,200 characters), up to 60 dependency names, 20 commit subjects, and sampled prompts (PII-redacted, but not name-stripped) — is sent to **api.anthropic.com** under *your own* key. Play New never sees this exchange; it is between you and Anthropic, governed by Anthropic's API terms. But it does leave your machine before submit, so the tool prints a warning when this path engages. If you work under NDA or prefer everything local, use the subscription or manual path.

The name-stripping described in section 2 (no repository names, no client names in what *we* receive) applies to what is transmitted to Play New at submit; it cannot retroactively apply to what you choose to send to Anthropic via your own key.

## 3. Why we collect it (purpose)

To **match you to the right project** at Play New. Concretely:
- See how you work with AI (decomposition, verification, orchestration).
- Compare your skills and stack against open projects.
- Decide — a person reading the report, never the tool — whether to invite you to a conversation.

We **do not**:
- Train AI models on your data.
- Share your data with anyone outside Play New.
- Include your data in dashboards visible to clients.
- Use your data to make automated decisions about you.

## 4. Legal basis

**Explicit consent** (GDPR Art. 6(1)(a)). You run `apply-new submit --yes` after seeing exactly what is being sent. You can inspect the exact payload before consenting: `apply-new submit --dry-run` writes it to `out/payload-preview.json` — repository names already stripped — and sends nothing. You can withdraw consent at any time by reaching us via [playnew.com](https://playnew.com).

## 5. How long we keep it (retention)

We keep an application while there is **active interest** or for **up to 12 months** from submission, whichever ends first. After that we delete the row and any attached artifacts.

You can ask for **earlier deletion** at any time.

## 6. Your rights (GDPR)

You have the right to:
- **Access** the data we hold about you. Your `candidate.json` already is a copy.
- **Rectification** — fix anything inaccurate. Easiest: re-generate locally and submit again, then ask us to delete the previous one.
- **Erasure** — be deleted. Reach us via [playnew.com](https://playnew.com).
- **Portability** — receive the data in machine-readable form. Again, `candidate.json`.
- **Objection / restriction** — pause processing.
- **Lodge a complaint** with the [Garante per la protezione dei dati personali](https://www.garanteprivacy.it/) (the Italian DPA).

## 7. AI Act notice

Under EU Regulation 2024/1689 (the AI Act), Annex III §4(a), AI systems used to "analyse and filter job applications and evaluate candidates" are classified as **high-risk**. Apply New is treated as such. The obligations we take on:

- **Transparency.** This file and the [README](README.md) describe in plain terms what the tool measures, how the tags are derived, and what the model is asked to do — including the agentic-literacy counts (built-in vs custom, with custom names never exposed), the AI-relationship axis, the trajectory shifts, the per-product orchestration counts (per-CLI session split, agent-dispatch and delegation counts), and the practice-intensity signals. The source code is public on GitHub.
- **Human oversight.** No automated decision is made about you. A person at Play New reads each profile and decides whether to follow up. The AI generates the profile and computes screening metrics; it does not rank, score against others, or filter candidates. The bright line, recorded in [ADR-001](docs/adr/001-just-a-report.md): AI may score the *artifact* — the authenticity and groundedness scores measure whether your logs are internally consistent and whether the prose tracks the data — never you. On our side, profiles are stored and presented to humans unranked: no sorting, filtering, or thresholding on any profile-derived field.
- **Disclosure.** You are interacting with an AI tool. The narrative parts of your profile (summary, cognitive narrative, trajectory narrative, per-project descriptions) are model-generated.
- **Data governance.** Raw logs stay on your machine. Only a redacted, consented subset is transmitted, with declared retention. Storage is in the EU.
- **Logging.** We keep server-side logs of API requests (timestamps, status codes) for security and debugging, separate from the application data.
- **Robustness & accuracy.** The deterministic parts (tags, metrics, groundedness check) are open-source and inspectable. The narrative is constrained by a documented prompt. The groundedness check blocks submissions where the prose drifts from the data below a threshold.

## 8. Security

- Transmission over HTTPS.
- Storage in Supabase (EU region), row-level security enabled.
- Service role keys are server-side only.
- Artifacts in a private bucket; only authenticated team members can access.

## 9. A fully manual alternative

If you prefer not to use the tool — for any reason, including unease about the AI generation — reach us via [playnew.com](https://playnew.com). We will arrange a no-tool conversation. You do not lose anything by not using Apply New.

## 10. Changes

We will update this document if we change what the tool does. The previous versions stay in the [git history](https://github.com/Play-New/apply-new/commits/main/PRIVACY.md).

---

*If anything here is unclear or you spot a mistake, please [open an issue](https://github.com/Play-New/apply-new/issues) or reach us via [playnew.com](https://playnew.com).*

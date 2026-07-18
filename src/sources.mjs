// Source resolution: which log sources get read for a run, and where they
// come from. Shared by `apply-new generate` (the producer) and `apply-new
// submit` (which re-derives ground truth from the same logs).
//
// Sources can be combined:
//   - claude-code: ~/.claude/projects, always read
//   - opencode:    ~/.local/share/opencode/{storage,opencode.db}, opt-out
//   - codex:       ~/.codex/sessions, opt-out
//   - pi:          ~/.pi/agent/sessions, opt-out
//   - cursor:      ~/.cursor/chats, opt-out (readCursor returns an EMPTY
//                  bundle with stats.backend: null on Node < 22.5 — no
//                  node:sqlite — so it just contributes zero sessions there)
//
// Both opencode backends (sqlite and JSON) live in src/adapters/opencode.mjs;
// this file just decides *whether* to read each source at all and *which*
// backend, keyed by source name so future adapters slot in as another
// `sources.<name>` block below without touching the others.

import { readClaudeCode } from "./adapters/claude-code.mjs";
import { readOpencode, readOpencodeJson, defaultOpencodeRoot, mergeSources } from "./adapters/opencode.mjs";
import { readCodex, defaultCodexRoot } from "./adapters/codex.mjs";
import { readPi, defaultPiRoot } from "./adapters/pi.mjs";
import { readCursor, defaultCursorRoot } from "./adapters/cursor.mjs";

export function readAllSources({ claudeRoot, sources }) {
  const bundles = [readClaudeCode(claudeRoot)];

  const oc = sources?.opencode ?? {};
  if (!oc.disabled) {
    // `flag("opencode-root")` returns null when the flag is absent, so we
    // can't rely on a default parameter alone. Fall back to
    // defaultOpencodeRoot() when oc.root is null OR undefined.
    const root = oc.root ?? defaultOpencodeRoot();
    const parsed = oc.json ? readOpencodeJson(root) : readOpencode(root);
    if (parsed.sessions.length) bundles.push(parsed);
  }

  const cx = sources?.codex ?? {};
  if (!cx.disabled) {
    const root = cx.root ?? defaultCodexRoot();
    const parsed = readCodex(root);
    if (parsed.sessions.length) bundles.push(parsed);
  }

  const pi = sources?.pi ?? {};
  if (!pi.disabled) {
    const root = pi.root ?? defaultPiRoot();
    const parsed = readPi(root);
    if (parsed.sessions.length) bundles.push(parsed);
  }

  const cu = sources?.cursor ?? {};
  if (!cu.disabled) {
    const root = cu.root ?? defaultCursorRoot();
    const parsed = readCursor(root);
    if (parsed.sessions.length) bundles.push(parsed);
  }

  return bundles.length > 1 ? mergeSources(...bundles) : bundles[0];
}
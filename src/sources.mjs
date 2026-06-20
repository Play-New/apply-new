// Source resolution: which log sources get read for a run, and where they
// come from. Shared by `apply-new generate` (the producer) and `apply-new
// submit` (which re-derives ground truth from the same logs).
//
// Two sources can be combined:
//   - claude-code: ~/.claude/projects, always read
//   - opencode:    ~/.local/share/opencode/{storage,opencode.db}, opt-in
//
// Both backends (sqlite and JSON) live in src/adapters/opencode.mjs; this
// file just decides *whether* to read opencode at all and *which* backend.

import { readClaudeCode } from "./adapters/claude-code.mjs";
import { readOpencode, readOpencodeJson, defaultOpencodeRoot, mergeSources } from "./adapters/opencode.mjs";

export function readAllSources({ claudeRoot, ocRoot, noOpencode, opencodeJson }) {
  // `flag("opencode-root")` returns null when the flag is absent, so we can't
  // rely on a default parameter alone. Fall back to defaultOpencodeRoot()
  // when ocRoot is null OR undefined.
  const finalOcRoot = ocRoot ?? defaultOpencodeRoot();
  const claude = readClaudeCode(claudeRoot);
  if (noOpencode) return claude;
  const oc = opencodeJson ? readOpencodeJson(finalOcRoot) : readOpencode(finalOcRoot);
  if (!oc.sessions.length) return claude;
  return mergeSources(claude, oc);
}
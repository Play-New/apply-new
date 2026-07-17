// Deterministic, structural PII redaction.
//
// This layer handles the PII that has a *shape* (paths, emails, secrets, IPs).
// Named entities (people, companies, product names) have no reliable shape and
// are left to the LLM pass — see profile.mjs. Structural fields used by the
// forensics (timestamps, uuids, token usage) are NEVER passed through here;
// only human-readable text is redacted. This structural layer also scrubs the
// local account name, because logs quote it both in dash-encoded paths and in
// plain prose.

import os from "node:os";
import { basename } from "node:path";

const RULES = [
  // Secrets first, before anything else can partially mask them.
  { re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, to: "⟨anthropic-key⟩" },
  { re: /\bsk-[A-Za-z0-9]{20,}/g, to: "⟨api-key⟩" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, to: "⟨gh-token⟩" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, to: "⟨gh-token⟩" },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, to: "⟨aws-key⟩" },
  { re: /\bAIza[0-9A-Za-z_-]{20,}\b/g, to: "⟨google-key⟩" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, to: "⟨slack-token⟩" },
  { re: /\bBearer\s+[A-Za-z0-9._-]{12,}/g, to: "Bearer ⟨token⟩" },
  // NAME=secret style env assignments: keep the variable name, drop the value.
  {
    re: /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL|API)[A-Z0-9_]*)(\s*[=:]\s*)["']?([^"'\s]{6,})/g,
    to: (_m, name, sep) => `${name}${sep}⟨secret⟩`,
  },
  // Emails.
  { re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, to: "⟨email⟩" },
  // Home-directory usernames, unix + windows. Keep the path shape, drop the user.
  { re: /\/(Users|home)\/([^/\s"':]+)/g, to: "/$1/⟨user⟩" },
  { re: /([A-Za-z]:\\Users\\)([^\\/\s"':]+)/g, to: "$1⟨user⟩" },
  // Dash-encoded home paths (Claude Code encodes project/scratchpad dirs this
  // way, e.g. /private/tmp/claude-501/-Users-<name>-Projects-...). The leading
  // dash is the encoded-path marker; a rare false positive like "my-home-made"
  // becoming "my-home-⟨user⟩" is accepted over-redaction.
  { re: /-(Users|home)-([^-\s"':]+)/g, to: "-$1-⟨user⟩" },
  // IPv4 (4 octets — won't catch semver's 3).
  { re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, to: "⟨ip⟩" },
];

// Bare mentions of the local account name have no structural shape, but the
// machine knows its own username — so we build literal rules for it at module
// init. Names under 4 chars are skipped: short/common names (e.g. "al", "cj")
// are too likely to clobber ordinary words, so over-redaction risk outweighs
// the privacy gain. These rules are appended AFTER the path rules above, so
// the path rules get first crack and keep their shaped ⟨user⟩ output.
function localAccountNames() {
  const names = new Set();
  try {
    const u = os.userInfo().username;
    if (u) names.add(u);
  } catch {
    // no-op: redaction must never throw at import.
  }
  try {
    const h = basename(os.homedir());
    if (h) names.add(h);
  } catch {
    // no-op: redaction must never throw at import.
  }
  return [...names].filter((n) => n.length >= 4);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

for (const name of localAccountNames()) {
  RULES.push({ re: new RegExp(escapeRegExp(name), "gi"), to: "⟨user⟩" });
}

/** Redact a single string. Returns the redacted string. */
export function redactText(input) {
  if (typeof input !== "string" || input.length === 0) return input;
  let out = input;
  for (const { re, to } of RULES) out = out.replace(re, to);
  return out;
}

/** Count how many redactions a string would trigger (for the redaction-rate signal). */
export function countRedactions(input) {
  if (typeof input !== "string" || input.length === 0) return 0;
  // Count progressively, mirroring redactText: rules can overlap (e.g. the
  // literal account-name rule vs. the path rules), so counting each rule
  // against the original input would double-count what redactText only
  // substitutes once.
  let out = input;
  let n = 0;
  for (const { re, to } of RULES) {
    const m = out.match(re);
    if (m) n += m.length;
    out = out.replace(re, to);
  }
  return n;
}

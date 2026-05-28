// Deterministic, structural PII redaction.
//
// This layer handles the PII that has a *shape* (paths, emails, secrets, IPs).
// Named entities (people, companies, product names) have no reliable shape and
// are left to the LLM pass — see profile.mjs. Structural fields used by the
// forensics (timestamps, uuids, token usage) are NEVER passed through here;
// only human-readable text is redacted.

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
  // IPv4 (4 octets — won't catch semver's 3).
  { re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, to: "⟨ip⟩" },
];

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
  let n = 0;
  for (const { re } of RULES) {
    const m = input.match(re);
    if (m) n += m.length;
  }
  return n;
}

// Contact fields the candidate declares explicitly.
//
// Logs say HOW they work, not who to write to or whether they're available.
// These four fields are the minimum to (a) reply by email, (b) judge logistic
// fit (city, status). No surname in v1 — less PII, identity protected until
// the interview.

export const STATUSES = ["freelance", "employed", "student", "looking"];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function buildContact({ name, email, city, status }) {
  const errs = [];
  const norm = {
    name: (name || "").trim() || null,
    email: (email || "").trim().toLowerCase() || null,
    city: (city || "").trim() || null,
    status: (status || "").trim().toLowerCase() || null,
  };
  if (!norm.name) errs.push('name missing (--name "Giulia" or git config user.name)');
  if (!norm.email) errs.push("email missing (--email giulia@example.com)");
  else if (!EMAIL_RE.test(norm.email)) errs.push(`invalid email: ${norm.email}`);
  if (!norm.city) errs.push("city missing (--city Milano)");
  if (!norm.status) errs.push(`status missing (--status ${STATUSES.join("|")})`);
  else if (!STATUSES.includes(norm.status)) errs.push(`invalid status: ${norm.status} (expected: ${STATUSES.join("|")})`);
  return { contact: norm, errors: errs };
}

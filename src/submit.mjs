// Submission to the Play New intake endpoint.
//
// The candidate generates the profile FIRST (saved locally), then submits as a
// second, explicit step. We post candidate.json plus any artifact files the
// candidate has attached. The endpoint URL is configurable so this works
// against staging/prod/local without recompiling.

import { readFileSync, existsSync } from "node:fs";
import { basename } from "node:path";

// Play New intake lives inside the play-new-dashboard at /api/apply on the
// canonical host. Override via PLAYNEW_INTAKE_URL or --endpoint for staging/local.
const DEFAULT_ENDPOINT = "https://intelligence.playnew.com/api/apply";

export async function submitProfile(profilePath, { endpoint } = {}) {
  if (!existsSync(profilePath)) throw new Error(`profile not found: ${profilePath}`);
  const profile = JSON.parse(readFileSync(profilePath, "utf8"));
  if (profile.schema !== "playnew-profile/v1") throw new Error(`expected schema playnew-profile/v1, got ${profile.schema}`);
  if (!profile.contact?.email) throw new Error("missing contact.email: regenerate the profile with all fields");
  // Strip repoLabel from every project before sending. The label is the
  // candidate's own directory name and is meant ONLY to help them recognise
  // their projects locally during curation — it must not reach Play New.
  stripRepoLabels(profile);

  const url = endpoint || process.env.PLAYNEW_INTAKE_URL || DEFAULT_ENDPOINT;
  const form = new FormData();
  form.append("profile", new Blob([JSON.stringify(profile)], { type: "application/json" }), "candidate.json");

  for (const p of profile.projects || []) {
    const a = p.artifact;
    if (a?.type === "file" && a.path && existsSync(a.path)) {
      const bytes = readFileSync(a.path);
      form.append(`artifact_${p.id}`, new Blob([bytes]), basename(a.path));
    }
  }

  const res = await fetch(url, { method: "POST", body: form });
  if (!res.ok) throw new Error(`submit failed ${res.status}: ${await res.text()}`);
  return await res.json().catch(() => ({ status: "ok" }));
}

function stripRepoLabels(profile) {
  for (const p of profile.projects ?? []) delete p.repoLabel;
  for (const o of profile.otherProjects ?? []) delete o.repoLabel;
}

// Defect-to-test: stripRepoLabels ran invisibly inside submitProfile right
// before the POST — a candidate under NDA had no way to see the exact bytes
// leaving the machine, and the pre-submit preview never mentioned the strip.
// buildPayload is the one pure step both the POST and `submit --dry-run`
// share: what the candidate inspects IS what is sent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPayload } from "../src/submit.mjs";

const profile = () => ({
  schema: "playnew-profile/v1",
  contact: { name: "X", email: "x@y.z", city: "C", status: "freelance" },
  volume: { products: 2, sessions: 8, instructions: 30 },
  projects: [{ id: "p1", repoLabel: "acme-storefront", sessions: 5, landing: {} }],
  otherProjects: [{ repoLabel: "acme-experiments", sessions: 3 }],
});

test("buildPayload strips repoLabel from representative AND inventory projects", () => {
  const payload = buildPayload(profile());
  assert.ok(!("repoLabel" in payload.projects[0]));
  assert.ok(!("repoLabel" in payload.otherProjects[0]));
  assert.ok(!JSON.stringify(payload).includes("repoLabel"));
});

test("buildPayload does not mutate its input", () => {
  const input = profile();
  buildPayload(input);
  assert.equal(input.projects[0].repoLabel, "acme-storefront");
  assert.equal(input.otherProjects[0].repoLabel, "acme-experiments");
});

test("buildPayload validates schema and contact email with the original messages", () => {
  assert.throws(() => buildPayload({ ...profile(), schema: "wrong/v0" }), /expected schema playnew-profile\/v1/);
  const noEmail = profile();
  noEmail.contact = { name: "X" };
  assert.throws(() => buildPayload(noEmail), /missing contact\.email/);
});

test("everything except repoLabel survives byte-identical", () => {
  const input = profile();
  const payload = buildPayload(input);
  const expected = JSON.parse(JSON.stringify(input));
  delete expected.projects[0].repoLabel;
  delete expected.otherProjects[0].repoLabel;
  assert.deepEqual(payload, expected);
});

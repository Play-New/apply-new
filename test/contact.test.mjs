import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContact, STATUSES } from "../src/contact.mjs";

test("complete and valid input produces a clean contact", () => {
  const { contact, errors } = buildContact({ name: "Giulia", email: "G@ACME.IO", city: " Milano ", status: "freelance" });
  assert.deepEqual(errors, []);
  assert.deepEqual(contact, { name: "Giulia", email: "g@acme.io", city: "Milano", status: "freelance" });
});

test("missing required fields produce one error each", () => {
  const { errors } = buildContact({});
  assert.equal(errors.length, 4);
});

test("invalid email is rejected", () => {
  const { errors } = buildContact({ name: "x", email: "not-an-email", city: "Milano", status: "freelance" });
  assert.ok(errors.some((e) => /invalid email/i.test(e)));
});

test("status must be from the closed set", () => {
  const { errors } = buildContact({ name: "x", email: "x@y.io", city: "Milano", status: "ceo" });
  assert.ok(errors.some((e) => /invalid status/i.test(e)));
});

test("STATUSES export is what we promise", () => {
  assert.deepEqual(STATUSES, ["freelance", "employed", "student", "looking"]);
});

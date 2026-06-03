import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDistribution } from "../src/distribution.mjs";

const proj = (sessions, from = "2026-05", to = "2026-05") => ({ sessions, from, to });

test("returns null on empty or zero-session input", () => {
  assert.equal(computeDistribution([]), null);
  assert.equal(computeDistribution(null), null);
  assert.equal(computeDistribution([proj(0), proj(0)]), null);
});

test("portfolio: many products, few sessions each", () => {
  // 23 products, 44 sessions — the orchestrator pattern.
  const d = computeDistribution([proj(6), proj(3), proj(2), proj(2), ...Array.from({ length: 19 }, () => proj(1))]);
  assert.equal(d.products, 23);
  assert.ok(d.meanSessionsPerProduct <= 2.5, `mean ${d.meanSessionsPerProduct}`);
  assert.equal(d.shape, "portfolio");
});

test("deep focus: few products, returned to repeatedly", () => {
  // 9 products, 80 sessions — the sustained-builder pattern.
  const d = computeDistribution([proj(20, "2026-04", "2026-06"), proj(15, "2026-04", "2026-06"), proj(12), proj(10), proj(8), proj(6), proj(4), proj(3), proj(2)]);
  assert.equal(d.products, 9);
  assert.ok(d.meanSessionsPerProduct >= 6, `mean ${d.meanSessionsPerProduct}`);
  assert.equal(d.shape, "deep focus");
  assert.ok(d.top3Share > 0.5, `top3 ${d.top3Share}`);
});

test("balanced: middle ground", () => {
  const d = computeDistribution(Array.from({ length: 10 }, () => proj(4)));
  assert.equal(d.shape, "balanced");
});

test("few products with few sessions is not portfolio", () => {
  // 3 products × 2 sessions = occasional use, not portfolio steering.
  const d = computeDistribution([proj(2), proj(2), proj(2)]);
  assert.equal(d.shape, "balanced");
});

test("multi-month share counts products spanning more than one month", () => {
  const d = computeDistribution([proj(5, "2026-04", "2026-06"), proj(5, "2026-05", "2026-05")]);
  assert.equal(d.multiMonthProducts, 1);
  assert.equal(d.multiMonthShare, 0.5);
});

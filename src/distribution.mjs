// Work distribution: breadth vs depth across products. Pure counts from the
// per-repo clusters — no PII.
//
// The discriminant a reader would otherwise have to derive by hand: the same
// session volume means opposite things at 2 sessions/product (portfolio
// steering: many products, touched and directed) and at 9 sessions/product
// (sustained building: few products, returned to repeatedly). Neither pole is
// better — but for matching it is one of the most telling signals.
//
// Four signals, all deterministic:
//   - meanSessionsPerProduct / medianSessionsPerProduct
//   - top3Share (share of all sessions spent in the 3 most-worked products)
//   - multiMonthShare (products whose span covers more than one month)
//   - shape band: portfolio / balanced / deep focus

const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export function computeDistribution(projects) {
  if (!projects?.length) return null;
  const counts = projects.map((p) => p.sessions ?? 0).sort((a, b) => b - a);
  const products = counts.length;
  const sessions = counts.reduce((a, b) => a + b, 0);
  if (!sessions) return null;

  const meanSessionsPerProduct = +(sessions / products).toFixed(1);
  const medianSessionsPerProduct = median(counts);
  const top3Share = +(counts.slice(0, 3).reduce((a, b) => a + b, 0) / sessions).toFixed(2);

  // Continuity: products worked across more than one calendar month.
  const multiMonthProducts = projects.filter((p) => p.from && p.to && p.from !== p.to).length;
  const multiMonthShare = +(multiMonthProducts / products).toFixed(2);

  // Shape band — purely for the LLM narrative, not a grade. The portfolio
  // band requires real breadth (≥8 products): 3 products touched twice each
  // is occasional use, not portfolio steering.
  let shape = "balanced";
  if (meanSessionsPerProduct >= 6) shape = "deep focus";
  else if (meanSessionsPerProduct <= 2.5 && products >= 8) shape = "portfolio";

  return {
    products,
    sessions,
    meanSessionsPerProduct,
    medianSessionsPerProduct,
    top3Share,
    multiMonthProducts,
    multiMonthShare,
    shape,
  };
}

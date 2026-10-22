import { buildEstimators, lineEconomics } from './economics.js';

/** Money and counts for a set of lines. Every page's numbers are one of these. */
export function emptyTotals() {
  return {
    lines: 0, units: 0, gmv: 0, discount: 0, gross: 0,
    returnsCustomer: 0, returnsRto: 0, returnsOpen: 0, returnedUnits: 0, returnedGmv: 0, restockedUnits: 0,
    // Returns of sales made before the app's history began: counted, but not in rates or money.
    returnsBeforeHistory: 0, rateReturnsCustomer: 0, rateReturnsRto: 0,
    // Lines known only from a payment file: GST estimated, stock not moved.
    noInvoiceLines: 0, priceEstimatedLines: 0,
    // Recoveries and claims on orders sold before the history began.
    adjustments: 0, adjustmentLines: 0,
    payout: 0, payoutEstimated: 0, payoutEstimatedReturns: 0, estimatedKeptGmv: 0, estimatedLines: 0, unsettledLines: 0,
    cogs: 0, packaging: 0, packagingOnReturns: 0, gst: 0,
    // TCS + TDS held back from payouts (positive), and the part of it that is estimated.
    taxCredit: 0, taxCreditEstimated: 0,
    profit: 0, profitLines: 0, costMissingLines: 0, unknownCodeLines: 0,
    returnCost: 0,
    fees: { commission: 0, fixedFee: 0, shipping: 0, reverseShip: 0, collection: 0, penalty: 0, claim: 0, taxWithheld: 0, other: 0 },
    reasons: {},
  };
}

export function addLine(t, line, e) {
  if (e.adjustmentOnly) {
    if (e.returned) {
      if (e.returnType === 'rto') t.returnsRto++;
      else t.returnsCustomer++;
      t.returnsBeforeHistory++;
      countReason(t, line, e);
    }
    t.adjustments += e.payout;
    t.adjustmentLines++;
    t.payout += e.payout;
    t.profit += e.profit;
    t.profitLines++;
    return t;
  }
  if (e.outOfHistory) {
    if (e.returned) {
      if (e.returnType === 'rto') t.returnsRto++;
      else t.returnsCustomer++;
      if (line.return_status !== 'closed') t.returnsOpen++;
      t.returnsBeforeHistory++;
      countReason(t, line, e);
    }
    return t;
  }
  t.lines++;
  if (line.invoice_missing) t.noInvoiceLines++;
  if (line.price_estimated) t.priceEstimatedLines++;
  t.units += line.qty;
  t.gmv += line.total_paise;
  t.gross += line.gross_paise || line.total_paise;
  t.discount += line.discount_paise || 0;
  if (!line.code) t.unknownCodeLines++;

  if (e.returned) {
    if (e.returnType === 'rto') {
      t.returnsRto++;
      t.rateReturnsRto++;
    } else {
      t.returnsCustomer++;
      t.rateReturnsCustomer++;
    }
    if (line.return_status !== 'closed') t.returnsOpen++;
    t.returnedUnits += line.qty;
    t.returnedGmv += line.total_paise;
    t.returnCost += e.returnCost;
    t.packagingOnReturns += e.packaging;
    if (e.restocked) t.restockedUnits += line.qty;
    countReason(t, line, e);
  }

  t.packaging += e.packaging;
  t.gst += e.gst;
  t.taxCredit += e.taxCredit;
  if (e.estimated) t.taxCreditEstimated += e.taxCredit;
  if (e.payout != null) {
    t.payout += e.payout;
    if (e.estimated) {
      t.payoutEstimated += e.payout;
      t.estimatedLines++;
      if (e.returned) t.payoutEstimatedReturns += e.payout;
      else t.estimatedKeptGmv += line.total_paise;
    }
  } else {
    t.unsettledLines++;
  }
  if (e.cogsCharged != null) t.cogs += e.cogsCharged;
  if (e.costMissing) t.costMissingLines++;
  if (e.profit != null) {
    t.profit += e.profit;
    t.profitLines++;
  }
  if (e.settled) {
    t.fees.commission += line.commission || 0;
    t.fees.fixedFee += line.fixed_fee || 0;
    t.fees.shipping += line.shipping || 0;
    t.fees.reverseShip += line.reverse_ship || 0;
    t.fees.collection += line.collection || 0;
    t.fees.penalty += line.penalty || 0;
    t.fees.claim += line.claim || 0;
    t.fees.taxWithheld += line.tax_withheld || 0;
    t.fees.other += line.other || 0;
  }
  return t;
}

/** The reason a return is filed under, everywhere it is shown. */
export function reasonLabel(line) {
  if (line.return_reason) return line.return_reason;
  if (line.return_type === 'rto') return 'RTO (not delivered)';
  // A return known only from its payment line has no returns-file row to give a reason.
  return line.return_key ? 'No reason given' : 'Reason not uploaded (returns file missing)';
}

function countReason(t, line) {
  const reason = reasonLabel(line);
  t.reasons[reason] = (t.reasons[reason] || 0) + 1;
}

/**
 * Ratios computed once, at the end, from the sums. Return rates use only returns of
 * sales the app has a record of, so they compare like with like.
 */
export function finish(t) {
  const netSales = t.gmv - t.returnedGmv;
  const returns = t.returnsCustomer + t.returnsRto;
  const topReason = Object.entries(t.reasons).sort((a, b) => b[1] - a[1])[0];
  return {
    ...t,
    netSales,
    returns,
    returnRate: t.lines ? (t.rateReturnsCustomer + t.rateReturnsRto) / t.lines : 0,
    customerReturnRate: t.lines ? t.rateReturnsCustomer / t.lines : 0,
    rtoRate: t.lines ? t.rateReturnsRto / t.lines : 0,
    margin: netSales > 0 && t.profitLines ? t.profit / netSales : null,
    profitPerUnit: t.units - t.returnedUnits > 0 && t.profitLines ? Math.round(t.profit / (t.units - t.returnedUnits)) : null,
    payoutPerUnit: t.units ? Math.round(t.payout / t.units) : null,
    avgDiscount: t.gross ? t.discount / t.gross : 0,
    returnMarginHit: netSales > 0 ? t.returnCost / netSales : null,
    topReason: topReason ? { reason: topReason[0], count: topReason[1] } : null,
    complete: t.costMissingLines === 0 && t.unsettledLines === 0,
  };
}

/**
 * Economics for every line, then totals for the whole set and for each group.
 *
 * Estimators are built from ALL loaded lines, not only the filtered ones, so viewing
 * one product does not starve its estimates of data.
 */
export function analyse(allLines, lines, ctx, groupBy) {
  const est = buildEstimators(allLines, ctx);
  const total = emptyTotals();
  const groups = new Map();
  const perLine = [];
  for (const line of lines) {
    const e = lineEconomics(line, ctx, est);
    perLine.push({ line, e });
    addLine(total, line, e);
    if (groupBy) {
      for (const k of [].concat(groupBy(line))) {
        if (k == null) continue;
        let g = groups.get(k);
        if (!g) groups.set(k, (g = emptyTotals()));
        addLine(g, line, e);
      }
    }
  }
  return {
    total: finish(total),
    groups: [...groups.entries()].map(([key, t]) => ({ key, ...finish(t) })),
    perLine,
  };
}

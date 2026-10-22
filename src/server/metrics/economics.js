import { localToday } from '../lib/today.js';

/**
 * Money for one order line: payout, costs, profit and — if it came back — return cost.
 *
 *   profit = payout − GST on the sale − COGS (unless restocked) − packaging
 *            + TCS/TDS withheld (a tax credit the seller claims back, not a cost)
 *
 * - payout is what the platform paid, from the settlement. Until a line is settled it
 *   is ESTIMATED from what similar lines actually paid (same code and platform, then
 *   same platform) and flagged so. A returned line whose return has not been settled
 *   yet uses what settled returns of the same type cost on that platform.
 * - Packaging (₹7) is charged once per packet and never comes back, returned or not.
 * - COGS is charged unless the item came back in good condition and went on the shelf.
 *   An open return (still in transit) is not on the shelf yet, so it is still charged.
 * - A line with no cost for its code gets profit = null, never a cost of zero.
 */
export function lineEconomics(line, ctx, est) {
  const returned = !!line.return_type && line.return_outcome !== 'cancelled';

  // Known only from a returns file: the sale happened before the app's history began
  // (no invoice, no payment line yet). Its sale, cost and packet belong to that
  // earlier period, so it counts for return reasons and return counts but carries no
  // money and stays out of rates — otherwise every such return would look like a
  // loss and push return rates up. It gains money once its payment line is imported.
  // Money on an order sold before the history began — a recovery, a claim, or the
  // refund and return charges of a sale paid earlier: real money this period, but no
  // sale, cost or packet of its own. A return among them still counts as a return.
  if (line.adjustment_only) {
    const ret = !!line.return_type && line.return_outcome !== 'cancelled';
    return {
      adjustmentOnly: true, returned: ret, returnType: ret ? line.return_type : null, restocked: false,
      packaging: 0, cogs: 0, cogsCharged: 0, payout: line.settled_net, estimated: false, settled: true, gst: 0, taxCredit: 0,
      profit: line.settled_net, returnCost: 0, costMissing: false,
    };
  }

  if (line.line_source === 'return') {
    return {
      outOfHistory: true, returned, returnType: returned ? line.return_type : null, restocked: false,
      packaging: 0, cogs: 0, cogsCharged: 0, payout: 0, estimated: false, settled: false, gst: 0, taxCredit: 0,
      profit: 0, returnCost: 0, costMissing: false,
    };
  }
  const closedGood =
    returned &&
    line.return_status === 'closed' &&
    line.return_outcome === 'received' &&
    (line.return_condition || ctx.defaultCondition) === 'good';

  const packaging = line.first_in_shipment ? ctx.packagingPaise : 0;
  const cogs = line.unit_cost_paise == null ? null : line.unit_cost_paise * line.qty;
  const cogsCharged = cogs == null ? null : closedGood ? 0 : cogs;

  let payout = null;
  let estimated = false;
  const settled = line.settlement_lines > 0 && (!returned || line.has_return_txn);
  if (settled) {
    payout = line.settled_net;
  } else if (returned) {
    payout = est.returnPayout(line.platform, line.return_type);
    estimated = true;
  } else {
    const ratio = est.payoutRatio(line.platform, line.code);
    payout = ratio == null ? null : Math.round(line.total_paise * ratio);
    estimated = true;
  }

  // GST on a returned sale is reversed by a credit note, so only kept sales owe it.
  const gst = ctx.gstMode === 'deduct_output' && !returned ? line.tax_paise || 0 : 0;
  // TCS and TDS are held back from the payout but claimed back, so profit never counts
  // them. For a settled line they are known; for an estimated one, the estimate (made
  // from bank payouts) has them inside it, so the typical share is added back too.
  const taxCredit = settled
    ? -(line.tax_withheld || 0)
    : estimated && !returned && payout != null ? Math.round(line.total_paise * est.taxRatio(line.platform)) : 0;

  const profit =
    payout == null || cogsCharged == null ? null : payout - gst - cogsCharged - packaging + taxCredit;
  const returnCost = returned
    ? (payout == null ? 0 : -payout) + packaging + (cogs == null ? 0 : closedGood ? 0 : cogs)
    : 0;

  return {
    returned,
    returnType: returned ? line.return_type : null,
    restocked: closedGood,
    packaging,
    cogs,
    cogsCharged,
    payout,
    estimated,
    settled,
    gst,
    taxCredit,
    profit,
    returnCost,
    costMissing: cogs == null,
  };
}

/**
 * Payout estimators built from the lines that HAVE been settled.
 *
 * Ratios come from the last `windowDays` of settled, kept sales so that a change in
 * commission shows up in estimates within weeks rather than being averaged away.
 */
export function buildEstimators(lines, ctx, today = localToday()) {
  const since = shiftDays(today, -ctx.windowDays);
  const byCode = new Map();
  const byPlatform = new Map();
  const returns = new Map();
  const taxShare = new Map();
  const add = (map, k, net, base) => {
    const cur = map.get(k) || { net: 0, base: 0, n: 0 };
    cur.net += net;
    cur.base += base;
    cur.n++;
    map.set(k, cur);
  };

  for (const l of lines) {
    if (!(l.settlement_lines > 0) || l.adjustment_only || l.line_source === 'return') continue;
    const returned = !!l.return_type && l.return_outcome !== 'cancelled';
    if (returned) {
      if (l.has_return_txn) add(returns, `${l.platform}|${l.return_type}`, l.settled_net, 1);
      continue;
    }
    if (l.sale_date && l.sale_date < since) continue;
    if (!l.total_paise) continue;
    add(byCode, `${l.platform}|${l.code}`, l.settled_net, l.total_paise);
    add(byPlatform, l.platform, l.settled_net, l.total_paise);
    add(taxShare, l.platform, -(l.tax_withheld || 0), l.total_paise);
  }

  return {
    /** TCS + TDS as a share of the sale, from settled lines of that platform. */
    taxRatio(platform) {
      const t = taxShare.get(platform);
      return t && t.base ? t.net / t.base : 0;
    },
    payoutRatio(platform, code) {
      const c = byCode.get(`${platform}|${code}`);
      if (c && c.n >= 3) return c.net / c.base;
      const p = byPlatform.get(platform);
      return p && p.n >= 3 ? p.net / p.base : null;
    },
    returnPayout(platform, type) {
      const r = returns.get(`${platform}|${type}`);
      return r && r.n >= 1 ? Math.round(r.net / r.n) : 0;
    },
  };
}

function shiftDays(ymd, days) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

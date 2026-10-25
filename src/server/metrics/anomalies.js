import { localToday } from '../lib/today.js';
import { getSetting } from '../db/db.js';
import { analyse } from './aggregate.js';
import { economicsContext, filterLines, loadLines } from './lines.js';
import { buyerSummaries } from './customers.js';
import { paymentsDue } from './reports.js';

/**
 * Alerts: figures in the files that look wrong, so they are checked before they are
 * believed. Data Health covers what is missing; this covers what is odd.
 *
 * Every alert has a stable key (type + the row it is about), so "Mark OK" sticks
 * across recalculations and re-imports. Baselines ("usual" payout, fees) come from
 * this seller's own settled orders, per product code and platform, and need at least
 * three of them before anything is called unusual.
 */
export const ALERT_TYPES = {
  payout_low: { severity: 'high', label: 'Payout far below usual', hint: 'Compare the fees on this order with the marketplace rate card; raise a ticket if a fee looks wrong.' },
  deduction: { severity: 'high', label: 'Penalty, fine or recovery', hint: 'Money taken back outside a normal sale. Check the reason in the payment file and dispute it if it is not yours.' },
  paid_cancelled: { severity: 'high', label: 'Paid for a cancelled order', hint: 'Usually reversed in a later payment. If it is not, the marketplace may recover it later.' },
  return_unrecorded: { severity: 'high', label: 'Charged for a return no returns file shows', hint: 'Check whether the item came back. If it did not, raise a claim for a lost return.' },
  invoice_dup: { severity: 'high', label: 'One invoice number on two orders', hint: 'Two labels print the same invoice number. Check both PDFs.' },
  id_mismatch: { severity: 'high', label: 'Files disagree on the invoice number', hint: 'The payment or returns file names a different invoice than the label for the same order.' },
  no_label: { severity: 'medium', label: 'Order missing from that day\'s labels', hint: 'A payment or return for an order whose label was not in that day\'s PDF. Check that every label page was uploaded.' },
  awb_mismatch: { severity: 'medium', label: 'RTO tracking number differs from the label', hint: 'The parcel coming back is not on the AWB that was shipped. Check the parcel when it arrives.' },
  amount_mismatch: { severity: 'medium', label: 'Paid on a different amount than invoiced', hint: 'The payment\'s sale amount is not the invoice total. Check for a price change or a wrong invoice.' },
  shipping_high: { severity: 'medium', label: 'Shipping fee higher than usual', hint: 'Often a wrong weight or size on the listing. Check the product\'s package details.' },
  commission_high: { severity: 'medium', label: 'Commission higher than usual', hint: 'Check the category and price slab on the rate card.' },
  loss_sale: { severity: 'medium', label: 'Sold at a loss', hint: 'After fees, cost and packaging this sale lost money. Check its price.' },
  returner_order: { severity: 'medium', label: 'New order from a frequent returner', hint: 'This buyer returned many earlier orders. Pack carefully and keep proof of what was sent.' },
  price_gap: { severity: 'info', label: 'Price far from your listed price', hint: 'Sold well above or below the price in your lister. A deal, a mistake, or an old price.' },
  bulk_qty: { severity: 'info', label: 'Large quantity on one order', hint: 'Several units to one buyer. Fine for a family; worth a look if it repeats.' },
};

const RANK = { high: 0, medium: 1, info: 2 };
// The days an order from an orders report can ship on — its order day and the next
// two, as marketplaces give 1–2 days to dispatch — before its label counts as missing.
const LABEL_GRACE_DAYS = 3;
const FAM = (p) => (p === 'meesho' ? 'meesho' : 'flipkart');
const rs = (paise) => `₹${(Math.abs(paise) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const pct = (x) => `${Math.round(x * 100)}%`;

function median(values) {
  const v = [...values].sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Per `keyOf(line)` (platform + code by default): the typical `pick(line)` over settled kept sales. */
function baseline(lines, pick, keyOf = (l) => `${l.platform}|${l.code}`) {
  const groups = new Map();
  for (const l of lines) {
    if (!(l.settlement_lines > 0) || l.return_type || l.adjustment_only || !l.total_paise) continue;
    const v = pick(l);
    if (v == null || !(v > 0)) continue;
    const k = keyOf(l);
    if (k == null) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(v);
  }
  const out = new Map();
  for (const [k, v] of groups) if (v.length >= 3) out.set(k, median(v));
  return out;
}

function shift(ymd, days) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const norm = (s) => (s == null ? null : String(s).trim().toUpperCase() || null);

/**
 * Every current alert.
 *   f       — the usual filters (dates apply to the order or payment date)
 *   reviewed — include alerts marked OK
 */
export function findAnomalies(db, f = {}, { today = localToday(), reviewed = false } = {}) {
  const ctx = economicsContext(db);
  const all = loadLines(db, {});
  const lines = filterLines(all.filter((l) => (!f.from || !l.sale_date || l.sale_date >= f.from) && (!f.to || !l.sale_date || l.sale_date <= f.to)), f);
  const { perLine } = analyse(all, lines, ctx, null);
  const n = (key) => Number(getSetting(db, key));
  const payoutGap = n('alert_payout_gap_pct') / 100;
  const feeJump = 1 + n('alert_fee_jump_pct') / 100;
  const priceGap = n('alert_price_gap_pct') / 100;
  const bulkQty = n('alert_bulk_qty');
  const returnWait = n('alert_return_wait_days');
  const recentDays = n('payment_days_max');

  // Ratios are taken on the sale amount the payment file states, when it states one:
  // an invoice or orders report prices a Meesho line without the shipping the buyer
  // paid, so lines from different files would not compare.
  const saleBase = (l) => (l.settled_sale_gross > 0 ? l.settled_sale_gross : l.total_paise);
  // Payout before shipping: Meesho's shipping charge depends on distance (₹5–₹110 for
  // one product in the real files), so a far-away buyer is not an odd payout.
  const exShip = (l) => (l.settled_net - (l.shipping || 0)) / saleBase(l);
  const payoutBase = baseline(all, exShip);
  // Flipkart charges shipping by weight slab within a zone (Local/Zonal/National), so
  // a jump there usually means a wrong weight. Meesho's distance pricing is skipped.
  const shipKey = (l) => (l.platform === 'meesho' ? null : `${l.platform}|${l.code}|${l.shipping_zone || '?'}`);
  const shippingBase = baseline(all, (l) => -(l.shipping || 0), shipKey);
  const commissionBase = baseline(all, (l) => -(l.commission || 0) / saleBase(l));
  // A return charge can only be missing from the returns files once they cover its time.
  const returnsCoverFrom = new Map(
    db.prepare("SELECT platform, MIN(date_from) AS d FROM imports WHERE status = 'committed' AND kind LIKE '%.returns' GROUP BY platform")
      .all().map((r) => [FAM(r.platform), r.d]),
  );
  // Labels only: an orders-report line is not a label.
  const labelDays = new Set(
    db.prepare("SELECT DISTINCT platform, COALESCE(invoice_date, order_date) AS d FROM orders WHERE cancelled = 0 AND source IS NOT 'order_report'")
      .all().map((r) => `${FAM(r.platform)}|${r.d}`),
  );
  // Any label at all, cancelled ones too: a paid cancelled order has its own alert.
  const labelled = new Set(db.prepare("SELECT platform, order_item_key FROM orders WHERE source IS NOT 'order_report'").all().map((r) => `${FAM(r.platform)}|${r.order_item_key}`));
  const buyers = buyerSummaries(db, {});

  const items = [];
  const add = (type, line, { ref, title, detail, amountPaise = null, date }) => {
    const t = ALERT_TYPES[type];
    items.push({
      key: `${type}|${ref || line.natural_key}`, type, severity: t.severity, label: t.label, hint: t.hint,
      platform: line?.platform ?? null, date: date ?? line?.sale_date ?? null, naturalKey: line?.natural_key ?? null,
      orderId: line?.order_id ?? null, sku: line?.sku ?? null, product: line?.product_name ?? null, title, detail, amountPaise,
    });
  };

  for (const { line: l, e } of perLine) {
    if (e.outOfHistory) continue;
    const keptSettled = e.settled && !e.returned && !l.adjustment_only && l.total_paise > 0;

    if (keptSettled && l.settled_sale_gross > 0) {
      const expected = payoutBase.get(`${l.platform}|${l.code}`);
      const actual = exShip(l);
      if (expected != null && expected - actual >= payoutGap) {
        add('payout_low', l, {
          title: `Paid ${rs(l.settled_net)} on a ${rs(saleBase(l))} sale`,
          detail: `Before shipping, ${pct(actual)} of the sale reached you; this product usually keeps about ${pct(expected)} on ${l.platform}.`,
          amountPaise: -Math.round((expected - actual) * saleBase(l)),
        });
      }
    }

    if ((l.penalty || 0) < 0) {
      add('deduction', l, {
        title: `${rs(l.penalty)} taken back${l.adjustment_only ? ' on an older order' : ''}`,
        detail: l.adjustment_only
          ? 'A recovery or penalty on an order sold before your history in this app.'
          : 'A penalty or recovery on this order, on top of the normal fees.',
        amountPaise: l.penalty,
        date: l.last_payment_date,
      });
    }

    const coverFrom = returnsCoverFrom.get(FAM(l.platform));
    if (l.has_return_txn && !l.return_key && l.last_payment_date && l.last_payment_date <= shift(today, -returnWait)
        && coverFrom && l.last_payment_date >= shift(coverFrom, returnWait)) {
      add('return_unrecorded', l, {
        title: `${rs(l.settled_net)} settled as a ${l.return_type === 'rto' ? 'courier return (RTO)' : 'return'}`,
        detail: `The payment on ${l.last_payment_date} treats this order as returned, but no returns file has it.`,
        amountPaise: l.settled_net,
        date: l.last_payment_date,
      });
    }

    const label = norm(l.label_invoice_no);
    for (const [other, from] of [[norm(l.settled_invoice_no), 'payment'], [norm(l.return_invoice_no), 'returns']]) {
      if (label && other && label !== other) {
        add('id_mismatch', l, {
          ref: `${l.natural_key}|${from}`,
          title: `Label invoice ${label}, ${from} file says ${other}`,
          detail: `The ${from} file and the label PDF name different invoices for order ${l.order_id}.`,
        });
      }
    }

    if (l.return_type === 'rto' && l.awb && l.return_tracking_id && norm(l.awb) !== norm(l.return_tracking_id)) {
      add('awb_mismatch', l, {
        title: `Shipped on ${l.awb}, coming back on ${l.return_tracking_id}`,
        detail: 'A courier return normally comes back on the AWB it was shipped with.',
      });
    }

    // A payment or return dates the dispatch, so its label day is that day. An
    // orders-report line dates the order: its label is printed then or up to two days
    // later. So it counts as missing only once that window has passed and labels were
    // uploaded for every day of it — with a day skipped, it may have shipped that day.
    const window = l.line_source === 'order' && l.sale_date
      ? Array.from({ length: LABEL_GRACE_DAYS }, (_, k) => shift(l.sale_date, k))
      : null;
    const missing = window
      ? l.sale_date <= shift(today, -LABEL_GRACE_DAYS) && window.every((d) => labelDays.has(`${FAM(l.platform)}|${d}`))
      : labelDays.has(`${FAM(l.platform)}|${l.sale_date}`);
    if (l.line_source !== 'invoice' && !l.adjustment_only && l.sale_date && missing
        && !labelled.has(`${FAM(l.platform)}|${l.order_item_key}`)) {
      add('no_label', l, {
        title: window
          ? `Order ${l.order_id || ''} is not on the labels of ${window[0]} – ${window[window.length - 1]}`
          : `Order ${l.order_id || ''} is not on the ${l.sale_date} labels`,
        detail: window
          ? `The orders report has it from ${l.sale_date}, and labels were uploaded for every day it could have shipped, but not this one.`
          : `There is ${l.line_source === 'payment' ? 'a payment' : 'a return'} for it, and labels for that day were uploaded, but not this one.`,
      });
    }

    if (l.line_source === 'invoice' && l.settled_sale_gross > 0) {
      const diff = l.settled_sale_gross - l.total_paise;
      if (Math.abs(diff) > Math.max(2000, 0.1 * l.total_paise)) {
        add('amount_mismatch', l, {
          title: `Invoiced ${rs(l.total_paise)}, paid on ${rs(l.settled_sale_gross)}`,
          detail: diff < 0 ? 'The marketplace paid on a lower sale amount than your invoice.' : 'The payment counts a higher sale amount than your invoice.',
          amountPaise: diff,
        });
      }
    }

    if (keptSettled) {
      const usualShip = shipKey(l) && shippingBase.get(shipKey(l));
      const ship = -(l.shipping || 0);
      if (usualShip && ship >= usualShip * feeJump && ship - usualShip >= 1000) {
        add('shipping_high', l, {
          title: `Shipping ${rs(ship)}, usually ${rs(usualShip)}`,
          detail: `For ${l.code} on ${l.platform}${l.shipping_zone ? ` (${l.shipping_zone})` : ''}. A higher weight slab than usual was charged.`,
          amountPaise: -Math.round(ship - usualShip),
        });
      }
      const usualComm = commissionBase.get(`${l.platform}|${l.code}`);
      const comm = -(l.commission || 0);
      const base = saleBase(l);
      if (usualComm && comm / base >= usualComm * feeJump && comm - usualComm * base >= 1000) {
        add('commission_high', l, {
          title: `Commission ${rs(comm)} (${pct(comm / base)} of the sale)`,
          detail: `For ${l.code} on ${l.platform} it is usually about ${pct(usualComm)}.`,
          amountPaise: -Math.round(comm - usualComm * base),
        });
      }
      if (e.profit != null && e.profit < 0) {
        add('loss_sale', l, {
          title: `Lost ${rs(e.profit)} on a ${rs(l.total_paise)} sale`,
          detail: `Payout ${rs(e.payout)} did not cover the cost and packaging.`,
          amountPaise: e.profit,
        });
      }
    }

    const buyer = l.buyer_key ? buyers.get(l.buyer_key) : null;
    if (buyer?.flags.frequentReturner && !e.returned && !e.settled && l.sale_date >= shift(today, -recentDays)) {
      add('returner_order', l, {
        title: `${buyer.name || 'This buyer'} has returned ${buyer.returned} of ${buyer.orders - buyer.cancelled} orders`,
        detail: `${buyer.city || ''}${buyer.pincode ? ` ${buyer.pincode}` : ''}. This order is still on its way.`,
      });
    }

    if (l.line_source === 'invoice' && l.list_price_paise && l.qty) {
      const unit = l.total_paise / l.qty;
      const gap = (unit - l.list_price_paise) / l.list_price_paise;
      if (Math.abs(gap) >= priceGap) {
        add('price_gap', l, {
          title: `Sold at ${rs(unit)}, listed at ${rs(l.list_price_paise)}`,
          detail: `${gap > 0 ? 'Above' : 'Below'} your ${l.platform} price in the lister by ${pct(Math.abs(gap))}.`,
          amountPaise: Math.round((unit - l.list_price_paise) * l.qty),
        });
      }
    }

    if (l.line_source === 'invoice' && l.qty >= bulkQty) {
      add('bulk_qty', l, { title: `${l.qty} units of ${l.sku}`, detail: 'One order line with an unusual quantity.' });
    }
  }

  // Charges not tied to any order: fines, storage recalls, service fees, Meesho
  // recoveries. Ads and TCS/TDS are expected and left out.
  const charges = db
    .prepare(`SELECT natural_key, platform, txn_type, payment_date, net_paise, breakdown_json FROM settlement_lines
               WHERE order_item_key IS NULL AND net_paise < 0 AND txn_type NOT IN ('ads', 'tcs', 'tds')
                 AND (@from IS NULL OR payment_date >= @from) AND (@to IS NULL OR payment_date <= @to)`)
    .all({ from: f.from || null, to: f.to || null });
  for (const c of charges) {
    if (f.platforms?.length && !f.platforms.includes(c.platform)) continue;
    const sheet = (() => { try { return JSON.parse(c.breakdown_json || '{}').sheet; } catch { return null; } })();
    add('deduction', { platform: c.platform, natural_key: c.natural_key, sale_date: c.payment_date }, {
      title: `${rs(c.net_paise)} charged: ${sheet || c.txn_type.replace(/_/g, ' ')}`,
      detail: 'A charge in the payment file that belongs to no order.',
      amountPaise: c.net_paise,
      date: c.payment_date,
    });
  }

  // Money paid for an order that was cancelled before it left.
  const paidCancelled = db
    .prepare(`SELECT o.natural_key, o.platform, o.order_id, o.sku, SUM(s.net_paise) AS net, MAX(s.payment_date) AS paid
                FROM orders o
                JOIN settlement_lines s ON s.order_item_key = o.order_item_key
                 AND (CASE WHEN s.platform = 'meesho' THEN 'meesho' ELSE 'flipkart' END) = (CASE WHEN o.platform = 'meesho' THEN 'meesho' ELSE 'flipkart' END)
               WHERE o.cancelled = 1 GROUP BY o.id HAVING SUM(s.net_paise) > 0`)
    .all();
  for (const p of paidCancelled) {
    if (f.platforms?.length && !f.platforms.includes(p.platform)) continue;
    add('paid_cancelled', { platform: p.platform, natural_key: p.natural_key, order_id: p.order_id, sku: p.sku, sale_date: p.paid }, {
      title: `${rs(p.net)} paid for cancelled order ${p.order_id}`,
      detail: 'The order was cancelled before dispatch, but money for it came in.',
      amountPaise: p.net,
      date: p.paid,
    });
  }

  // One invoice number printed on labels of two different orders.
  const dupes = db
    .prepare(`SELECT CASE WHEN platform = 'meesho' THEN 'meesho' ELSE 'flipkart' END AS fam, invoice_no,
                     COUNT(DISTINCT order_id) AS n, GROUP_CONCAT(DISTINCT order_id) AS orders, MAX(COALESCE(invoice_date, order_date)) AS d
                FROM orders WHERE invoice_no IS NOT NULL GROUP BY fam, invoice_no HAVING COUNT(DISTINCT order_id) > 1`)
    .all();
  for (const d of dupes) {
    add('invoice_dup', { platform: d.fam, natural_key: `${d.fam}|${d.invoice_no}`, sale_date: d.d }, {
      title: `Invoice ${d.invoice_no} is on ${d.n} orders`,
      detail: `Orders ${d.orders.split(',').join(', ')}.`,
      date: d.d,
    });
  }

  // Reviews: "OK" hides an alert, "follow up" pins it.
  const reviews = new Map(db.prepare('SELECT key, status, note, reviewed_at FROM anomaly_reviews').all().map((r) => [r.key, r]));
  for (const it of items) it.review = reviews.get(it.key) || null;
  const visible = items.filter((it) => reviewed || it.review?.status !== 'ok');
  visible.sort((a, b) =>
    (b.review?.status === 'follow_up') - (a.review?.status === 'follow_up') ||
    RANK[a.severity] - RANK[b.severity] ||
    String(b.date || '').localeCompare(String(a.date || '')));

  const counts = { high: 0, medium: 0, info: 0 };
  const byType = {};
  for (const it of visible) {
    if (it.review?.status === 'ok') continue;
    counts[it.severity]++;
    byType[it.type] = byType[it.type] || { type: it.type, label: it.label, severity: it.severity, count: 0, amountPaise: 0 };
    byType[it.type].count++;
    byType[it.type].amountPaise += it.amountPaise || 0;
  }
  const due = paymentsDue(db, f, today);
  const staleDays = n('stale_return_days');
  const staleReturns = db
    .prepare("SELECT COUNT(*) AS n FROM returns WHERE status = 'open' AND created_date IS NOT NULL AND created_date <= ?")
    .get(shift(today, -staleDays)).n;

  return {
    items: visible,
    counts,
    reviewedOk: items.filter((it) => it.review?.status === 'ok').length,
    byType: Object.values(byType).sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.count - a.count),
    gaps: { overduePayments: { lines: due.overdue.lines, paise: due.overdue.paise }, staleReturns: { count: staleReturns, days: staleDays } },
  };
}

/** "ok" hides an alert, "follow_up" pins it, "" clears the review. */
export function setAnomalyReview(db, key, status, note = null) {
  if (!key) throw new Error('No alert given.');
  if (!status) {
    db.prepare('DELETE FROM anomaly_reviews WHERE key = ?').run(key);
    return { key, status: null };
  }
  if (!['ok', 'follow_up'].includes(status)) throw new Error(`Unknown review status "${status}".`);
  db.prepare(`INSERT INTO anomaly_reviews (key, status, note, reviewed_at) VALUES (?, ?, ?, datetime('now'))
              ON CONFLICT(key) DO UPDATE SET status = excluded.status, note = excluded.note, reviewed_at = excluded.reviewed_at`)
    .run(key, status, note);
  return { key, status, note };
}

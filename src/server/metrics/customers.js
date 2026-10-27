import { analyse, reasonLabel } from './aggregate.js';
import { economicsContext, filterLines, loadLines } from './lines.js';
import { moneyByOrder } from './payments.js';

/**
 * Buyers and areas, from the names and addresses on labels.
 *
 * A buyer is a name at a PIN code (lib/buyer.js), so a buyer's history covers every
 * order whose label was imported, on any platform. Returns and payments reach the
 * buyer through their order. Orders known only from a payment or returns file have no
 * label, so they count as "area unknown" and belong to no buyer.
 *
 * Names and addresses are for this seller's own screens. None of this is sent to
 * Gemini: the AI tools get area totals only (areaReport), never a buyer.
 */
export const MIN_AREA_ORDERS = 5;

function base(db, f) {
  const all = loadLines(db, { from: f.from, to: f.to });
  return { all, lines: filterLines(all, f), ctx: economicsContext(db) };
}

function outcome(line, e) {
  if (e.returned) return e.returnType === 'rto' ? 'rto' : 'returned';
  return e.settled ? 'kept' : 'awaiting payment';
}

/** Cancelled orders per buyer: they never became lines, so they are counted from orders. */
function cancelledByBuyer(db, f) {
  const rows = db
    .prepare(`SELECT buyer_key, platform, COUNT(*) AS n, MAX(COALESCE(invoice_date, order_date)) AS last_date
                FROM orders
               WHERE cancelled = 1 AND buyer_key IS NOT NULL
                 AND (@from IS NULL OR COALESCE(invoice_date, order_date) >= @from)
                 AND (@to IS NULL OR COALESCE(invoice_date, order_date) <= @to)
               GROUP BY buyer_key, platform`)
    .all({ from: f.from || null, to: f.to || null });
  const out = new Map();
  for (const r of rows) {
    if (f.platforms?.length && !f.platforms.includes(r.platform)) continue;
    out.set(r.buyer_key, (out.get(r.buyer_key) || 0) + r.n);
  }
  return out;
}

/**
 * The flags a buyer earns. Thresholds are small on purpose: a seller sees few repeat
 * buyers, and two returns from one person is already worth knowing.
 */
export function buyerFlags(b) {
  const kept = b.orders - b.cancelled - b.returned - b.rto;
  return {
    repeat: b.orders >= 2,
    frequentReturner: b.returned >= 2 || (b.orders - b.cancelled >= 2 && b.returned / (b.orders - b.cancelled) >= 0.5),
    // Refused cash on delivery once, or not reachable twice.
    rtoRisk: b.codRto > 0 || b.rto >= 2,
    good: kept >= 2 && b.returned === 0 && b.rto === 0,
  };
}

/** Every buyer's totals, keyed by buyer key. Used by the list, the detail and the alerts. */
export function buyerSummaries(db, f = {}) {
  const { all, lines, ctx } = base(db, f);
  const withBuyer = lines.filter((l) => l.buyer_key);
  const { perLine } = analyse(all, withBuyer, ctx, null);
  const cancelled = cancelledByBuyer(db, f);
  // Profit is what this buyer's orders have actually been paid, less their costs.
  const paid = moneyByOrder(db);
  const buyers = new Map();
  const get = (key) => {
    let b = buyers.get(key);
    if (!b) {
      b = {
        key, name: null, city: null, state: null, pincode: null, platforms: new Set(), orders: 0, returned: 0, rto: 0, cancelled: 0,
        codOrders: 0, codRto: 0, gmv: 0, profit: 0, profitKnown: true, firstDate: null, lastDate: null, reasons: {},
      };
      buyers.set(key, b);
    }
    return b;
  };
  for (const { line, e } of perLine) {
    if (e.outOfHistory || e.adjustmentOnly) continue;
    const b = get(line.buyer_key);
    const date = line.sale_date;
    if (!b.lastDate || date >= b.lastDate) {
      b.name = line.buyer_name;
      b.city = line.ship_city;
      b.state = line.ship_state;
      b.pincode = line.ship_pincode;
    }
    b.firstDate = !b.firstDate || date < b.firstDate ? date : b.firstDate;
    b.lastDate = !b.lastDate || date > b.lastDate ? date : b.lastDate;
    b.platforms.add(line.platform);
    b.orders++;
    b.gmv += line.total_paise || 0;
    if (line.payment_mode === 'cod') b.codOrders++;
    if (e.returned) {
      if (e.returnType === 'rto') {
        b.rto++;
        if (line.payment_mode === 'cod') b.codRto++;
      } else {
        b.returned++;
        const r = reasonLabel(line);
        b.reasons[r] = (b.reasons[r] || 0) + 1;
      }
    }
    const m = paid.get(line.natural_key);
    if (m) {
      b.profit += m.profit;
      if (m.costMissing) b.profitKnown = false;
    }
  }
  // A buyer whose only orders were cancelled still shows, from the orders table.
  for (const [key, n] of cancelled) {
    const b = get(key);
    b.cancelled = n;
    b.orders += n;
    if (!b.name) {
      const o = db.prepare('SELECT buyer_name, ship_city, ship_state, ship_pincode, platform FROM orders WHERE buyer_key = ? ORDER BY id DESC LIMIT 1').get(key);
      Object.assign(b, { name: o.buyer_name, city: o.ship_city, state: o.ship_state, pincode: o.ship_pincode });
      b.platforms.add(o.platform);
    }
  }
  for (const b of buyers.values()) {
    b.platforms = [...b.platforms];
    const delivered = b.orders - b.cancelled;
    b.returnRate = delivered ? (b.returned + b.rto) / delivered : 0;
    b.flags = buyerFlags(b);
  }
  return buyers;
}

/**
 * The Customers page: one row per buyer, with how their orders went.
 *   q    — matches the name, city or PIN code
 *   flag — repeat | frequentReturner | rtoRisk | good
 */
export function customerList(db, f, { q = '', flag = '' } = {}) {
  const buyers = [...buyerSummaries(db, f).values()];
  const needle = q.trim().toLowerCase();
  const rows = buyers
    .filter((b) => !flag || b.flags[flag])
    .filter((b) => !needle || [b.name, b.city, b.pincode].some((v) => String(v || '').toLowerCase().includes(needle)))
    .sort((a, b) => b.orders - a.orders || (b.returned + b.rto) - (a.returned + a.rto) || String(b.lastDate).localeCompare(String(a.lastDate)));
  const repeat = buyers.filter((b) => b.flags.repeat);
  const returners = buyers.filter((b) => b.flags.frequentReturner);
  const sum = (list, k) => list.reduce((a, b) => a + b[k], 0);
  return {
    summary: {
      buyers: buyers.length,
      repeatBuyers: repeat.length,
      ordersFromRepeatBuyers: sum(repeat, 'orders'),
      orders: sum(buyers, 'orders'),
      frequentReturners: returners.length,
      returnsFromFrequentReturners: sum(returners, 'returned'),
      returns: sum(buyers, 'returned'),
      rtoRisk: buyers.filter((b) => b.flags.rtoRisk).length,
    },
    rows: rows.slice(0, 500),
    total: rows.length,
  };
}

/** An order's money from its payments; not paid yet means no profit yet. */
export function paidMoney(m) {
  return m ? { paid: true, payoutPaise: m.net, profitPaise: m.costMissing ? null : m.profit } : { paid: false, payoutPaise: null, profitPaise: null };
}

/** One buyer: their totals and every order, with how it went. */
export function customerDetail(db, key) {
  const summary = buyerSummaries(db, {}).get(key) || null;
  if (!summary) return null;
  const all = loadLines(db, {});
  const mine = all.filter((l) => l.buyer_key === key);
  const { perLine } = analyse(all, mine, economicsContext(db), null);
  const paid = moneyByOrder(db);
  const orders = perLine
    .filter(({ e }) => !e.outOfHistory && !e.adjustmentOnly)
    .map(({ line, e }) => ({
      naturalKey: line.natural_key, date: line.sale_date, platform: line.platform, orderId: line.order_id, sku: line.sku,
      product: line.product_name, variant: line.variant_label, qty: line.qty, totalPaise: line.total_paise,
      paymentMode: line.payment_mode, awb: line.awb, address: line.ship_address, city: line.ship_city,
      outcome: outcome(line, e), reason: e.returned && e.returnType !== 'rto' ? reasonLabel(line) : null,
      returnStatus: line.return_status, ...paidMoney(paid.get(line.natural_key)),
    }));
  const cancelled = db
    .prepare(`SELECT natural_key, platform, order_id, sku, total_paise, COALESCE(invoice_date, order_date) AS date, payment_mode, ship_address, ship_city
                FROM orders WHERE buyer_key = ? AND cancelled = 1`)
    .all(key)
    .map((o) => ({
      naturalKey: o.natural_key, date: o.date, platform: o.platform, orderId: o.order_id, sku: o.sku, totalPaise: o.total_paise,
      paymentMode: o.payment_mode, address: o.ship_address, city: o.ship_city, outcome: 'cancelled', profitPaise: 0,
    }));
  return { ...summary, history: [...orders, ...cancelled].sort((a, b) => String(b.date).localeCompare(String(a.date))) };
}

const LEVELS = {
  state: (l) => l.ship_state,
  // Town names repeat across states (Aurangabad in Bihar and Maharashtra), so a city is "City, State".
  city: (l) => (l.ship_city ? `${l.ship_city}, ${l.ship_state || '?'}` : null),
  pincode: (l) => l.ship_pincode,
  zone: (l) => l.shipping_zone,
};

/**
 * Returns by area. `level` is state, city, pincode or zone (Flipkart's Local/Zonal/
 * National); `state` and `city` narrow the lines first, for drilling down.
 *
 * An area is "above average" when its return rate beats the overall rate and it has
 * at least MIN_AREA_ORDERS orders — two orders and one return is not a pattern.
 */
export function areaReport(db, f, { level = 'state', state = '', city = '' } = {}) {
  const keyOf = LEVELS[level] || LEVELS.state;
  const { all, lines, ctx } = base(db, f);
  const scoped = lines.filter((l) => (!state || l.ship_state === state) && (!city || LEVELS.city(l) === city));
  const known = scoped.filter((l) => keyOf(l));
  const { total, groups } = analyse(all, known, ctx, keyOf);
  // Profit per area from the payments its orders have received.
  const paid = moneyByOrder(db);
  const areaProfit = new Map();
  for (const l of known) {
    const m = paid.get(l.natural_key);
    if (m) areaProfit.set(keyOf(l), (areaProfit.get(keyOf(l)) || 0) + m.profit);
  }
  areaProfit.set('all', [...areaProfit.values()].reduce((a, v) => a + v, 0));
  const byMode = analyse(all, known.filter((l) => l.payment_mode), ctx, (l) => l.payment_mode).groups;
  const pick = (g) => ({
    key: g.key, orders: g.lines, gmv: g.gmv, returnsCustomer: g.returnsCustomer, returnsRto: g.returnsRto,
    returnRate: g.returnRate, customerReturnRate: g.customerReturnRate, rtoRate: g.rtoRate, returnCost: g.returnCost,
    profit: areaProfit.get(g.key) || 0, topReason: g.topReason,
  });
  const rows = groups.map((g) => {
    const row = pick(g);
    row.vsAverage = total.returnRate ? g.returnRate / total.returnRate : null;
    row.aboveAverage = g.lines >= MIN_AREA_ORDERS && g.returnRate > total.returnRate;
    return row;
  });
  rows.sort((a, b) => b.returnsCustomer + b.returnsRto - (a.returnsCustomer + a.returnsRto) || b.orders - a.orders);
  return {
    level, state, city, minOrders: MIN_AREA_ORDERS,
    total: pick({ key: 'all', ...total }),
    rows,
    unknownLines: scoped.length - known.length,
    byPaymentMode: byMode.map(pick),
  };
}

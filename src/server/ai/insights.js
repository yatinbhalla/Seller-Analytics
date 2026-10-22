import { callGeminiJSON, chatWithTools } from './client.js';
import { buildTools, scrub, systemPrompt } from './tools.js';
import { overview, products, returnsReport } from '../metrics/reports.js';

const rupees = (v) => (v == null ? null : Math.round(v) / 100);

/** "Ask your data": Gemini answers from the app's own metric functions. */
export async function ask(db, message, history = []) {
  const tools = buildTools(db);
  // History arrives from the browser as {role, text}; Gemini wants {role, parts}.
  const h = history
    .filter((m) => m && (m.role === 'user' || m.role === 'model') && m.text)
    .slice(-10)
    .map((m) => ({ role: m.role, parts: [{ text: String(m.text) }] }));
  return chatWithTools({ system: systemPrompt(db), history: h, message, tools });
}

/**
 * The insight digest for a period: what changed against the period before it, what
 * needs attention, and what to do. The model gets both periods' aggregates — never
 * raw orders — and must cite them.
 */
export async function digest(db, { from, to }) {
  const days = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1);
  const prevTo = shift(from, -1);
  const prevFrom = shift(prevTo, -(days - 1));
  const slim = (o) => ({
    total: brief(o.total),
    platforms: o.platforms.map((p) => ({ platform: p.key, ...brief(p) })),
    best: o.best.map((p) => ({ name: p.name, profitRs: rupees(p.profit) })),
    worst: o.worst.map((p) => ({ name: p.name, profitRs: rupees(p.profit) })),
    topReturnReasons: o.topReasons,
  });
  const now = slim(overview(db, { from, to }));
  const before = slim(overview(db, { from: prevFrom, to: prevTo }));
  const prods = products(db, { from, to }).rows.slice(0, 30).map((p) => ({
    name: p.name,
    all: brief(p.metrics.all),
    byPlatform: Object.fromEntries(Object.entries(p.metrics).filter(([k]) => k !== 'all').map(([k, v]) => [k, brief(v)])),
  }));

  const prompt = `Period ${from} to ${to}, compared with ${prevFrom} to ${prevTo}.
This period: ${JSON.stringify(now)}
Previous period: ${JSON.stringify(before)}
Products this period: ${JSON.stringify(prods)}

Return JSON: {
  "headline": one sentence,
  "changes": [up to 5 {"text": string, "direction": "up"|"down"|"flat"}],
  "attention": [up to 5 {"product": string|null, "platform": string|null, "issue": string}],
  "actions": [up to 5 {"action": "scale"|"fix"|"stop"|"restock"|"reprice"|"check", "product": string|null, "platform": string|null, "why": string}]
}
Use only numbers present above. Write rupees as ₹.`;
  return callGeminiJSON(prompt, { system: systemPrompt(db), temperature: 0.3 });
}

/** Group return reasons and buyer comments into themes, per product. */
export async function returnThemes(db, { from, to }) {
  const r = returnsReport(db, { from, to });
  const items = r.rows
    .slice(0, 300)
    .map((x) => ({ product: x.product || x.sku, type: x.type, reason: x.reason, detail: scrub(x.subReason), comment: scrub(x.comments) }));
  if (!items.length) return { themes: [], note: 'No returns in this period.' };
  const prompt = `Returns (${items.length}): ${JSON.stringify(items)}

Group them into themes such as size/fit, colour or print not as shown, quality/material, damaged in transit,
wrong item, changed mind, RTO/not delivered. Return JSON:
{"themes": [{"theme": string, "count": number, "products": [{"product": string, "count": number}], "example": string, "fix": string}]}
Counts must be counted from the list above.`;
  return callGeminiJSON(prompt, { system: systemPrompt(db), temperature: 0.2 });
}

function brief(t) {
  if (!t) return null;
  return {
    lines: t.lines, units: t.units, salesRs: rupees(t.gmv), payoutRs: rupees(t.payout), profitRs: rupees(t.profit),
    marginPct: t.margin == null ? null : Math.round(t.margin * 1000) / 10,
    returnRatePct: Math.round(t.returnRate * 1000) / 10, rtoRatePct: Math.round(t.rtoRate * 1000) / 10,
    returnCostRs: rupees(t.returnCost),
  };
}

function shift(ymd, days) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

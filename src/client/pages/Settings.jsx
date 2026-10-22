import { Fragment, useMemo, useState } from 'react';
import { api, useApi } from '../lib/api.js';
import { n, niceDate, rs, today } from '../lib/format.js';
import { Button, Card, Empty, ErrorBox, Input, PageHeader, Select, Status } from '../components/ui.jsx';

const TABS = [
  ['costs', 'Products & costs'],
  ['mapping', 'SKU mapping'],
  ['recipes', 'Pack recipes'],
  ['general', 'General'],
  ['backups', 'Backups'],
];

export default function Settings() {
  const [tab, setTab] = useState('costs');
  return (
    <div>
      <PageHeader title="Settings" />
      <div className="mb-4 flex gap-1 border-b border-line" role="tablist">
        {TABS.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === k ? 'border-ink font-medium text-ink' : 'border-transparent text-ink-2 hover:text-ink'}`}>
            {l}
          </button>
        ))}
      </div>
      {tab === 'costs' && <Costs />}
      {tab === 'mapping' && <Mapping />}
      {tab === 'recipes' && <Recipes />}
      {tab === 'general' && <General />}
      {tab === 'backups' && <Backups />}
    </div>
  );
}

// ─── Products & costs ──────────────────────────────────────────────────────────

function Costs() {
  const { data, error, reload } = useApi('/catalog');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(null);
  const [historyFor, setHistoryFor] = useState(null);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);
  const [adding, setAdding] = useState(false);

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const m = new Map();
    for (const c of data || []) {
      if (needle && !`${c.code} ${c.product_name} ${c.category_name} ${c.aliases || ''}`.toLowerCase().includes(needle)) continue;
      const k = c.product_id ?? 'none';
      if (!m.has(k)) m.set(k, { id: c.product_id, name: c.product_name || 'Not linked to a product', category: c.category_name, codes: [] });
      m.get(k).codes.push(c);
    }
    return [...m.values()];
  }, [data, q]);

  const sync = async () => {
    setErr(null);
    try {
      const r = await api('/catalog/sync', { method: 'POST' });
      setMsg(`Synced from the listers: +${r.products} products, +${r.codes} codes, +${r.costs} costs, +${r.listings} listing SKUs.`);
      reload();
    } catch (e) {
      setErr(e.message);
    }
  };

  const saveCost = async () => {
    setErr(null);
    try {
      await api('/catalog/costs', { method: 'POST', body: { code: editing.code, rupees: editing.rupees, effectiveFrom: editing.from, note: editing.note || null } });
      setMsg(`${editing.code}: ₹${editing.rupees} from ${editing.from}. Orders before that date keep their old cost.`);
      setEditing(null);
      reload();
    } catch (e) {
      setErr(e.message);
    }
  };

  const rename = async (p) => {
    const name = window.prompt('Product name', p.name);
    if (!name || name === p.name) return;
    await api(`/catalog/products/${p.id}`, { method: 'PATCH', body: { name } }).catch((e) => setErr(e.message));
    reload();
  };

  if (!data) return <><ErrorBox error={error} />{!error && <Empty>Loading…</Empty>}</>;
  return (
    <div>
      <ErrorBox error={err} />
      {msg && <div className="mb-3"><Status kind="good">{msg}</Status></div>}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input placeholder="Search code or product" value={q} onChange={(e) => setQ(e.target.value)} />
        <Button onClick={() => setAdding(!adding)}>{adding ? 'Close' : 'Add a new SKU code'}</Button>
        <Button variant="ghost" onClick={sync}>Sync from listers</Button>
        <span className="text-xs text-muted">{n(data.length)} codes · cost is per unit as sold (a 4-pack costs 4 pieces); ₹7 packaging is added per packet</span>
      </div>
      {adding && <AddCode onDone={() => { setAdding(false); reload(); }} />}

      <div className="overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="data">
          <thead>
            <tr><th>Code</th><th>Variant</th><th className="r">Pieces</th><th className="r">Cost / unit</th><th>Since</th><th>Old names</th><th className="r">Listing copies</th><th className="r">Flipkart</th><th className="r">Meesho</th><th /></tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <Fragment key={g.id ?? 'none'}>
                <tr className="bg-wash">
                  <td colSpan={10}>
                    <span className="font-medium text-ink">{g.name}</span> <span className="text-xs text-muted">{g.category}</span>
                    {g.id && <button className="ml-2 text-xs text-series hover:underline" onClick={() => rename(g)}>rename</button>}
                  </td>
                </tr>
                {g.codes.map((c) => (
                  <Fragment key={c.code}>
                    <tr>
                      <td className="font-mono text-xs">{c.display_code}{c.is_set_listing ? <span className="ml-1 font-sans text-muted">(set listing)</span> : null}</td>
                      <td>{c.variant_label}</td>
                      <td className="r">{c.pack_of}</td>
                      <td className={`r ${c.cost_paise == null ? 'text-bad' : ''}`}>{c.cost_paise == null ? 'missing' : rs(c.cost_paise, { exact: true })}</td>
                      <td className="text-ink-2">{c.cost_from && c.cost_from > '2000-01-01' ? niceDate(c.cost_from) : c.cost_from ? 'start' : '—'}</td>
                      <td className="font-mono text-xs text-ink-2">{c.aliases || ''}</td>
                      <td className="r">{n(c.listing_copies)}</td>
                      <td className="r text-ink-2">{rs(c.flipkart_price_paise)}</td>
                      <td className="r text-ink-2">{rs(c.meesho_price_paise)}</td>
                      <td className="whitespace-nowrap">
                        <Button variant="ghost" onClick={() => setEditing({ code: c.code, rupees: c.cost_paise != null ? c.cost_paise / 100 : '', from: today(), note: '' })}>Change cost</Button>
                        {c.cost_versions > 1 && <Button variant="ghost" onClick={() => setHistoryFor(historyFor === c.code ? null : c.code)}>History</Button>}
                      </td>
                    </tr>
                    {editing?.code === c.code && (
                      <tr>
                        <td colSpan={10}>
                          <div className="flex flex-wrap items-center gap-2 py-1">
                            <span className="text-sm">New cost ₹</span>
                            <Input type="number" min="0" step="0.01" value={editing.rupees} onChange={(e) => setEditing({ ...editing, rupees: e.target.value })} className="w-28" />
                            <span className="text-sm">from</span>
                            <Input type="date" value={editing.from} onChange={(e) => setEditing({ ...editing, from: e.target.value })} />
                            <Input placeholder="Why (optional)" value={editing.note} onChange={(e) => setEditing({ ...editing, note: e.target.value })} />
                            <Button variant="primary" onClick={saveCost}>Save</Button>
                            <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                          </div>
                        </td>
                      </tr>
                    )}
                    {historyFor === c.code && <CostHistory code={c.code} />}
                  </Fragment>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CostHistory({ code }) {
  const { data } = useApi(`/catalog/costs/${encodeURIComponent(code)}`);
  return (
    <tr>
      <td colSpan={10} className="text-xs text-ink-2">
        {(data || []).map((h) => <div key={h.id}>{h.effective_from === '2000-01-01' ? 'From the start' : `From ${niceDate(h.effective_from)}`}: {rs(h.cost_paise, { exact: true })} {h.note && `— ${h.note}`}</div>)}
      </td>
    </tr>
  );
}

function AddCode({ onDone }) {
  const products = useApi('/catalog/products');
  const [f, setF] = useState({ code: '', cost: '', mode: 'new', productId: '', variantId: '', newProductName: '', categoryName: '', variantLabel: 'Single', packOf: 1 });
  const [err, setErr] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const product = (products.data || []).find((p) => String(p.id) === f.productId);
  const save = async () => {
    setErr(null);
    try {
      await api('/catalog/codes', {
        method: 'POST',
        body: {
          code: f.code, costRupees: f.cost, variantLabel: f.variantLabel, packOf: f.packOf,
          ...(f.mode === 'new' ? { newProductName: f.newProductName, categoryName: f.categoryName } : { productId: f.productId, variantId: f.variantId || null }),
        },
      });
      onDone();
    } catch (e) {
      setErr(e.message);
    }
  };
  return (
    <Card className="mb-3" title="Add a new SKU code">
      <ErrorBox error={err} />
      <div className="flex flex-wrap items-center gap-2">
        <Input placeholder="Code, e.g. CC_RD (no /number)" value={f.code} onChange={set('code')} />
        <Select value={f.mode} onChange={set('mode')} aria-label="Product">
          <option value="new">for a new product</option>
          <option value="existing">for an existing product</option>
        </Select>
        {f.mode === 'new' ? (
          <>
            <Input placeholder="Product name" value={f.newProductName} onChange={set('newProductName')} />
            <Input placeholder="Category" value={f.categoryName} onChange={set('categoryName')} />
          </>
        ) : (
          <>
            <Select value={f.productId} onChange={(e) => setF({ ...f, productId: e.target.value, variantId: '' })} aria-label="Existing product">
              <option value="">Choose…</option>
              {(products.data || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
            {product && (
              <Select value={f.variantId} onChange={set('variantId')} aria-label="Variant">
                <option value="">New variant…</option>
                {product.variants.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
              </Select>
            )}
          </>
        )}
        {!f.variantId && <Input placeholder="Variant, e.g. Pack of 2" value={f.variantLabel} onChange={set('variantLabel')} className="w-36" />}
        {!f.variantId && <Input type="number" min="1" title="Pieces in one unit" value={f.packOf} onChange={set('packOf')} className="w-20" />}
        <Input type="number" min="0" step="0.01" placeholder="Cost ₹ per unit" value={f.cost} onChange={set('cost')} className="w-36" />
        <Button variant="primary" onClick={save}>Add</Button>
      </div>
    </Card>
  );
}

// ─── SKU mapping ───────────────────────────────────────────────────────────────

function Mapping() {
  const aliases = useApi('/catalog/aliases');
  const unknown = useApi('/catalog/unknown');
  const [f, setF] = useState({ alias: '', code: '' });
  const [err, setErr] = useState(null);
  const act = async (fn) => {
    setErr(null);
    try {
      await fn();
      aliases.reload();
      unknown.reload();
    } catch (e) {
      setErr(e.message);
    }
  };
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Old codes that mean an existing code">
        <ErrorBox error={err} />
        <table className="data">
          <thead><tr><th>Old code</th><th>Means</th><th>Note</th><th /></tr></thead>
          <tbody>
            {(aliases.data || []).map((a) => (
              <tr key={a.alias}>
                <td className="font-mono text-xs">{a.alias}</td>
                <td className="font-mono text-xs">{a.code}</td>
                <td className="text-xs text-ink-2">{a.confirmed ? <Status kind="good">confirmed</Status> : <Status kind="warn">assumed — please check</Status>} {a.note}</td>
                <td className="whitespace-nowrap">
                  {!a.confirmed && <Button variant="ghost" onClick={() => act(() => api(`/catalog/aliases/${encodeURIComponent(a.alias)}/confirm`, { method: 'POST', body: { confirmed: true } }))}>Yes</Button>}
                  <Button variant="ghost" onClick={() => act(() => api(`/catalog/aliases/${encodeURIComponent(a.alias)}/confirm`, { method: 'POST', body: { confirmed: false } }))}>Remove</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-3 flex flex-wrap gap-2">
          <Input placeholder="Old code" value={f.alias} onChange={(e) => setF({ ...f, alias: e.target.value })} />
          <Input placeholder="Means code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
          <Button onClick={() => act(async () => { await api('/catalog/aliases', { method: 'POST', body: f }); setF({ alias: '', code: '' }); })}>Add</Button>
        </div>
      </Card>
      <Card title="Codes in your data the catalog does not know">
        {!(unknown.data || []).length ? <Empty>None — every code resolves.</Empty> : (
          <table className="data">
            <thead><tr><th>Code</th><th>Example</th><th className="r">Rows</th></tr></thead>
            <tbody>{unknown.data.map((u) => <tr key={u.code}><td className="font-mono text-xs">{u.code}</td><td className="font-mono text-xs text-muted">{u.example_sku}</td><td className="r">{n(u.seen)}</td></tr>)}</tbody>
          </table>
        )}
        <p className="mt-2 text-xs text-muted">Map each to an old code on the left, or add it under Products & costs.</p>
      </Card>
    </div>
  );
}

// ─── Pack recipes ──────────────────────────────────────────────────────────────

function Recipes() {
  const todo = useApi('/stock/recipes/todo');
  const items = useApi('/catalog/stock-items');
  const [edit, setEdit] = useState(null);
  const [err, setErr] = useState(null);
  const save = async () => {
    setErr(null);
    try {
      await api(`/stock/recipes/${encodeURIComponent(edit.code)}`, { method: 'POST', body: { components: edit.components.filter((c) => c.stockItemId) } });
      setEdit(null);
      todo.reload();
    } catch (e) {
      setErr(e.message);
    }
  };
  return (
    <div className="space-y-4">
      <Card title="How a code takes pieces from the shelves">
        <p className="text-sm text-ink-2">
          Every code has a recipe. <span className="font-mono text-xs">WH_4MFO</span> takes 4 pieces of the Black Floral organiser, the same shelf as{' '}
          <span className="font-mono text-xs">WH_1MFO</span> and <span className="font-mono text-xs">WH_MFO_SET</span>. Recipes were set up from your lister configs; mixed packs need you to say which pieces go in.
        </p>
      </Card>
      <Card title="Mixed packs waiting for a recipe">
        <ErrorBox error={err} />
        {!(todo.data || []).length ? <Empty>None.</Empty> : (
          <table className="data">
            <tbody>
              {todo.data.map((t) => (
                <Fragment key={t.code}>
                  <tr>
                    <td className="font-mono text-xs">{t.code}</td>
                    <td>{t.product_name} — {t.variant_label}</td>
                    <td className="text-xs text-ink-2">{t.reason}</td>
                    <td><Button variant="ghost" onClick={() => setEdit({ code: t.code, components: [{ stockItemId: '', qty: 1 }] })}>Set recipe</Button></td>
                  </tr>
                  {edit?.code === t.code && (
                    <tr>
                      <td colSpan={4}>
                        {edit.components.map((c, i) => (
                          <div key={i} className="mb-1 flex gap-2">
                            <Select value={c.stockItemId} onChange={(e) => { const comps = [...edit.components]; comps[i] = { ...c, stockItemId: e.target.value }; setEdit({ ...edit, components: comps }); }} aria-label="Shelf">
                              <option value="">Choose shelf…</option>
                              {(items.data || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                            </Select>
                            <Input type="number" min="1" value={c.qty} onChange={(e) => { const comps = [...edit.components]; comps[i] = { ...c, qty: e.target.value }; setEdit({ ...edit, components: comps }); }} className="w-20" aria-label="Pieces" />
                          </div>
                        ))}
                        <div className="flex gap-2">
                          <Button variant="ghost" onClick={() => setEdit({ ...edit, components: [...edit.components, { stockItemId: '', qty: 1 }] })}>+ another shelf</Button>
                          <Button variant="primary" onClick={save}>Save recipe</Button>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

// ─── General ───────────────────────────────────────────────────────────────────

function General() {
  const { data, reload } = useApi('/settings');
  const [draft, setDraft] = useState(null);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);
  if (!data) return <Empty>Loading…</Empty>;
  const v = draft || data;
  const set = (k, val) => setDraft({ ...v, [k]: val });
  const save = async () => {
    setErr(null);
    try {
      await api('/settings', { method: 'PUT', body: v });
      setMsg('Saved. Every report recalculates with the new settings.');
      setDraft(null);
      reload();
    } catch (e) {
      setErr(e.message);
    }
  };
  return (
    <Card title="How the numbers are worked out">
      <ErrorBox error={err} />
      {msg && <div className="mb-3"><Status kind="good">{msg}</Status></div>}
      <div className="grid max-w-2xl gap-3 text-sm">
        <Field label="Packaging per shipped packet (₹)" hint="Material, tape, label. Charged once per packet — returned or not.">
          <Input type="number" min="0" step="0.5" value={Number(v.packaging_paise) / 100} onChange={(e) => set('packaging_paise', Math.round(Number(e.target.value) * 100))} className="w-28" />
        </Field>
        <Field label="GST in profit" hint="Off: GST collected on sales is taken as offset by the input credit you claim on purchases. On: each kept sale's GST is taken off profit.">
          <Select value={v.gst_mode} onChange={(e) => set('gst_mode', e.target.value)}>
            <option value="ignore">Off — offset by input credit on purchases</option>
            <option value="deduct_output">On — deduct GST on kept sales</option>
          </Select>
        </Field>
        <Field label="A returned item with no condition in the file is" hint="You can mark any single return damaged on the Returns page.">
          <Select value={v.default_return_condition} onChange={(e) => set('default_return_condition', e.target.value)}>
            <option value="good">Good — back on the shelf</option>
            <option value="damaged">Damaged — not restocked</option>
          </Select>
        </Field>
        <Field label="Flag returns still open after (days)"><Input type="number" min="1" value={v.stale_return_days} onChange={(e) => set('stale_return_days', e.target.value)} className="w-24" /></Field>
        <Field label="Payment arrives after dispatch, in days" hint="Unsettled orders are expected inside this window and flagged as overdue after it.">
          <span className="flex items-center gap-2">
            <Input type="number" min="0" value={v.payment_days_min} onChange={(e) => set('payment_days_min', e.target.value)} className="w-20" aria-label="Earliest" />
            <span className="text-ink-2">to</span>
            <Input type="number" min="1" value={v.payment_days_max} onChange={(e) => set('payment_days_max', e.target.value)} className="w-20" aria-label="Latest" />
          </span>
        </Field>
        <Field label="Estimate unsettled payouts from the last (days)" hint="Payout of an unsettled order is estimated from what similar settled orders actually paid."><Input type="number" min="7" value={v.estimate_window_days} onChange={(e) => set('estimate_window_days', e.target.value)} className="w-24" /></Field>
        <div className="mt-2 border-t border-line pt-3 text-xs font-medium uppercase tracking-wide text-muted">Alerts — what counts as odd</div>
        <Field label="Payout below usual by (points of the sale)" hint="Compared with what this product usually keeps on that platform, before shipping.">
          <Input type="number" min="1" value={v.alert_payout_gap_pct} onChange={(e) => set('alert_payout_gap_pct', e.target.value)} className="w-20" />
        </Field>
        <Field label="Shipping or commission above usual by (%)" hint="Flipkart shipping is compared within its shipping zone.">
          <Input type="number" min="1" value={v.alert_fee_jump_pct} onChange={(e) => set('alert_fee_jump_pct', e.target.value)} className="w-20" />
        </Field>
        <Field label="Selling price away from the lister's price by (%)">
          <Input type="number" min="1" value={v.alert_price_gap_pct} onChange={(e) => set('alert_price_gap_pct', e.target.value)} className="w-20" />
        </Field>
        <Field label="Large quantity on one order (units)"><Input type="number" min="2" value={v.alert_bulk_qty} onChange={(e) => set('alert_bulk_qty', e.target.value)} className="w-20" /></Field>
        <Field label="Wait for a return's file row (days)" hint="A return charged in a payment, with no returns-file row after this long, is flagged.">
          <Input type="number" min="1" value={v.alert_return_wait_days} onChange={(e) => set('alert_return_wait_days', e.target.value)} className="w-20" />
        </Field>
        <div><Button variant="primary" onClick={save} disabled={!draft}>Save</Button></div>
      </div>
    </Card>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="grid gap-1 sm:grid-cols-[18rem_1fr] sm:items-center">
      <span>
        <span className="text-ink">{label}</span>
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
      <span>{children}</span>
    </label>
  );
}

// ─── Backups ───────────────────────────────────────────────────────────────────

function Backups() {
  const { data, reload } = useApi('/backups');
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);
  const now = async () => {
    setErr(null);
    try {
      const r = await api('/backups', { method: 'POST' });
      setMsg(`Backed up to ${r.file}`);
      reload();
    } catch (e) {
      setErr(e.message);
    }
  };
  const restore = async (file) => {
    if (!window.confirm(`Restore ${file}? The current database is backed up first, so this can be undone.`)) return;
    setErr(null);
    try {
      await api('/backups/restore', { method: 'POST', body: { file } });
      setMsg(`Restored ${file}. Reload the page.`);
      reload();
    } catch (e) {
      setErr(e.message);
    }
  };
  return (
    <Card title="Backups" action={<Button onClick={now}>Back up now</Button>}>
      <ErrorBox error={err} />
      {msg && <div className="mb-3"><Status kind="good">{msg}</Status></div>}
      <p className="mb-2 text-xs text-muted">A backup is taken automatically before every commit and every undo. The newest 30 are kept in data\backups.</p>
      {!(data || []).length ? <Empty>No backups yet.</Empty> : (
        <table className="data">
          <thead><tr><th>File</th><th>Taken</th><th className="r">Size</th><th /></tr></thead>
          <tbody>
            {data.map((b) => (
              <tr key={b.file}><td className="font-mono text-xs">{b.file}</td><td>{new Date(b.createdAt).toLocaleString('en-IN')}</td><td className="r">{(b.bytes / 1024).toFixed(0)} KB</td><td><Button variant="ghost" onClick={() => restore(b.file)}>Restore</Button></td></tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

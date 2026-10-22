import { useEffect, useRef, useState } from 'react';
import { api, useApi } from '../lib/api.js';
import { n, niceDate, platformLabel, rs } from '../lib/format.js';
import { Button, Card, Empty, ErrorBox, Input, PageHeader, Select, Status } from '../components/ui.jsx';

/**
 * Daily upload: drop the day's files → see exactly what each one would change →
 * resolve new SKU codes and money changes → Commit. Nothing reaches the dashboard
 * before Commit, and any committed import can be undone.
 */
export default function Import() {
  const [batch, setBatch] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  const history = useApi('/imports');
  const inputRef = useRef(null);
  const [drag, setDrag] = useState(false);
  const [waiting, setWaiting] = useState(false);

  // Files the nightly download staged but left for a decision show up as the preview.
  useEffect(() => {
    api('/imports/staged').then((rows) => {
      if (!rows.length) return;
      setBatch((b) => b || rows);
      setWaiting(true);
    }).catch(() => {});
  }, []);

  const upload = async (fileList) => {
    const files = [...fileList];
    if (!files.length) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const form = new FormData();
      files.forEach((f) => form.append('files', f, f.name));
      const results = await api('/imports/stage', { method: 'POST', form });
      setBatch(results);
      setWaiting(false);
      history.reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const staged = (batch || []).filter((r) => r.status === 'staged');
  const unknown = {};
  for (const r of staged) for (const [code, count] of Object.entries(r.summary.unknownCodes || {})) unknown[code] = (unknown[code] || 0) + count;

  const commit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api('/imports/commit', { method: 'POST', body: { ids: staged.map((s) => s.importId) } });
      setDone(res);
      setBatch(null);
      setWaiting(false);
      history.reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const discardAll = async () => {
    for (const s of staged) await api(`/imports/${s.importId}/discard`, { method: 'POST' }).catch(() => {});
    setBatch(null);
    setWaiting(false);
    history.reload();
  };

  return (
    <div>
      <PageHeader title="Import files" subtitle="Drop all of today's files at once — invoice PDFs, payment / settlement Excel, return-created and return-closure Excel, from Flipkart and Meesho. The app works out which is which." />
      <ErrorBox error={error} />

      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); upload(e.dataTransfer.files); }}
        className={`flex flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-10 text-center ${drag ? 'border-series bg-wash' : 'border-line bg-surface'}`}
      >
        <div className="text-sm text-ink">{busy ? 'Reading files…' : 'Drag files here'}</div>
        <div className="mt-1 text-xs text-muted">PDF, XLSX, XLS, CSV or ZIP · up to 40 files at a time</div>
        <Button className="mt-3" onClick={() => inputRef.current?.click()} disabled={busy}>Choose files</Button>
        <input ref={inputRef} type="file" multiple accept=".pdf,.xlsx,.xls,.csv,.zip" className="hidden" onChange={(e) => { upload(e.target.files); e.target.value = ''; }} />
      </div>

      {done && (
        <div className="mt-4 rounded-lg border border-line bg-surface px-4 py-3">
          <Status kind="good">
            Committed {done.length} file(s): {n(done.reduce((a, d) => a + d.inserted, 0))} new rows, {n(done.reduce((a, d) => a + d.updated, 0))} updated,{' '}
            {n(done.reduce((a, d) => a + d.unchanged, 0))} already known (skipped). Every row was read back and checked against the file.
          </Status>
        </div>
      )}

      {batch && (
        <Card className="mt-4" title={waiting ? 'Waiting for your decision' : 'Preview — nothing is saved until you commit'}>
          {waiting && (
            <p className="mb-3 text-xs text-ink-2">
              Staged earlier and not committed: either the nightly download found rows set aside or changed amounts, or an upload was left
              unfinished. Nothing from them is saved until you commit.
            </p>
          )}
          <div className="space-y-3">
            {batch.map((r, i) => <FileResult key={i} r={r} />)}
          </div>
          {Object.keys(unknown).length > 0 && <NewCodes unknown={unknown} />}
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button variant="primary" onClick={commit} disabled={busy || !staged.length}>
              Commit {staged.length} file(s)
            </Button>
            <Button variant="ghost" onClick={discardAll} disabled={busy || !staged.length}>Discard</Button>
            {Object.keys(unknown).length > 0 && (
              <span className="text-xs text-ink-2">
                You can commit now; lines with new codes import but show <b>“cost missing”</b> until you add the code below.
              </span>
            )}
          </div>
        </Card>
      )}

      <Card className="mt-4" title="Import history">
        <History rows={history.data || []} reload={history.reload} setError={setError} />
      </Card>
    </div>
  );
}

function FileResult({ r }) {
  if (r.status === 'already_imported') {
    return <Row name={r.fileName}><Status kind="info">Already imported (#{r.importId}, {niceDate(r.committedAt)}) — skipped, nothing doubled.</Status></Row>;
  }
  if (r.status === 'duplicate_in_batch') {
    return <Row name={r.fileName}><Status kind="info">Same file as {r.sameAs} in this upload — skipped.</Status></Row>;
  }
  if (r.status === 'failed') {
    return <Row name={r.fileName}><Status kind="bad">Not imported: {r.error}</Status></Row>;
  }
  const s = r.summary;
  return (
    <Row name={r.fileName} kind={`${s.label}${Object.keys(s.platforms).length ? ' · ' + Object.keys(s.platforms).map(platformLabel).join(', ') : ''}`}>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
        <span><b className="text-ink">{n(s.new)}</b> new</span>
        <span><b className="text-ink">{n(s.update)}</b> updated</span>
        <span><b className="text-ink">{n(s.unchanged)}</b> already known</span>
        {s.batchDupes > 0 && <span><b className="text-ink">{n(s.batchDupes)}</b> repeated in this upload (merged)</span>}
        {s.skipped > 0 && <span><b className="text-ink">{n(s.skipped)}</b> {s.skipLabel}</span>}
        {s.pages != null && <span>{n(s.pages)} pages → {n(s.invoicesFound)} invoice lines</span>}
        {s.returnsOpen + s.returnsClosed > 0 && <span>{n(s.returnsOpen)} open · {n(s.returnsClosed)} closed returns</span>}
        {s.moneyTotal !== 0 && <span>Total {rs(s.moneyTotal)}</span>}
        {s.dateFrom && <span>{niceDate(s.dateFrom)} – {niceDate(s.dateTo)}</span>}
      </div>
      {s.rejected > 0 && <RejectedRows importId={r.importId} count={s.rejected} />}
      {s.money_changed > 0 && <MoneyChanges importId={r.importId} />}
    </Row>
  );
}

function Row({ name, kind, children }) {
  return (
    <div className="rounded-md border border-line px-3 py-2.5">
      <div className="mb-1 flex flex-wrap items-baseline gap-2">
        <span className="text-sm font-medium text-ink">{name}</span>
        {kind && <span className="text-xs text-muted">{kind}</span>}
      </div>
      {children}
    </div>
  );
}

function RejectedRows({ importId, count }) {
  const [open, setOpen] = useState(false);
  const { data } = useApi(open ? `/imports/${importId}` : null);
  return (
    <div className="mt-2">
      <button className="text-xs" onClick={() => setOpen(!open)}>
        <Status kind="warn">{n(count)} row(s) set aside and NOT imported — {open ? 'hide' : 'see why'}</Status>
      </button>
      {open && data && (
        <ul className="mt-1 max-h-48 overflow-y-auto text-xs text-ink-2">
          {data.rejected.map((x, i) => <li key={i}>Row {x.row_no}: {x.reason}</li>)}
        </ul>
      )}
    </div>
  );
}

/** Same row, different amount: could be a real correction or a mistake — the seller decides. */
function MoneyChanges({ importId }) {
  const { data, reload } = useApi(`/imports/${importId}`);
  if (!data?.moneyChanges?.length) return null;
  const decide = async (m, accepted) => {
    await api(`/imports/${importId}/accept`, { method: 'POST', body: { entity: m.entity, naturalKey: m.natural_key, accepted } });
    reload();
  };
  return (
    <div className="mt-2 rounded-md bg-wash p-2">
      <Status kind="warn">These rows are already saved with different amounts. Accept only the ones the marketplace really corrected:</Status>
      <table className="data mt-1">
        <tbody>
          {data.moneyChanges.map((m) => {
            const diff = JSON.parse(m.diff || '{}');
            return (
              <tr key={m.natural_key}>
                <td className="font-mono text-xs">{m.natural_key.split('|').slice(2).join('|')}</td>
                <td className="text-xs">
                  {Object.entries(diff).filter(([k]) => k.endsWith('_paise') || k === 'qty').map(([k, v]) => (
                    <div key={k}>{k.replace('_paise', '')}: {k === 'qty' ? v.from : rs(v.from, { exact: true })} → <b>{k === 'qty' ? v.to : rs(v.to, { exact: true })}</b></div>
                  ))}
                </td>
                <td className="r whitespace-nowrap">
                  <Button variant={m.accepted ? 'primary' : 'default'} onClick={() => decide(m, true)}>Accept</Button>{' '}
                  <Button variant={!m.accepted ? 'primary' : 'default'} onClick={() => decide(m, false)}>Keep old</Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** "New SKU codes found": give each a cost and a home before (or after) committing. */
function NewCodes({ unknown }) {
  const products = useApi('/catalog/products');
  const [saved, setSaved] = useState({});
  return (
    <div className="mt-4 rounded-md border border-line p-3">
      <Status kind="warn">New SKU codes found — the catalog has never seen these. Add each one's cost so its profit can be worked out.</Status>
      <div className="mt-2 space-y-2">
        {Object.entries(unknown).map(([code, count]) =>
          saved[code] ? (
            <div key={code} className="text-sm"><Status kind="good">{code} added.</Status></div>
          ) : (
            <NewCodeForm key={code} code={code} count={count} products={products.data || []} onSaved={() => setSaved({ ...saved, [code]: true })} />
          ),
        )}
      </div>
    </div>
  );
}

function NewCodeForm({ code, count, products, onSaved }) {
  const [mode, setMode] = useState('alias');
  const [form, setForm] = useState({ cost: '', productId: '', variantId: '', aliasOf: '', newProductName: '', categoryName: '', variantLabel: 'Single', packOf: 1 });
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const product = products.find((p) => String(p.id) === form.productId);

  const save = async () => {
    setError(null);
    try {
      if (mode === 'alias') {
        await api('/catalog/aliases', { method: 'POST', body: { alias: code, code: form.aliasOf, note: 'Mapped during import' } });
      } else {
        await api('/catalog/codes', {
          method: 'POST',
          body: mode === 'existing'
            ? { code, costRupees: form.cost, variantId: form.variantId || null, productId: form.productId || null, variantLabel: form.variantLabel, packOf: form.packOf }
            : { code, costRupees: form.cost, newProductName: form.newProductName, categoryName: form.categoryName, variantLabel: form.variantLabel, packOf: form.packOf },
        });
      }
      onSaved();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="rounded-md bg-wash p-2 text-sm">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="font-mono font-medium">{code}</span>
        <span className="text-xs text-muted">in {count} row(s)</span>
        <Select value={mode} onChange={(e) => setMode(e.target.value)} aria-label="How to add">
          <option value="alias">Same as an existing code (old name)</option>
          <option value="existing">New pack/size of an existing product</option>
          <option value="new">A brand-new product</option>
        </Select>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {mode === 'alias' && <Input placeholder="Existing code, e.g. TC_NBC" value={form.aliasOf} onChange={set('aliasOf')} />}
        {mode === 'existing' && (
          <>
            <Select value={form.productId} onChange={(e) => setForm({ ...form, productId: e.target.value, variantId: '' })} aria-label="Product">
              <option value="">Choose product…</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
            {product && (
              <Select value={form.variantId} onChange={set('variantId')} aria-label="Variant">
                <option value="">New variant…</option>
                {product.variants.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
              </Select>
            )}
          </>
        )}
        {mode === 'new' && (
          <>
            <Input placeholder="Product name" value={form.newProductName} onChange={set('newProductName')} />
            <Input placeholder="Category" value={form.categoryName} onChange={set('categoryName')} />
          </>
        )}
        {mode !== 'alias' && (
          <>
            {!form.variantId && <Input placeholder="Variant, e.g. Pack of 2" value={form.variantLabel} onChange={set('variantLabel')} className="w-36" />}
            {!form.variantId && <Input type="number" min="1" title="Pieces per unit" value={form.packOf} onChange={set('packOf')} className="w-20" />}
            <Input type="number" min="0" step="0.01" placeholder="Cost ₹ per unit" value={form.cost} onChange={set('cost')} className="w-36" />
          </>
        )}
        <Button onClick={save}>Save</Button>
      </div>
      {error && <div className="mt-1"><Status kind="bad">{error}</Status></div>}
    </div>
  );
}

function History({ rows, reload, setError }) {
  if (!rows.length) return <Empty>No imports yet.</Empty>;
  const undo = async (id) => {
    if (!window.confirm(`Undo import #${id}? Its rows are removed and anything it changed is put back. A backup is taken first.`)) return;
    try {
      await api(`/imports/${id}/revert`, { method: 'POST' });
      reload();
    } catch (err) {
      setError(err.message);
    }
  };
  return (
    <div className="max-h-[28rem] overflow-auto">
      <table className="data">
        <thead>
          <tr><th>#</th><th>File</th><th>Type</th><th>Status</th><th className="r">New</th><th className="r">Updated</th><th className="r">Known</th><th className="r">Set aside</th><th>Covers</th><th /></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="text-muted">{r.id}</td>
              <td className="max-w-xs truncate" title={r.error || r.file_name}>{r.file_name}</td>
              <td className="text-ink-2">{r.kind || '—'}</td>
              <td>
                {r.status === 'committed' ? <Status kind="good">committed</Status> : r.status === 'failed' ? <Status kind="bad">failed</Status> : <span className="text-xs text-ink-2">{r.status}</span>}
              </td>
              <td className="r">{n(r.rows_new)}</td>
              <td className="r">{n(r.rows_updated)}</td>
              <td className="r">{n(r.rows_unchanged)}</td>
              <td className="r">{n(r.rows_rejected)}</td>
              <td className="whitespace-nowrap text-ink-2">{r.date_from ? `${niceDate(r.date_from)} – ${niceDate(r.date_to)}` : '—'}</td>
              <td>{r.status === 'committed' && <Button variant="ghost" onClick={() => undo(r.id)}>Undo</Button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

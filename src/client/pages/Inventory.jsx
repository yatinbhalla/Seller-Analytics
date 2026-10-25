import { useMemo, useState } from 'react';
import { api, useApi } from '../lib/api.js';
import { n, niceDate, rs, today } from '../lib/format.js';
import { Button, Card, Empty, ErrorBox, Input, Loading, Notice, PageHeader, Select, Status } from '../components/ui.jsx';

/**
 * Stock in pieces per shelf (one design in one size). A 4-pack sale takes 4 pieces
 * from the same shelf a 1-pack sale takes 1 from — on every platform and listing type.
 */
export default function Inventory() {
  const { data, error, loading, reload } = useApi('/stock');
  const [q, setQ] = useState('');
  const [onlyLow, setOnlyLow] = useState(false);
  const [entry, setEntry] = useState(null);
  const [history, setHistory] = useState(null);
  const [saveError, setSaveError] = useState(null);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data || []).filter((s) => (!needle || `${s.name} ${s.codes.map((c) => c.code).join(' ')}`.toLowerCase().includes(needle)) && (!onlyLow || s.low || s.negative));
  }, [data, q, onlyLow]);

  if (!data) return <><ErrorBox error={error} />{!error && <Empty>Loading…</Empty>}</>;
  const noOpening = data.filter((s) => !s.has_opening).length;
  const value = data.reduce((a, s) => a + (s.valuePaise || 0), 0);

  const save = async () => {
    setSaveError(null);
    try {
      await api('/stock/moves', { method: 'POST', body: { ...entry, stockItemId: entry.item.id } });
      setEntry(null);
      reload();
    } catch (err) {
      setSaveError(err.message);
    }
  };

  const showHistory = async (s) => {
    setHistory({ item: s, rows: await api(`/stock/${s.id}/history`) });
  };

  return (
    <Loading loading={loading}>
      <PageHeader title="Stock" subtitle={`${n(data.length)} shelves · stock value at cost ${rs(value)}`}>
        <div className="flex items-center gap-2">
          <Input placeholder="Search design or code" value={q} onChange={(e) => setQ(e.target.value)} />
          <label className="flex items-center gap-1.5 text-sm text-ink-2">
            <input type="checkbox" checked={onlyLow} onChange={(e) => setOnlyLow(e.target.checked)} /> Low or negative only
          </label>
        </div>
      </PageHeader>
      <ErrorBox error={error || saveError} />
      {noOpening > 0 && (
        <Notice>
          {n(noOpening)} shelves have no opening count yet, so their stock starts from zero and goes negative as orders ship. Use <b>Count</b> to enter what is on the shelf today.
        </Notice>
      )}

      {entry && (
        <Card className="mb-4" title={`${entry.kind === 'opening' ? 'Opening count' : entry.kind === 'purchase' ? 'Stock received' : entry.kind === 'writeoff' ? 'Write off' : 'Adjust'} — ${entry.item.name}`}>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={entry.kind} onChange={(e) => setEntry({ ...entry, kind: e.target.value })} aria-label="Kind">
              <option value="opening">Opening count (pieces on the shelf)</option>
              <option value="purchase">Received / made</option>
              <option value="writeoff">Write off (damaged, lost)</option>
              <option value="adjust">Adjust (+/−, after a recount)</option>
            </Select>
            <Input type="number" placeholder="Pieces" value={entry.qty} onChange={(e) => setEntry({ ...entry, qty: e.target.value })} className="w-28" />
            <Input type="date" value={entry.date} onChange={(e) => setEntry({ ...entry, date: e.target.value })} />
            <Input placeholder="Note (optional)" value={entry.note} onChange={(e) => setEntry({ ...entry, note: e.target.value })} />
            <Button variant="primary" onClick={save}>Save</Button>
            <Button variant="ghost" onClick={() => setEntry(null)}>Cancel</Button>
          </div>
          <p className="mt-2 text-xs text-muted">
            Count in pieces. A 4-pack on the shelf is 4 pieces.
            {entry.kind === 'opening' && ' A count is taken as at the start of its date: that day\'s dispatches and everything after come off it, and earlier orders are already in it.'}
          </p>
        </Card>
      )}

      <div className="overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="data">
          <thead>
            <tr>
              <th>Shelf</th><th>Sold as</th><th className="r">On hand</th><th className="r">Packs you can make</th>
              <th className="r">Use / day</th><th className="r">Days left</th><th className="r">Returning</th><th className="r">Value</th><th>Status</th><th />
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <td>{s.name}<div className="text-xs text-muted">{s.category_name}</div></td>
                <td className="font-mono text-[11px] text-ink-2">{s.codes.map((c) => `${c.code}${c.qty > 1 ? ` ×${c.qty}` : ''}`).join(', ')}</td>
                <td className={`r font-medium ${s.negative ? 'text-bad' : ''}`}>
                  {n(s.on_hand)}
                  {s.counted_on && <div className="text-[11px] font-normal text-muted">counted {niceDate(s.counted_on)}</div>}
                </td>
                <td className="r text-ink-2">{s.packs.length > 1 ? s.packs.map((p) => `${p.possible}×${p.packOf}`).join(' · ') : '—'}</td>
                <td className="r">{s.dailyUse || '—'}</td>
                <td className="r">{s.daysCover ?? '—'}</td>
                <td className="r">{s.inTransit ? n(s.inTransit) : '—'}</td>
                <td className="r">{rs(s.valuePaise)}</td>
                <td>
                  {s.negative ? <Status kind="bad">below zero</Status> : s.low ? <Status kind="warn">reorder ~{n(s.suggestedReorder)}</Status> : s.dailyUse ? <Status kind="good">ok</Status> : null}
                </td>
                <td className="whitespace-nowrap">
                  <Button variant="ghost" onClick={() => setEntry({ item: s, kind: s.has_opening ? 'purchase' : 'opening', qty: '', date: today(), note: '' })}>
                    {s.has_opening ? 'Add' : 'Count'}
                  </Button>
                  <Button variant="ghost" onClick={() => showHistory(s)}>History</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {history && (
        <Card className="mt-4" title={`History — ${history.item.name}`} action={<Button variant="ghost" onClick={() => setHistory(null)}>Close</Button>}>
          {!history.rows.length ? <Empty>No moves yet.</Empty> : (
            <table className="data">
              <thead><tr><th>Date</th><th>Move</th><th className="r">Pieces</th><th>From</th></tr></thead>
              <tbody>
                {history.rows.map((m, i) => (
                  <tr key={i} className={m.counted ? '' : 'opacity-50'} title={m.counted ? undefined : 'Before the latest count — already in it'}>
                    <td>{niceDate(m.move_date)}</td>
                    <td>{m.kind}{!m.counted && <div className="text-[11px] text-muted">before the count</div>}</td>
                    <td className="r">{m.qty > 0 ? `+${m.qty}` : m.qty}</td>
                    <td className="font-mono text-xs text-ink-2">{m.ref_type === 'manual' ? 'entered by you' : m.ref_key.split('|').slice(2).join('|')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
    </Loading>
  );
}

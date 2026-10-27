import { useState } from 'react';
import { Link } from 'react-router';
import { qs, useApi } from '../lib/api.js';
import { useFilters } from '../lib/filters.jsx';
import { n, niceDate, pct, rs } from '../lib/format.js';
import { Button, Card, Chip, Empty, ErrorBox, Input, KIND_TONE, Loading, Money, Notice, PageHeader, PlatformTag, Select, Tile } from '../components/ui.jsx';

const KIND_LABEL = {
  sale: 'Sale', return: 'Return', rto: 'RTO', cancelled: 'Cancelled', penalty: 'Penalty', claim: 'Claim', ads: 'Ads', tax: 'TCS / TDS', other: 'Other',
};

/**
 * Every payment received, and the profit it left. Profit is counted when the money
 * arrives, never when the order is sent. The SKU table shows why the same product is
 * paid differently; the list shows each payment against its SKU's usual one.
 */
export default function Payments() {
  const { filters } = useFilters();
  const { data, error, loading } = useApi(`/reports/payments${qs(filters)}`);
  const [code, setCode] = useState('');

  if (!data) return <><ErrorBox error={error} />{!error && <Empty>Loading…</Empty>}</>;
  const t = data.total;
  if (!t.payments) {
    return (
      <>
        <PageHeader title="Payments" />
        <Empty>No payments in this range. <Link to="/import" className="text-series underline">Import your payment files</Link>.</Empty>
      </>
    );
  }
  const kinds = Object.entries(t.byKind).filter(([, v]) => v.n);

  return (
    <Loading loading={loading}>
      <PageHeader title="Payments" subtitle="Every payment received in this range and the profit it left, by the date it was paid" />
      <ErrorBox error={error} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile tone="green" label="Money received (bank)" value={rs(t.net)} sub={`${n(t.payments)} payments`} />
        <Tile tone={t.profit < 0 ? 'red' : 'teal'} label="Profit" value={rs(t.profit)} sub={t.margin == null ? '—' : `${pct(t.margin)} of money received`} />
        <Tile tone="violet" label="Cost of goods and packets" value={rs(t.cost + t.packets)} sub={`${rs(t.packets)} of it packets`} />
        <Tile tone="blue" label="TCS / TDS to claim back" value={rs(t.taxBack)} sub={<Link to="/tax" className="underline">Held back from payments</Link>} />
      </div>

      {t.costMissing > 0 && (
        <Notice tone="amber">
          {n(t.costMissing)} payments ({rs(t.costMissingNet)}) are for products with no cost price, so they are left out of profit —{' '}
          <Link to="/health" className="underline">add the cost in Data health</Link>.
        </Notice>
      )}

      <Card className="mt-4" title="By type of payment">
        <div className="flex flex-wrap gap-2">
          {kinds.map(([k, v]) => (
            <div key={k} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm">
              <Chip tone={KIND_TONE[k]}>{KIND_LABEL[k]}</Chip>
              <span className="num text-ink-2">{n(v.n)}</span>
              <Money paise={v.net} />
              <span className="text-xs text-muted">profit</span>
              <Money paise={v.profit} />
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-ink-2">
          A return's payment holds the sale, the refund and the return shipping, so it is usually a small loss. An RTO's sale and refund cancel out;
          it costs the ₹7 packet. Goods that come back in good condition are not charged.
        </p>
      </Card>

      <Card className="mt-4" title="By platform">
        <div className="overflow-x-auto">
          <table className="data">
            <thead>
              <tr>
                <th>Platform</th>
                <th className="r">Payments</th>
                <th className="r">Received</th>
                <th className="r">Profit</th>
                <th className="r">Margin</th>
              </tr>
            </thead>
            <tbody>
              {data.platforms.map((p) => (
                <tr key={p.platform}>
                  <td><PlatformTag platform={p.platform} /></td>
                  <td className="r">{n(p.payments)}</td>
                  <td className="r"><Money paise={p.net} /></td>
                  <td className="r"><Money paise={p.profit} /></td>
                  <td className="r">{pct(p.margin)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <SkuTable rows={data.skus} selected={code} onSelect={setCode} />
      <PaymentList filters={filters} code={code} onClear={() => setCode('')} />
    </Loading>
  );
}

/**
 * One row per SKU (platform, code, pack size): its usual payout, the range, and which
 * parts of the payment move it. All ranges share one scale so rows compare at a glance.
 */
function SkuTable({ rows, selected, onSelect }) {
  const withRange = rows.filter((r) => r.payout);
  const lo = Math.min(0, ...withRange.map((r) => r.payout.low));
  const hi = Math.max(1, ...withRange.map((r) => r.payout.high));
  const x = (v) => `${((v - lo) / (hi - lo)) * 100}%`;
  return (
    <Card className="mt-4" tone="green" title="Why the same SKU is paid differently">
      <p className="mb-3 text-xs text-ink-2">
        Usual is the middle payment of kept sales. The bar runs from the lowest to the highest payment; the chips name the parts of the payment that
        move it. Pick a SKU to see its payments below.
      </p>
      <div className="overflow-x-auto">
        <table className="data">
          <thead>
            <tr>
              <th>SKU</th>
              <th className="r">Paid sales</th>
              <th className="r">Usual payout</th>
              <th className="w-48">Lowest – highest</th>
              <th>Varies by</th>
              <th className="r">Returns · RTO</th>
              <th className="r">Profit per sale</th>
              <th className="r">Profit</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className={`cursor-pointer ${selected === r.code ? 'bg-green-50 dark:bg-green-950/40' : ''}`} onClick={() => onSelect(selected === r.code ? '' : r.code)}>
                <td>
                  <div className="font-medium text-ink">{r.code}{r.qty > 1 ? ` ×${r.qty}` : ''}</div>
                  <div className="flex items-center gap-2 text-xs text-muted"><PlatformTag platform={r.platform} />{r.product && <span className="truncate">{r.product}</span>}</div>
                </td>
                <td className="r">{n(r.sales)}</td>
                <td className="r">{r.payout ? rs(r.payout.usual) : '—'}</td>
                <td>
                  {r.payout ? (
                    <div title={`${rs(r.payout.low)} – ${rs(r.payout.high)}`}>
                      <div className="relative h-2.5 rounded-full bg-wash">
                        <div className="absolute h-2.5 rounded-full bg-green-300 dark:bg-green-800" style={{ left: x(r.payout.low), width: `calc(${x(r.payout.high)} - ${x(r.payout.low)})` }} />
                        <div className="absolute -top-0.5 h-3.5 w-1 rounded bg-green-800 dark:bg-green-300" style={{ left: x(r.payout.usual) }} />
                      </div>
                      <div className="mt-0.5 flex justify-between text-[11px] text-muted"><span>{rs(r.payout.low)}</span><span>{rs(r.payout.high)}</span></div>
                    </div>
                  ) : <span className="text-xs text-muted">fewer than 3 sales</span>}
                </td>
                <td>
                  <div className="flex flex-wrap gap-1">
                    {r.payout?.drivers.slice(0, 3).map((d) => (
                      <Chip key={d.part} tone={d.part === 'shipping' ? 'coral' : d.part === 'price' ? 'violet' : 'blue'} title={`${rs(d.low)} to ${rs(d.high)}`}>{d.label}</Chip>
                    ))}
                  </div>
                </td>
                <td className="r text-ink-2">{n(r.returns)} · {n(r.rto)}</td>
                <td className="r">{r.profitPerSale == null ? '—' : <Money paise={r.profitPerSale} />}</td>
                <td className="r">{r.costMissing ? <span className="text-xs text-muted">no cost price</span> : <Money paise={r.profit} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** Each payment, newest first, with what it left as profit and how it compares with its SKU's usual payment. */
function PaymentList({ filters, code, onClear }) {
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(100);
  const { data } = useApi(`/reports/payments/list${qs(filters, { kind, code, q, limit })}`);
  return (
    <Card
      className="mt-4"
      title={code ? `Payments for ${code}` : 'All payments'}
      action={
        <div className="flex flex-wrap items-center gap-2">
          {code && <Button variant="ghost" onClick={onClear}>Show all SKUs</Button>}
          <Select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Type of payment">
            <option value="">Every type</option>
            {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Order ID or SKU" aria-label="Search payments" />
        </div>
      }
    >
      {!data ? <Empty>Loading…</Empty> : !data.rows.length ? <Empty>No payments match.</Empty> : (
        <>
          <div className="overflow-x-auto">
            <table className="data">
              <thead>
                <tr>
                  <th>Paid on</th>
                  <th>Type</th>
                  <th>SKU</th>
                  <th className="r">Buyer paid</th>
                  <th className="r">Fees and shipping</th>
                  <th className="r">Received</th>
                  <th className="r">Cost and packet</th>
                  <th className="r">Profit</th>
                  <th>Against usual</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((p) => {
                  const fees = p.parts.commission + p.parts.fees + p.parts.shipping + p.parts.deductions + p.parts.other;
                  return (
                    <tr key={p.id}>
                      <td className="whitespace-nowrap">{niceDate(p.date)}<div className="text-xs text-muted"><PlatformTag platform={p.platform} /></div></td>
                      <td><Chip tone={KIND_TONE[p.kind]}>{KIND_LABEL[p.kind]}</Chip></td>
                      <td>
                        <div className="text-ink">{p.sku || '—'}</div>
                        {p.orderId && <div className="text-xs text-muted">{p.orderId}</div>}
                      </td>
                      <td className="r">{p.parts.price || p.parts.refund ? rs(p.parts.price + p.parts.refund) : '—'}</td>
                      <td className="r">{fees ? <Money paise={fees} /> : '—'}</td>
                      <td className="r"><Money paise={p.net} /></td>
                      <td className="r text-ink-2">{p.cost || p.packet ? rs(-(p.cost || 0) - p.packet) : '—'}</td>
                      <td className="r">{p.profit == null ? <span className="text-xs text-muted">no cost price</span> : <Money paise={p.profit} />}</td>
                      <td className="text-xs">
                        {p.vsUsual ? (
                          p.vsUsual.gap === 0 ? <span className="text-muted">usual</span> : (
                            <span title={p.vsUsual.parts.map((x) => `${x.label} ${x.diff > 0 ? '+' : '−'}${rs(Math.abs(x.diff))}`).join(', ')}>
                              <Money paise={p.vsUsual.gap} />
                              <span className="text-ink-2">
                                {' '}· {p.vsUsual.parts.slice(0, 2).map((x) => `${x.label.toLowerCase()} ${x.diff > 0 ? '+' : '−'}${rs(Math.abs(x.diff))}`).join(', ')}
                              </span>
                            </span>
                          )
                        ) : <span className="text-muted">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {data.count > data.rows.length && (
            <div className="mt-3 flex items-center gap-3 text-sm text-ink-2">
              Showing {n(data.rows.length)} of {n(data.count)}
              <Button onClick={() => setLimit(limit + 200)}>Show more</Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

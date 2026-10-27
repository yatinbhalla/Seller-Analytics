import { useState } from 'react';
import { Link } from 'react-router';
import { qs, useApi } from '../lib/api.js';
import { useFilters } from '../lib/filters.jsx';
import { n, niceDate, pct, rs } from '../lib/format.js';
import { Empty, ErrorBox, Input, Loading, Money, Notice, PageHeader, PlatformTag, Select, Stat } from '../components/ui.jsx';
import BuyerFlags from '../components/BuyerFlags.jsx';

export const buyerPath = (key) => `/customers/${encodeURIComponent(key)}`;

/**
 * Buyers, from the names and addresses on label PDFs: who ordered more than once and
 * how it went. A buyer is a name at a PIN code, on any platform.
 */
export default function Customers() {
  const { filters } = useFilters();
  const [q, setQ] = useState('');
  const [flag, setFlag] = useState('');
  const { data, error, loading } = useApi(`/reports/customers${qs(filters, { q, flag })}`);

  if (!data) return <><ErrorBox error={error} />{!error && <Empty>Loading…</Empty>}</>;
  const s = data.summary;

  return (
    <Loading loading={loading}>
      <PageHeader title="Customers" subtitle={`${n(s.buyers)} buyers on your label PDFs`}>
        <div className="flex flex-wrap gap-2">
          <Input placeholder="Name, city or PIN code" value={q} onChange={(e) => setQ(e.target.value)} className="w-60" />
          <Select value={flag} onChange={(e) => setFlag(e.target.value)} aria-label="Show">
            <option value="">All buyers</option>
            <option value="repeat">Repeat buyers</option>
            <option value="frequentReturner">Frequent returners</option>
            <option value="rtoRisk">RTO risk</option>
            <option value="good">Good customers</option>
          </Select>
        </div>
      </PageHeader>
      <ErrorBox error={error} />
      <Notice>
        Names and addresses come from your label PDFs and stay on this PC: they are not sent to Gemini or anywhere else. Orders known only
        from payment or returns files have no label, so they are not here.
      </Notice>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Repeat buyers" value={n(s.repeatBuyers)} sub={`${n(s.ordersFromRepeatBuyers)} of ${n(s.orders)} orders`} />
        <Stat label="Frequent returners" value={n(s.frequentReturners)} sub={`${n(s.returnsFromFrequentReturners)} of ${n(s.returns)} customer returns`} tone={s.frequentReturners ? 'bad' : undefined} />
        <Stat label="RTO risk" value={n(s.rtoRisk)} sub="an RTO on a COD order, or 2+ RTOs" />
        <Stat label="Buyers" value={n(s.buyers)} sub="same name + PIN code = one buyer" />
      </div>

      {!data.rows.length ? (
        <div className="mt-4"><Empty>No buyers match.</Empty></div>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="data">
            <thead>
              <tr>
                <th>Buyer</th><th>Platforms</th><th className="r">Orders</th><th className="r">Returned</th><th className="r">RTO</th>
                <th className="r">Cancelled</th><th className="r">Return rate</th><th className="r">Profit</th><th>Last order</th><th>Flags</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((b) => (
                <tr key={b.key}>
                  <td>
                    <Link to={buyerPath(b.key)} className="font-medium text-ink underline decoration-line underline-offset-2">{b.name || '(no name)'}</Link>
                    <div className="text-xs text-muted">{[b.city, b.state, b.pincode].filter(Boolean).join(', ')}</div>
                  </td>
                  <td><span className="flex flex-col gap-0.5">{b.platforms.map((p) => <PlatformTag key={p} platform={p} />)}</span></td>
                  <td className="r">{n(b.orders)}</td>
                  <td className={`r ${b.returned ? 'text-bad' : ''}`}>{n(b.returned)}</td>
                  <td className="r">{n(b.rto)}</td>
                  <td className="r">{n(b.cancelled)}</td>
                  <td className="r">{pct(b.returnRate)}</td>
                  <td className="r"><Money paise={b.profit} />{!b.profitKnown && <div className="text-[11px] text-muted">some without cost</div>}</td>
                  <td className="whitespace-nowrap">{b.lastDate ? niceDate(b.lastDate) : '—'}</td>
                  <td><BuyerFlags flags={b.flags} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.total > data.rows.length && <div className="px-4 py-2 text-xs text-muted">Showing {n(data.rows.length)} of {n(data.total)}. Search to narrow it down.</div>}
        </div>
      )}
    </Loading>
  );
}

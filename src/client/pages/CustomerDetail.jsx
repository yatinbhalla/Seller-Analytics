import { Link, useParams } from 'react-router';
import { useApi } from '../lib/api.js';
import { n, niceDate, pct, rs } from '../lib/format.js';
import { Card, Empty, ErrorBox, PageHeader, PlatformTag, Stat, Status } from '../components/ui.jsx';
import BuyerFlags from '../components/BuyerFlags.jsx';

const OUTCOME = {
  kept: { kind: 'good', label: 'Kept' },
  'awaiting payment': { kind: 'info', label: 'Delivered or on its way' },
  returned: { kind: 'bad', label: 'Returned' },
  rto: { kind: 'warn', label: 'RTO' },
  cancelled: { kind: 'info', label: 'Cancelled' },
};

/** One buyer: every order they placed, on any platform, and how each one went. */
export default function CustomerDetail() {
  const { key } = useParams();
  const { data, error } = useApi(`/reports/customers/${encodeURIComponent(key)}`);

  if (!data) return <><ErrorBox error={error} />{!error && <Empty>Loading…</Empty>}</>;
  const delivered = data.orders - data.cancelled;

  return (
    <>
      <div className="mb-2 text-sm"><Link to="/customers" className="text-ink-2 underline">← Customers</Link></div>
      <PageHeader title={data.name || '(no name)'} subtitle={[data.city, data.state, data.pincode].filter(Boolean).join(', ')}>
        <BuyerFlags flags={data.flags} />
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Orders" value={n(data.orders)} sub={`${niceDate(data.firstDate)} – ${niceDate(data.lastDate)}`} />
        <Stat label="Returned" value={n(data.returned)} sub={`${pct(delivered ? data.returned / delivered : 0)} of delivered orders`} tone={data.returned ? 'bad' : undefined} />
        <Stat label="RTO" value={n(data.rto)} sub={`${n(data.codOrders)} COD orders`} />
        <Stat label="Cancelled" value={n(data.cancelled)} />
        <Stat label="Profit from this buyer" value={rs(data.profit)} sub={data.profitKnown ? 'after fees, cost and packaging' : 'part estimated'} tone={data.profit < 0 ? 'bad' : undefined} />
      </div>

      <Card className="mt-4" title="Order history">
        <div className="overflow-x-auto">
          <table className="data">
            <thead>
              <tr><th>Date</th><th>Platform</th><th>Order</th><th>Product</th><th className="r">Amount</th><th>Paid by</th><th>Outcome</th><th className="r">Profit</th><th>Ship-to</th></tr>
            </thead>
            <tbody>
              {data.history.map((o) => {
                const out = OUTCOME[o.outcome] || OUTCOME.kept;
                return (
                  <tr key={o.naturalKey}>
                    <td className="whitespace-nowrap">{o.date ? niceDate(o.date) : '—'}</td>
                    <td><PlatformTag platform={o.platform} /></td>
                    <td className="font-mono text-xs">{o.orderId}{o.awb && <div className="text-muted">AWB {o.awb}</div>}</td>
                    <td>{o.product || o.sku}{o.variant && <div className="text-xs text-muted">{o.variant}</div>}</td>
                    <td className="r">{rs(o.totalPaise)}</td>
                    <td>{o.paymentMode === 'cod' ? 'COD' : o.paymentMode === 'prepaid' ? 'Prepaid' : '—'}</td>
                    <td>
                      <Status kind={out.kind}>{out.label}</Status>
                      {o.reason && <div className="text-xs text-ink-2">{o.reason}</div>}
                    </td>
                    <td className={`r ${o.profitPaise < 0 ? 'text-bad' : ''}`}>{o.profitPaise != null ? rs(o.profitPaise) : '—'}{o.estimated && <div className="text-[11px] text-muted">estimated</div>}</td>
                    <td className="text-xs text-ink-2">{[o.address, o.city].filter(Boolean).join(', ') || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

import { useState } from 'react';
import { Link } from 'react-router';
import { qs, useApi } from '../lib/api.js';
import { buyerPath } from './Customers.jsx';
import { useFilters } from '../lib/filters.jsx';
import { n, niceDate, rs } from '../lib/format.js';
import { Empty, ErrorBox, Input, Loading, Money, PageHeader, PlatformTag, Select, Status, Button } from '../components/ui.jsx';

const PAGE = 200;

export default function Orders() {
  const { filters } = useFilters();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const { data, error, loading } = useApi(`/reports/orders${qs(filters, { q, status, offset, limit: PAGE })}`);

  return (
    <Loading loading={loading}>
      <PageHeader title="Orders" subtitle={data ? `${n(data.count)} order lines` : ''}>
        <div className="flex flex-wrap gap-2">
          <Input placeholder="Order, SKU, product, buyer, city or PIN" value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} className="w-72" />
          <Select value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }} aria-label="Show">
            <option value="">All lines</option>
            <option value="returned">Returned (any)</option>
            <option value="rto">RTO only</option>
            <option value="unsettled">Not paid yet</option>
            <option value="cost_missing">Cost missing</option>
            <option value="repeat_buyer">From repeat buyers</option>
            <option value="frequent_returner">From frequent returners</option>
          </Select>
        </div>
      </PageHeader>
      <ErrorBox error={error} />
      {!data ? null : !data.rows.length ? (
        <Empty>No order lines match.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="data">
            <thead>
              <tr>
                <th>Date</th><th>Platform</th><th>Order</th><th>Buyer</th><th>SKU</th><th>Product</th><th className="r">Qty</th>
                <th className="r">Invoice</th><th className="r">Paid</th><th className="r">Profit</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((o) => (
                <tr key={o.key} title={`Source: ${o.source}`}>
                  <td className="whitespace-nowrap">{niceDate(o.saleDate)}</td>
                  <td><PlatformTag platform={o.platform} /></td>
                  <td className="font-mono text-xs">
                    {o.itemKey.split(':')[0]}
                    {o.linkedVia && <div className="font-sans text-[11px] text-muted" title="This payment or return named the order differently and was matched to its label">matched by {o.linkedVia}</div>}
                  </td>
                  <td><BuyerCell o={o} /></td>
                  <td className="font-mono text-xs">{o.sku}</td>
                  <td>{o.product || <span className="text-bad">Unknown code {o.code}</span>}<div className="text-xs text-muted">{o.variant}</div></td>
                  <td className="r">{o.qty}</td>
                  <td className="r">{rs(o.totalPaise)}{o.lineSource !== 'invoice' && <div className="text-[11px] text-muted">{o.priceEstimated ? 'list price' : 'no invoice'}</div>}</td>
                  <td className="r">{o.paid ? <Money paise={o.payoutPaise} /> : <span className="text-xs text-muted">not paid yet</span>}</td>
                  <td className="r">{!o.paid ? '—' : o.profitPaise == null ? <span className="text-xs text-muted">no cost</span> : <Money paise={o.profitPaise} />}</td>
                  <td>
                    {o.returned ? (
                      <Status kind={o.restocked ? 'info' : 'warn'}>
                        {o.returnType === 'rto' ? 'RTO' : 'Returned'} · {o.returnStatus === 'closed' ? (o.restocked ? 'restocked' : 'closed') : 'in transit'}
                      </Status>
                    ) : (
                      <span className="text-xs text-ink-2">{o.paid ? 'paid' : 'awaiting payment'}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.count > PAGE && (
        <div className="mt-3 flex items-center gap-2 text-sm text-ink-2">
          <Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Newer</Button>
          <span>{offset + 1}–{Math.min(offset + PAGE, data.count)} of {n(data.count)}</span>
          <Button disabled={offset + PAGE >= data.count} onClick={() => setOffset(offset + PAGE)}>Older</Button>
        </div>
      )}
    </Loading>
  );
}

/** The buyer from the label, and how their other orders went. */
function BuyerCell({ o }) {
  if (!o.buyerName) return <span className="text-xs text-muted">{o.pincode || '—'}</span>;
  const b = o.buyer;
  return (
    <div className="min-w-[9rem]">
      {b ? <Link to={buyerPath(b.key)} className="text-ink underline decoration-line underline-offset-2">{o.buyerName}</Link> : o.buyerName}
      <div className="text-xs text-muted">{[o.city, o.pincode].filter(Boolean).join(' ')}{o.paymentMode === 'cod' ? ' · COD' : ''}</div>
      {b && b.orders > 1 && (
        <div className="text-[11px]">
          {b.flags.frequentReturner
            ? <Status kind="bad">{n(b.orders)} orders · {n(b.returned)} returned</Status>
            : <span className="text-ink-2">{n(b.orders)} orders{b.returned ? ` · ${n(b.returned)} returned` : ''}{b.rto ? ` · ${n(b.rto)} RTO` : ''}</span>}
        </div>
      )}
    </div>
  );
}

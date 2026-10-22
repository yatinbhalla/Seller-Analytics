import { useState } from 'react';
import { qs, useApi } from '../lib/api.js';
import { useFilters } from '../lib/filters.jsx';
import { n, pct, rs } from '../lib/format.js';
import { Button, Card, Empty, ErrorBox, Status } from './ui.jsx';

const LEVELS = [
  { key: 'state', label: 'State' },
  { key: 'city', label: 'City' },
  { key: 'pincode', label: 'PIN code' },
  { key: 'zone', label: 'Flipkart zone' },
];

/**
 * Returns by area, from the ship-to on labels. Click a state for its cities, a city
 * for its PIN codes. An area is flagged only with enough orders to mean something.
 */
export default function AreaReturns() {
  const { filters } = useFilters();
  const [drill, setDrill] = useState({ level: 'state', state: '', city: '' });
  const { data, error } = useApi(`/reports/areas${qs(filters, drill)}`);

  const open = (row) => {
    if (drill.level === 'state') setDrill({ level: 'city', state: row.key, city: '' });
    else if (drill.level === 'city') setDrill({ level: 'pincode', state: drill.state, city: row.key });
  };
  const canOpen = drill.level === 'state' || drill.level === 'city';

  return (
    <Card
      className="mt-4"
      title="Returns by area"
      action={
        <span className="flex flex-wrap gap-1">
          {LEVELS.map((l) => (
            <Button key={l.key} variant={drill.level === l.key ? 'primary' : 'ghost'} onClick={() => setDrill({ level: l.key, state: '', city: '' })}>{l.label}</Button>
          ))}
        </span>
      }
    >
      <ErrorBox error={error} />
      {(drill.state || drill.city) && (
        <div className="mb-3 text-sm text-ink-2">
          <button type="button" className="underline" onClick={() => setDrill({ level: 'state', state: '', city: '' })}>All states</button>
          {drill.state && <> › <button type="button" className="underline" onClick={() => setDrill({ level: 'city', state: drill.state, city: '' })}>{drill.state}</button></>}
          {drill.city && <> › {drill.city}</>}
        </div>
      )}
      {!data ? <Empty>Loading…</Empty> : !data.rows.length ? (
        <Empty>No orders with a ship-to address in this range. Areas come from label PDFs.</Empty>
      ) : (
        <>
          <p className="mb-3 text-xs text-ink-2">
            {drill.city ? `Return rate in ${drill.city}` : drill.state ? `Return rate in ${drill.state}` : 'Overall return rate'} {pct(data.total.returnRate)}{' '}
            (customer {pct(data.total.customerReturnRate)}, RTO {pct(data.total.rtoRate)}); areas below are compared with it.
            An area is marked above average only with {data.minOrders}+ orders.
            {data.unknownLines > 0 && <> {n(data.unknownLines)} order lines have no label, so no area.</>}
          </p>
          <div className="overflow-x-auto">
            <table className="data">
              <thead>
                <tr>
                  <th>{LEVELS.find((l) => l.key === drill.level)?.label}</th><th className="r">Orders</th><th className="r">Customer returns</th>
                  <th className="r">RTO</th><th className="r">Return rate</th><th className="r">vs average</th><th className="r">Return cost</th><th>Top reason</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.slice(0, 60).map((r) => (
                  <tr key={r.key}>
                    <td>
                      {canOpen ? <button type="button" className="text-left text-ink underline decoration-line underline-offset-2" onClick={() => open(r)}>{r.key}</button> : r.key}
                      {r.aboveAverage && <div><Status kind="warn">Above average</Status></div>}
                    </td>
                    <td className="r">{n(r.orders)}</td>
                    <td className="r">{n(r.returnsCustomer)}</td>
                    <td className="r">{n(r.returnsRto)}</td>
                    <td className="r">{pct(r.returnRate)}</td>
                    <td className="r">{r.vsAverage != null ? `${r.vsAverage.toFixed(1)}×` : '—'}</td>
                    <td className="r">{rs(r.returnCost)}</td>
                    <td className="text-ink-2">{r.topReason?.reason || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.byPaymentMode.length > 0 && (
            <div className="mt-4">
              <div className="mb-1 text-xs font-medium text-ink-2">Cash on delivery vs prepaid</div>
              <table className="data">
                <thead><tr><th>Paid by</th><th className="r">Orders</th><th className="r">Return rate</th><th className="r">RTO rate</th><th className="r">Return cost</th></tr></thead>
                <tbody>
                  {data.byPaymentMode.map((m) => (
                    <tr key={m.key}>
                      <td>{m.key === 'cod' ? 'COD' : 'Prepaid'}</td><td className="r">{n(m.orders)}</td><td className="r">{pct(m.returnRate)}</td>
                      <td className="r">{pct(m.rtoRate)}</td><td className="r">{rs(m.returnCost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

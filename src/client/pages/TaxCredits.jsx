import { qs, useApi } from '../lib/api.js';
import { useFilters } from '../lib/filters.jsx';
import { n, niceDate, rs } from '../lib/format.js';
import { Card, Empty, ErrorBox, Loading, Notice, PageHeader, PlatformTag, Stat } from '../components/ui.jsx';

/**
 * TCS and TDS the marketplaces held back from your payouts. Not a cost — money you
 * claim back — so it is kept out of profit and shown here instead.
 */
export default function TaxCredits() {
  const { filters } = useFilters();
  const { data, error, loading } = useApi(`/reports/tax-credits${qs(filters)}`);
  if (!data) return <><ErrorBox error={error} />{!error && <Empty>Loading…</Empty>}</>;

  return (
    <Loading loading={loading}>
      <PageHeader
        title="TCS & TDS"
        subtitle="Held back from your payouts and paid to the government against your GSTIN and PAN. You claim it back, so it is not counted as a cost in profit."
      />
      <ErrorBox error={error} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="TCS held back" value={rs(data.tcs, { exact: true })} sub="GST — claim when filing your GST return" />
        <Stat label="TDS held back" value={rs(data.tds, { exact: true })} sub="Income tax — claim in your ITR" />
        <Stat label="Total to claim" value={rs(data.tcs + data.tds + data.unsplit, { exact: true })} sub="in payments made in this range" />
        <Stat label="Still to come" value={rs(data.pendingEstimate, { exact: true })} sub="estimated, on orders not paid yet" />
      </div>

      <Notice>
        <b>TCS</b> (0.5% of the taxable value) shows on the GST portal as TCS credit received — accept it there and it goes to your
        electronic cash ledger. <b>TDS</b> (0.1%, section 194-O) shows in Form 26AS / AIS and is claimed in your income tax return.
        Check both against these figures each month.
      </Notice>

      <Card className="mt-4" title="By month of payment">
        {!data.months.length ? (
          <Empty>No TCS or TDS in payments made in this range.</Empty>
        ) : (
          <table className="data">
            <thead>
              <tr><th>Month</th><th>Platform</th><th className="r">TCS</th><th className="r">TDS</th><th className="r">Total</th><th className="r">Payments</th></tr>
            </thead>
            <tbody>
              {data.months.map((m) => (
                <tr key={`${m.month}-${m.platform}`}>
                  <td>{m.month}</td>
                  <td><PlatformTag platform={m.platform} /></td>
                  <td className="r">{rs(m.tcs, { exact: true })}</td>
                  <td className="r">{rs(m.tds, { exact: true })}</td>
                  <td className="r font-medium">{rs(m.tcs + m.tds + (m.unsplit || 0), { exact: true })}</td>
                  <td className="r text-ink-2">{n(m.payments)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card className="mt-4" title="By payment">
        {!data.payments.length ? (
          <Empty>None.</Empty>
        ) : (
          <div className="max-h-[28rem] overflow-auto">
            <table className="data">
              <thead>
                <tr><th>Paid on</th><th>Platform</th><th>Payment ref (NEFT / UTR)</th><th className="r">Order lines</th><th className="r">TCS</th><th className="r">TDS</th></tr>
              </thead>
              <tbody>
                {data.payments.map((p) => (
                  <tr key={`${p.payment_date}-${p.platform}-${p.settlement_ref}`}>
                    <td className="whitespace-nowrap">{niceDate(p.payment_date)}</td>
                    <td><PlatformTag platform={p.platform} /></td>
                    <td className="font-mono text-xs">{p.settlement_ref || '—'}</td>
                    <td className="r">{n(p.lines)}</td>
                    <td className="r">{rs(p.tcs, { exact: true })}</td>
                    <td className="r">{rs(p.tds, { exact: true })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </Loading>
  );
}

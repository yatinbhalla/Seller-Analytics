import { Link } from 'react-router';
import { useApi } from '../lib/api.js';
import { n, niceDate, platformLabel, rs } from '../lib/format.js';
import { Card, Empty, ErrorBox, Loading, PageHeader, PlatformTag, Status } from '../components/ui.jsx';

/** Everything that would make a number wrong or incomplete, so it is fixed before it is believed. */
export default function DataHealth() {
  const { data, error, loading } = useApi('/reports/health');
  if (!data) return <><ErrorBox error={error} />{!error && <Empty>Loading…</Empty>}</>;

  return (
    <Loading loading={loading}>
      <PageHeader title="Data health" subtitle={`${n(data.duplicatesPrevented)} duplicate rows skipped so far — re-uploading overlapping files is safe.`} />
      <ErrorBox error={error} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Database">
          {data.integrity.ok ? <Status kind="good">Integrity check passed</Status> : <Status kind="bad">Integrity check FAILED — restore a backup in Settings before importing</Status>}
        </Card>

        <Card title="Last uploads">
          {!data.lastUploads.length ? <Empty>Nothing imported yet. <Link to="/import" className="text-series underline">Import files</Link></Empty> : (
            <table className="data">
              <thead><tr><th>File type</th><th className="r">Files</th><th>Last committed</th><th>Data up to</th></tr></thead>
              <tbody>
                {data.lastUploads.map((u) => (
                  <tr key={u.kind}><td>{u.kind}</td><td className="r">{n(u.files)}</td><td>{niceDate(u.last_committed)}</td><td>{niceDate(u.covers_to)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          {data.missingInvoiceDays.map((m) => m.days.length > 0 && (
            <div key={m.platform} className="mt-2">
              <Status kind="warn">{platformLabel(m.platform)}: no invoices on {m.days.map((d) => niceDate(d)).join(', ')} — a missed upload, or no sales?</Status>
            </div>
          ))}
        </Card>

        <Issue title="SKU codes never seen before" count={data.unknownCodes.length} fix={<Link to="/settings" className="text-series underline">Add them in Settings → Products & Costs</Link>}>
          <table className="data"><tbody>{data.unknownCodes.map((c) => <tr key={c.code}><td className="font-mono text-xs">{c.code}</td><td className="font-mono text-xs text-muted">{c.example_sku}</td><td className="r">{n(c.seen)} rows</td></tr>)}</tbody></table>
        </Issue>

        <Issue title="Codes without a cost price" count={data.codesWithoutCost.length} fix="Their profit is left out until a cost is set.">
          <div className="font-mono text-xs">{data.codesWithoutCost.map((c) => c.display_code).join(', ')}</div>
        </Issue>

        <Issue title={`Returns still open after ${data.staleReturns.days} days`} count={data.staleReturns.count} fix="Possibly lost in transit — check with the courier and raise a claim.">
          <table className="data">
            <tbody>
              {data.staleReturns.rows.slice(0, 50).map((r) => (
                <tr key={`${r.platform}-${r.return_key}`}><td><PlatformTag platform={r.platform} /></td><td className="font-mono text-xs">{r.sku}</td><td>{r.return_type === 'rto' ? 'RTO' : 'Customer'}</td><td>{niceDate(r.created_date)}</td><td className="text-ink-2">{r.raw_status}</td></tr>
              ))}
            </tbody>
          </table>
        </Issue>

        <Issue title={`Shipped more than ${data.unpaid.days} days ago, not paid`} count={data.unpaid.count} fix="Upload the latest payment file; if they are still unpaid, raise a ticket.">
          <table className="data">
            <tbody>
              {data.unpaid.rows.slice(0, 50).map((r) => (
                <tr key={`${r.platform}-${r.order_item_key}`}><td><PlatformTag platform={r.platform} /></td><td className="font-mono text-xs">{r.order_item_key}</td><td>{niceDate(r.sale_date)}</td><td className="r">{rs(r.total_paise)}</td></tr>
              ))}
            </tbody>
          </table>
        </Issue>

        <Issue title="Payments for orders with no invoice uploaded" count={data.paymentsWithoutInvoice.count} fix="These orders are in every report (their GST is estimated) but they do not take stock off the shelf. That is right for orders shipped before your opening stock count; for anything shipped after it, upload that day's invoice PDF.">
          <table className="data">
            <tbody>
              {data.paymentsWithoutInvoice.rows.slice(0, 50).map((r, i) => (
                <tr key={i}><td><PlatformTag platform={r.platform} /></td><td className="font-mono text-xs">{r.order_item_key}</td><td>{niceDate(r.payment_date)}</td><td className="r">{rs(r.net_paise)}</td></tr>
              ))}
            </tbody>
          </table>
        </Issue>

        <Issue title="Mixed packs waiting for a stock recipe" count={data.recipeTodo.length} fix={<Link to="/settings" className="text-series underline">Settings → Pack recipes</Link>}>
          <ul className="text-sm">{data.recipeTodo.map((t) => <li key={t.code}><span className="font-mono text-xs">{t.code}</span> — {t.reason}</li>)}</ul>
        </Issue>

        <Issue title="Assumed old-code mappings to confirm" count={data.unconfirmedAliases.length} fix={<Link to="/settings" className="text-series underline">Settings → SKU mapping</Link>}>
          <ul className="text-sm">{data.unconfirmedAliases.map((a) => <li key={a.alias}><span className="font-mono text-xs">{a.alias} → {a.code}</span> <span className="text-muted">{a.note}</span></li>)}</ul>
        </Issue>

        <Issue title="Shelves below zero" count={data.negativeStock.length} fix={<Link to="/inventory" className="text-series underline">Enter an opening count on the Stock page</Link>}>
          <ul className="text-sm">{data.negativeStock.map((s) => <li key={s.stock_item_id}>{s.name}: {n(s.on_hand)}</li>)}</ul>
        </Issue>

        <Issue title="Rows set aside during imports" count={data.rejectedRows.length} fix="They were not imported. Most often a file was edited in Excel and an ID was mangled — download it fresh.">
          <table className="data"><tbody>{data.rejectedRows.slice(0, 50).map((r, i) => <tr key={i}><td className="text-muted">#{r.import_id}</td><td className="max-w-[12rem] truncate">{r.file_name}</td><td>{r.row_no}</td><td className="text-ink-2">{r.reason}</td></tr>)}</tbody></table>
        </Issue>
      </div>
    </Loading>
  );
}

function Issue({ title, count, fix, children }) {
  return (
    <Card title={title} action={count ? <Status kind="warn">{n(count)}</Status> : <Status kind="good">none</Status>}>
      {count ? (
        <>
          <div className="mb-2 text-xs text-ink-2">{fix}</div>
          <div className="max-h-56 overflow-auto">{children}</div>
        </>
      ) : (
        <div className="text-sm text-ink-2">All clear.</div>
      )}
    </Card>
  );
}

import { useParams, Link } from 'react-router';
import { qs, useApi } from '../lib/api.js';
import { useFilters } from '../lib/filters.jsx';
import { n, pct, PLATFORMS, platformLabel, rs } from '../lib/format.js';
import { Card, Empty, ErrorBox, Loading, PageHeader, PlatformTag, Stat } from '../components/ui.jsx';
import { RankBars } from '../components/Charts.jsx';

export default function ProductDetail() {
  const { id } = useParams();
  const { filters } = useFilters();
  const { data, error, loading } = useApi(`/reports/products/${id}${qs(filters)}`);
  if (!data) return <><ErrorBox error={error} />{!error && <Empty>Loading…</Empty>}</>;
  const t = data.total;
  const platforms = PLATFORMS.filter((p) => data.platforms.some((x) => x.platform === p.key));

  return (
    <Loading loading={loading}>
      <div className="mb-1 text-xs text-muted">
        <Link to="/products" className="hover:underline">Products</Link> / {data.product?.category_name}
      </div>
      <PageHeader title={data.product?.name || 'Product'} subtitle={`${n(t.lines)} order lines · ${n(t.units)} units`} />
      <ErrorBox error={error} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Sales" value={rs(t.gmv)} />
        <Stat label="Profit" value={rs(t.profit)} sub={`Margin ${pct(t.margin)}`} tone={t.profit < 0 ? 'bad' : undefined} />
        <Stat label="Profit / unit kept" value={rs(t.profitPerUnit)} />
        <Stat label="Return rate" value={pct(t.returnRate)} sub={`Customer ${pct(t.customerReturnRate)} · RTO ${pct(t.rtoRate)}`} />
        <Stat label="Return cost" value={rs(t.returnCost)} sub={`${pct(t.returnMarginHit)} of net sales`} />
      </div>

      <Card className="mt-4" title="Platforms side by side">
        {!data.platforms.length ? (
          <Empty>No sales in this range.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="data">
              <thead>
                <tr>
                  <th />
                  {data.platforms.map((p) => <th key={p.platform} className="r"><PlatformTag platform={p.platform} /></th>)}
                  <th className="r">All</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ['Order lines', 'lines', n],
                  ['Sales', 'gmv', rs],
                  ['Payout', 'payout', rs],
                  ['Payout / unit', 'payoutPerUnit', rs],
                  ['Profit', 'profit', rs],
                  ['Margin', 'margin', pct],
                  ['Profit / unit kept', 'profitPerUnit', rs],
                  ['Customer return rate', 'customerReturnRate', pct],
                  ['RTO rate', 'rtoRate', pct],
                  ['Return cost', 'returnCost', rs],
                  ['Average discount', 'avgDiscount', pct],
                ].map(([label, key, fmt]) => (
                  <tr key={key}>
                    <td className="text-ink-2">{label}</td>
                    {data.platforms.map((p) => <td key={p.platform} className="r">{fmt(p[key])}</td>)}
                    <td className="r font-medium">{fmt(t[key])}</td>
                  </tr>
                ))}
                <tr>
                  <td className="text-ink-2">Top return reason</td>
                  {data.platforms.map((p) => <td key={p.platform} className="r text-ink-2">{p.topReason?.reason || '—'}</td>)}
                  <td className="r text-ink-2">{t.topReason?.reason || '—'}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="mt-4" title="Pack sizes and variants by platform">
        <div className="overflow-x-auto">
          <table className="data">
            <thead>
              <tr>
                <th>Variant</th>
                <th className="r">Pieces</th>
                {platforms.map((p) => <th key={p.key} className="r" colSpan={3}><PlatformTag platform={p.key} /></th>)}
                <th className="r" colSpan={3}>All</th>
              </tr>
              <tr>
                <th /><th />
                {[...platforms, { key: 'all' }].map((p) => (
                  <FragmentHead key={p.key} />
                ))}
              </tr>
            </thead>
            <tbody>
              {data.variants.map((v) => (
                <tr key={v.id}>
                  <td>{v.label}</td>
                  <td className="r">{v.pack_of}</td>
                  {platforms.map((p) => <Cells key={p.key} m={v.byPlatform[p.key]} />)}
                  <Cells m={v.all} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Return reasons">
          {data.reasons.length ? <RankBars rows={data.reasons} label={(r) => r.reason} value={(r) => r.count} format={n} /> : <Empty>No returns.</Empty>}
          {data.platforms.filter((p) => p.reasons.length).map((p) => (
            <div key={p.platform} className="mt-3 text-xs text-ink-2">
              <PlatformTag platform={p.platform} />: {p.reasons.map((r) => `${r.reason} (${r.count})`).join(', ')}
            </div>
          ))}
        </Card>
        <Card title="Weekly average selling price">
          {!data.priceHistory.length ? <Empty>No sales.</Empty> : (
            <table className="data">
              <thead><tr><th>Week of</th><th>Platform</th><th className="r">Avg price</th><th className="r">Avg discount</th><th className="r">Units</th></tr></thead>
              <tbody>
                {data.priceHistory.slice(-16).reverse().map((w) => (
                  <tr key={`${w.week}-${w.platform}`}>
                    <td>{w.week}</td><td>{platformLabel(w.platform)}</td>
                    <td className="r">{rs(w.avgPricePaise)}</td><td className="r">{pct(w.avgDiscount)}</td><td className="r">{n(w.units)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="SKU codes and list prices">
          <table className="data">
            <thead><tr><th>Code</th><th>Variant</th><th className="r">MRP</th><th className="r">Flipkart</th><th className="r">Meesho</th><th className="r">Listing copies</th></tr></thead>
            <tbody>
              {data.codes.map((c) => (
                <tr key={c.code}>
                  <td className="font-mono text-xs">{c.display_code}</td><td>{c.variant_label}</td>
                  <td className="r">{rs(c.mrp_paise)}</td><td className="r">{rs(c.flipkart_price_paise)}</td><td className="r">{rs(c.meesho_price_paise)}</td>
                  <td className="r">{n(c.listing_copies)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card title={`Listing copies that sold (${data.listings.length})`}>
          {!data.listings.length ? <Empty>None in this range.</Empty> : (
            <div className="max-h-80 overflow-y-auto">
              <table className="data">
                <thead><tr><th>SKU</th><th className="r">Lines</th><th className="r">Returns</th><th className="r">Profit</th></tr></thead>
                <tbody>
                  {data.listings.map((l) => (
                    <tr key={l.sku}><td className="font-mono text-xs">{l.sku}</td><td className="r">{n(l.lines)}</td><td className="r">{n(l.returns)}</td><td className="r">{rs(l.profit)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <Card className="mt-4" title="Stock">
        {!data.stock.length ? <Empty>No stock item.</Empty> : (
          <table className="data">
            <tbody>
              {data.stock.map((s) => (
                <tr key={s.stock_item_id}><td>{s.name}</td><td className={`r ${s.on_hand < 0 ? 'text-bad' : ''}`}>{n(s.on_hand)} pieces</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </Loading>
  );
}

function FragmentHead() {
  return (
    <>
      <th className="r">Lines</th>
      <th className="r">Profit</th>
      <th className="r">Returns</th>
    </>
  );
}

function Cells({ m }) {
  return (
    <>
      <td className="r">{m ? n(m.lines) : '—'}</td>
      <td className={`r ${m?.profit < 0 ? 'text-bad' : ''}`}>{m ? rs(m.profit) : '—'}</td>
      <td className="r">{m ? pct(m.returnRate) : '—'}</td>
    </>
  );
}

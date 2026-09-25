import type { DashboardReport } from '../src/web/view.js';
import { Chart } from './Chart.js';
import { emptyHistoryText, noPayouts, resolvePeriod, tokenPalette } from './model.js';
import type { TokenPalette } from './model.js';
import { ScanMoreButton } from './Refresh.js';

/** The overview when the loaded range holds no payout: what was checked, and Scan more, on the batch before the oldest loaded day,
 * while earlier days remain. It replaces the chart, so an empty chart never shows without it. */
export function EmptyHistory({ report, onMore = () => undefined, canMore = false }: { report: DashboardReport; onMore?: (focus: number) => void; canMore?: boolean }) {
  const text = emptyHistoryText(report.history);
  return <section className="panel empty-history" aria-labelledby="empty-history-title">
    <span className="eyebrow">LOADED HISTORY</span><h2 id="empty-history-title">{text.title}</h2><p>{text.detail}</p>
    {text.earlier ? <ScanMoreButton disabled={!canMore} onMore={() => { onMore(report.history.loadedFrom - 1); }}/> : null}
  </section>;
}

/** The overview tab: one panel for the period the hash names (its attributed figures, the attributed daily chart, the period's
 * token ranking, and verified beneath them or one line). The ranking under the daily chart is the only token list here; the
 * Tokens tab lists every token over all tracked days. */
export function Overview({ report, params = {}, palette, onPeriod = () => undefined, onDay = () => undefined, onTokenPayouts = () => undefined,
  onMore = () => undefined, canMore = false }: {
  report: DashboardReport; params?: Readonly<Record<string, string>>; palette?: TokenPalette; onPeriod?: (params: Record<string, string>) => void;
  onDay?: (day: string, token?: string) => void; onTokenPayouts?: (key: string) => void; onMore?: (focus: number) => void; canMore?: boolean;
}) {
  if (noPayouts(report)) return <EmptyHistory report={report} onMore={onMore} canMore={canMore}/>;
  const { period, notice } = resolvePeriod(report, params);
  const colors = palette ?? tokenPalette(report, period);
  return <>
    <Chart report={report} period={period} notice={notice} palette={colors} onPeriod={onPeriod} onDay={onDay} onTokenPayouts={onTokenPayouts} onMore={canMore ? onMore : null}/>
    <p className="valuation">Current valuation at saved price timestamps. Prices may be stale; these are not historical payout-time values. Unpriced amounts are excluded.</p>
  </>;
}

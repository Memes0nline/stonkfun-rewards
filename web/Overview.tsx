import type { DashboardReport } from '../src/web/view.js';
import { Chart } from './Chart.js';
import { emptyHistoryText, historyStatus, noPayouts, resolvePeriod, tokenPalette } from './model.js';
import type { TokenPalette } from './model.js';
import { EarlierButton } from './Refresh.js';

/** The overview when the loaded range holds no payout: what was checked, and Load earlier while earlier days remain. It replaces
 * the chart, so an empty chart never shows without it. */
export function EmptyHistory({ report, onEarlier = () => undefined, canEarlier = false }: { report: DashboardReport; onEarlier?: () => void; canEarlier?: boolean }) {
  const text = emptyHistoryText(report.history);
  const earlier = historyStatus(report).earlier;
  return <section className="panel empty-history" aria-labelledby="empty-history-title">
    <span className="eyebrow">LOADED HISTORY</span><h2 id="empty-history-title">{text.title}</h2><p>{text.detail}</p>
    {text.earlier && earlier ? <EarlierButton earlier={earlier} disabled={!canEarlier} onEarlier={onEarlier}/> : null}
  </section>;
}

/** The overview tab: one panel for the period the hash names (its attributed figures, the attributed daily chart, the period's
 * token ranking, and verified beneath them or one line). The ranking under the daily chart is the only token list here; the
 * Tokens tab lists every token over all tracked days. */
export function Overview({ report, params = {}, palette, onPeriod = () => undefined, onDay = () => undefined, onTokenPayouts = () => undefined,
  onEarlier = () => undefined, canEarlier = false }: {
  report: DashboardReport; params?: Readonly<Record<string, string>>; palette?: TokenPalette; onPeriod?: (params: Record<string, string>) => void;
  onDay?: (day: string, token?: string) => void; onTokenPayouts?: (key: string) => void; onEarlier?: () => void; canEarlier?: boolean;
}) {
  if (noPayouts(report)) return <EmptyHistory report={report} onEarlier={onEarlier} canEarlier={canEarlier}/>;
  const { period, notice } = resolvePeriod(report, params);
  const colors = palette ?? tokenPalette(report, period);
  return <>
    <Chart report={report} period={period} notice={notice} palette={colors} onPeriod={onPeriod} onDay={onDay} onTokenPayouts={onTokenPayouts}/>
    <p className="valuation">Current valuation at saved price timestamps. Prices may be stale; these are not historical payout-time values. Unpriced amounts are excluded.</p>
  </>;
}

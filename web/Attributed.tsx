import type { DashboardReport } from '../src/web/view.js';
import type { TrustSource } from './model.js';

/** Trust-source badge. Label and explanation are the report's fixed wording; `detailed` shows the explanation beside it. */
export function TrustBadge({ report, source, rows, detailed = false }: { report: DashboardReport; source: TrustSource; rows?: number; detailed?: boolean }) {
  const trust = report.attribution.trustSources[source];
  const chip = <span className={`badge attributed ${source}`} title={detailed ? undefined : trust.explanation}>{trust.label}{rows === undefined ? '' : ` · ${rows.toLocaleString()}`}</span>;
  return detailed ? <div className={`trust-badge ${source}`}>{chip}<p>{trust.explanation}</p></div> : chip;
}
/** The report's explanation for every trust-source badge shown compactly in a table or list. */
export function TrustNotes({ report, sources }: { report: DashboardReport; sources: readonly TrustSource[] }) {
  return sources.length ? <dl className="trust-notes">{sources.map(source => <div key={source}><dt>{report.attribution.trustSources[source].label}</dt><dd>{report.attribution.trustSources[source].explanation}</dd></div>)}</dl> : null;
}

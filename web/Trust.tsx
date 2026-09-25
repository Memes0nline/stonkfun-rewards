import type { DashboardReport } from '../src/web/view.js';
import { TrustBadge } from './Attributed.js';
import { ATTRIBUTION_STATES, attributionState, attributionStateDetail, noun, TRUST_SOURCE_ORDER, trustSourceRows, utc } from './model.js';
import type { TrustSource } from './model.js';
import { Address } from './Sheet.js';

type Identity = NonNullable<DashboardReport['attribution']['identities']>[number];
const when = (time: number | null) => time === null ? 'Unavailable' : utc(time);
const link = (time: number, href: string | null) => href ? <a href={href} target="_blank" rel="noreferrer">{utc(time)} ↗</a> : utc(time);

/** One sending identity under one trust source: its full address, its rows, and the evidence that source rests on. */
function IdentityFacts({ identity, source }: { identity: Identity; source: TrustSource }) {
  const witnesses = identity.witnesses;
  return <li className="identity">
    <Address value={identity.owner ?? 'Unavailable'} label="identity address" link={identity.accountLink}/>
    <dl className="identity-figures">
      <div><dt>Attributed rows</dt><dd>{identity.rows.toLocaleString()}</dd></div>
      <div><dt>Rows through this source</dt><dd>{identity.rowsBySource[source].toLocaleString()}</dd></div>
      <div><dt>Tokens</dt><dd>{identity.tokens.toLocaleString()}</dd></div>
      <div><dt>Receipts span</dt><dd>{when(identity.firstReceiptTime)} → {when(identity.lastReceiptTime)}</dd></div>
    </dl>
    {source === 'feed_witnessed_identity' ? witnesses ? <p className="identity-evidence">
      Witnessed in {witnesses.countMax.toLocaleString()} official StonkFun {noun(witnesses.countMax, 'distribution')} retained here
      {witnesses.countMin !== witnesses.countMax ? ` (${witnesses.countMin.toLocaleString()} when its earliest rows were classified)` : ''} · first {link(witnesses.firstTime, witnesses.firstLink)} · last {link(witnesses.lastTime, witnesses.lastLink)}
    </p> : <p className="identity-evidence muted">No witness recorded on its rows.</p> : null}
    {source === 'published_withdraw_authority' ? identity.snapshots.length ? <ul className="snapshot-list">{identity.snapshots.map(snapshot => <li key={snapshot.retrievedAt}>
      Snapshot retrieved {utc(Date.parse(snapshot.retrievedAt) / 1000)} · taken after the payouts it covers · nearest snapshot for {snapshot.rows.toLocaleString()} {noun(snapshot.rows, 'row')}</li>)}</ul>
      : <p className="identity-evidence muted">No snapshot recorded on its rows.</p> : null}
  </li>;
}

/** Where the attributed numbers come from: the two trust sources in the report's words, the actual identities in full, and conflicts. */
export function Trust({ report }: { report: DashboardReport }) {
  const attribution = report.attribution;
  const state = attributionState(report);
  const identities = attribution.identities;
  const rows = new Map(trustSourceRows(report).map(item => [item.source, item.rows]));
  const both = attribution.basisCounts?.withBothTrustSources ?? 0;
  const conflicts = attribution.conflicts;
  return <>
    <section className="panel trust-panel" aria-labelledby="trust-title">
      <div className="panel-heading"><div><span className="eyebrow group-label">{attribution.label}</span><h2 id="trust-title">Where these numbers come from</h2></div></div>
      <p className="panel-note">{attribution.explanation}</p>
      {state !== 'evaluated' ? <div className="state-box"><strong>{ATTRIBUTION_STATES[state]}</strong><p>{attributionStateDetail(report)}</p></div> : <>
        <p className="trust-summary">{identities
          ? `${(attribution.rows ?? 0).toLocaleString()} attributed ${noun(attribution.rows, 'row')} from ${identities.length.toLocaleString()} sending ${identities.length === 1 ? 'identity' : 'identities'}, each listed in full under the source that trusts it.`
          : 'Identities are listed only when the report carries every attributed row.'}</p>
        <div className="trust-sources">{TRUST_SOURCE_ORDER.map(source => {
          const holders = identities?.filter(identity => identity.trustSources.includes(source)) ?? [];
          return <article key={source} className={`trust-source ${source}`} aria-label={attribution.trustSources[source].label}>
            <TrustBadge report={report} source={source} rows={rows.get(source) ?? 0} detailed/>
            {holders.length ? <ul className="identity-list">{holders.map(identity => <IdentityFacts key={identity.owner ?? 'unavailable'} identity={identity} source={source}/>)}</ul>
              : <p className="muted">No attributed row relies on this source.</p>}
          </article>;
        })}</div>
        <p className="panel-note">{both ? `${both.toLocaleString()} ${both === 1 ? 'row carries' : 'rows carry'} both trust sources; the feed-witnessed source is then primary.` : 'No row carries both trust sources.'}</p>
      </>}
      <div className="panel-foot">Identities print in full because look-alike senders can share their first and last characters · trust is derived only from evidence retained in this database</div>
    </section>
    <section className="panel conflicts-panel" aria-labelledby="conflicts-title">
      <div className="panel-heading"><div><span className="eyebrow">TRUST GATE G6</span><h2 id="conflicts-title">Identity conflicts</h2></div>
        <span className={conflicts.rows ? 'badge unpriced' : 'badge priced'}>{conflicts.rows ? `${conflicts.rows.toLocaleString()} ${noun(conflicts.rows, 'row')} refused` : 'NONE'}</span></div>
      {conflicts.rows === 0 ? <p className="panel-note">None. No row in this report was refused attribution because its sender's identity is conflicted.</p>
        : conflicts.owners === null ? <p className="panel-note">{conflicts.rows.toLocaleString()} {noun(conflicts.rows, 'row')} refused for a conflicted identity; the senders are listed only when the report carries every row.</p>
          : <ul className="identity-list conflicts">{conflicts.owners.map(item => <li key={item.owner ?? 'unavailable'} className="identity">
            {item.owner ? <Address value={item.owner} label="conflicted identity" link={`https://solscan.io/account/${item.owner}`}/> : <span className="muted">Sender unavailable</span>}
            <p className="identity-evidence">{item.rows.toLocaleString()} {noun(item.rows, 'row')} refused · latest {item.lastTime === null ? 'Unavailable' : item.evidenceLink ? link(item.lastTime, item.evidenceLink) : utc(item.lastTime)}</p></li>)}</ul>}
      <p className="panel-note">{conflicts.revokedRows ? `${conflicts.revokedRows.toLocaleString()} ${noun(conflicts.revokedRows, 'row')} fall under a local attribution revocation.` : 'No local attribution revocation applies to any row.'}</p>
    </section>
  </>;
}

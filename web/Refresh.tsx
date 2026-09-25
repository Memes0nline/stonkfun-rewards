import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { primaryLabel, runningElsewhereText, unscannedTitle, UNSCANNED_NOTE } from './model.js';
import type { Health, HistoryStatus } from './model.js';

/** Why refreshing is unavailable, which the button then says; null while it is available. */
export function refreshBlock(health: Health | null, running: boolean): 'offline' | 'running' | null {
  return health?.offline ? 'offline' : running ? 'running' : null;
}
/** The primary button's text: Scan wallet for a wallet with no saved coverage, Check latest data for one with, or why neither is
 * available. It always acts on the wallet in view. */
export function primaryText(block: 'offline' | 'running' | null, busy: boolean, scanned: boolean) {
  return block === 'offline' ? `Offline · ${scanned ? 'refresh' : 'scan'} disabled` : block === 'running' ? 'Scan running…' : busy ? 'Starting…' : primaryLabel(scanned);
}

/** A button's label with the dates its job reads as a second line. */
const twoLines = (label: string, range: string | null | undefined) => range
  ? <><span className="button-label">{label}</span><span className="button-range">{range}</span></> : label;

/** Every tab's content for a wallet with no saved coverage: what the first scan covers, with the same Scan wallet button, which
 * waits while another wallet's job runs. `range` is the button's second line: the days the first scan reads, or while it runs
 * the span it reads. */
export function UnscannedPanel({ wallet, health, running, busy, runningFor = null, range = null, onScan }: {
  wallet: string; health: Health | null; running: boolean; busy: boolean; runningFor?: string | null; range?: string | null; onScan: () => void;
}) {
  const block = refreshBlock(health, running);
  return <section className="unscanned panel" aria-labelledby="unscanned-title">
    <h2 id="unscanned-title">{unscannedTitle(wallet)}</h2>
    <button type="button" className="primary unscanned-button" disabled={block !== null || busy || runningFor !== null} onClick={onScan}
      aria-describedby={runningFor ? 'unscanned-elsewhere' : undefined}>{twoLines(primaryText(block, busy, false), block === 'offline' ? null : range)}</button>
    {runningFor ? <p className="running-elsewhere" id="unscanned-elsewhere">{runningElsewhereText(runningFor)}</p> : null}
    <p>{UNSCANNED_NOTE}</p>
  </section>;
}

/** Scan more outside the header, in Coverage and the empty overview: it opens the Scan more list on the row it concerns. */
export function ScanMoreButton({ disabled, onMore }: { disabled: boolean; onMore: () => void }) {
  return <button type="button" className="more-link" disabled={disabled} onClick={onMore}>Scan more</button>;
}

/** The primary button for the wallet in view, and for a scanned wallet Scan more beside it, the last refresh and the loaded range
 * beneath. Both are disabled while this wallet's scan runs or the server is offline, and, saying so, while another wallet's job
 * runs. `range` is the primary button's second line: the time the next scan reads, or while this wallet's job runs the span it
 * reads. Scan more opens the list of 7-day batches back to the floor; `moreText` is its second line. */
export function RefreshControl({ health, running, busy, scanned = true, runningFor = null, lastRefresh, history = null, range = null, onRefresh, onMore = null,
  moreText = null, children }: {
  health: Health | null; running: boolean; busy: boolean; scanned?: boolean; runningFor?: string | null; lastRefresh: string; history?: HistoryStatus | null;
  range?: string | null; onRefresh: () => void; onMore?: (() => void) | null; moreText?: string | null; children?: ReactNode;
}) {
  const block = refreshBlock(health, running);
  const disabled = block !== null || busy || runningFor !== null;
  const described = [runningFor ? 'running-elsewhere' : '', scanned ? 'last-refresh' : '', history ? 'history-loaded' : ''].filter(Boolean).join(' ');
  return <div className="refresh">
    <div className="refresh-buttons"><button type="button" className="primary refresh-button" disabled={disabled} onClick={onRefresh}
      aria-describedby={described || undefined}>{twoLines(primaryText(block, busy, scanned), block === 'offline' ? null : range)}</button>
    {scanned && onMore ? <button type="button" className="more-button" disabled={disabled} onClick={onMore}>{twoLines('Scan more', moreText)}</button> : null}</div>
    {runningFor ? <span className="running-elsewhere" id="running-elsewhere">{runningElsewhereText(runningFor)}</span> : null}
    {scanned ? <span className="refresh-last" id="last-refresh">Last refresh {lastRefresh}</span> : null}
    {history ? <span className="refresh-floor" id="history-loaded">{history.loaded}</span> : null}
    {children}
  </div>;
}

/**
 * The Helius key form, opened when a scan finds no provider configured, or from the scan dialog after Helius rejected the key. Its
 * lead names what the key is for: scanning a wallet never scanned (`scanned` false), or refreshing one.
 * The key goes to the local server once and is cleared from the page; the browser keeps nothing. Remember (off by default) asks
 * the server to keep it in the ignored .env.
 */
export function KeyForm({ save, close, rejected = false, scanned = true }: {
  save: (key: string, remember: boolean) => Promise<void>; close: () => void; rejected?: boolean; scanned?: boolean;
}) {
  const [key, setKey] = useState('');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    document.addEventListener('keydown', escape); return () => { document.removeEventListener('keydown', escape); };
  }, [close]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!/^[A-Za-z0-9._-]{8,256}$/.test(key.trim())) { setError('Enter the key exactly as Helius shows it: letters, digits, dots, dashes or underscores.'); return; }
    setSaving(true); setError('');
    try { await save(key.trim(), remember); setKey(''); }
    catch (cause) { setError((cause as Error).message); } finally { setSaving(false); }
  };
  return <form className="key-form" role="dialog" aria-label="Helius API key" onSubmit={event => { void submit(event); }} autoComplete="off">
    <p className="key-form-lead">{rejected ? <><b>Helius rejected your API key.</b> Enter the key again, then Retry.</> : <><b>No provider configured.</b> Enter a Helius API key to {scanned ? 'refresh rewards' : 'scan this wallet'}.</>}</p>
    <label className="key-field"><span>Helius API key</span>
      <input ref={input} type="password" name="helius-key" value={key} onChange={event => { setKey(event.target.value); }}
        autoComplete="off" spellCheck={false} aria-invalid={error ? true : undefined}/></label>
    <label className="key-remember"><input type="checkbox" checked={remember} onChange={event => { setRemember(event.target.checked); }}/> Remember on this computer</label>
    <p className="key-note">Kept in the local server's memory until it stops. Remember also writes it to the ignored <code>.env</code> in the scanner folder. The browser stores nothing.</p>
    {error ? <p className="key-error" role="alert">{error}</p> : null}
    <div className="key-actions"><button type="submit" className="primary" disabled={saving || key.trim() === ''}>{saving ? 'Saving…' : 'Save'}</button>
      <button type="button" onClick={close}>Cancel</button></div>
  </form>;
}

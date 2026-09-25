import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { copyText } from './model.js';

/** Copies one value and shows a visible "Copied" state; screen readers hear the same through a status line. */
export function CopyButton({ value, label, text = 'Copy' }: { value: string; label: string; text?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => { setState('idle'); }, 1800);
    return () => { clearTimeout(timer); };
  }, [state]);
  return <>
    <button type="button" className={`copy-button ${state}`} aria-label={`Copy ${label}`} onClick={() => { void copyText(value).then(setState); }}>
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : text}</button>
    <span className="sr-only" role="status">{state === 'copied' ? `${label} copied` : state === 'failed' ? `${label} could not be copied` : ''}</span>
  </>;
}

/** An address printed in full, never abbreviated, with a copy button and an optional Solscan link. */
export function Address({ value, label, link }: { value: string; label: string; link?: string | null }) {
  return <div className="address-row"><code className="address">{value}</code><span className="address-actions"><CopyButton value={value} label={label}/>
    {link ? <a href={link} target="_blank" rel="noreferrer">Solscan ↗</a> : null}</span></div>;
}

/** A modal side drawer or centred dialog; both become full-screen sheets on a phone. Escape, the close button or the backdrop close it. */
export function Sheet({ kind, labelledBy, heading, onClose, children }: {
  kind: 'drawer' | 'modal'; labelledBy: string; heading: ReactNode; onClose: () => void; children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    if (node && !node.open) node.showModal();
    return () => { node?.close(); };
  }, []);
  return <dialog ref={dialog} className={`sheet ${kind}`} aria-labelledby={labelledBy} onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === dialog.current) onClose(); }}>
    <div className="sheet-body">
      <header className="sheet-head"><div className="sheet-title">{heading}</div><button type="button" className="sheet-close" onClick={onClose} aria-label="Close">×</button></header>
      {children}
    </div>
  </dialog>;
}

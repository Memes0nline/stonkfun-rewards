import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { parseRoute, routeHash, TABS } from './model.js';
import type { Route, TabId } from './model.js';

const currentHash = () => typeof window === 'undefined' ? '' : window.location.hash;
/** The route lives in the URL hash. Navigation pushes a history entry without scrolling; Back, Forward and edited hashes are followed. */
export function useRoute() {
  const [route, setRoute] = useState(() => parseRoute(currentHash()));
  useEffect(() => {
    const follow = () => { setRoute(parseRoute(currentHash())); };
    window.addEventListener('hashchange', follow); window.addEventListener('popstate', follow);
    return () => { window.removeEventListener('hashchange', follow); window.removeEventListener('popstate', follow); };
  }, []);
  const navigate = useCallback((next: Route | ((current: Route) => Route), options: { replace?: boolean } = {}) => {
    const hash = routeHash(typeof next === 'function' ? next(parseRoute(currentHash())) : next);
    if (hash !== window.location.hash) history[options.replace ? 'replaceState' : 'pushState'](null, '', hash);
    setRoute(parseRoute(hash));
  }, []);
  return [route, navigate] as const;
}

/** Tabs with a roving tab stop: arrow keys, Home and End move between them and select as they go. */
export function TabBar({ active, select }: { active: TabId; select: (tab: TabId, options?: { replace?: boolean }) => void }) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const index = TABS.findIndex(tab => tab.id === active);
  const move = (event: KeyboardEvent) => {
    const last = TABS.length - 1;
    const next = event.key === 'ArrowRight' ? (index === last ? 0 : index + 1) : event.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
      : event.key === 'Home' ? 0 : event.key === 'End' ? last : null;
    if (next === null) return;
    event.preventDefault(); select(TABS[next]!.id, { replace: true }); buttons.current[next]?.focus();
  };
  return <div className="tabs" role="tablist" aria-label="Dashboard sections" onKeyDown={move}>
    {TABS.map((tab, position) => <button key={tab.id} type="button" role="tab" id={`tab-${tab.id}`} aria-controls={`panel-${tab.id}`}
      aria-selected={tab.id === active} tabIndex={tab.id === active ? 0 : -1} ref={node => { buttons.current[position] = node; }}
      onClick={() => { select(tab.id); }}>{tab.label}</button>)}
  </div>;
}

export function TabPanel({ tab, children }: { tab: TabId; children: ReactNode }) {
  return <section className={`tab-panel panel-${tab}`} role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>{children}</section>;
}

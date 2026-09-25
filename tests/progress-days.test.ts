import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SqliteRewardsStore } from '../src/storage/sqlite.js';
import { DashboardService } from '../src/web/service.js';
import type { DashboardJob } from '../src/web/service.js';
import { createRealProviders } from '../src/providers/real.js';
import { DEMO_CUTOFF, DEMO_WALLET, demoData, demoFetch } from '../src/cli/demo.js';
import { Progress } from '../web/Progress.js';
import { removeTempFolder } from './temp-folder.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const DAY = 86400;

/** The dashboard service over the demo network. Before every provider request it records the wallet's job as the API serves it,
 * so the samples cover each job from its first request to its last, mid-run included. */
function harness() {
  const directory = mkdtempSync(join(tmpdir(), 'progress-days-'));
  const store = new SqliteRewardsStore(join(directory, 'test.sqlite'));
  cleanups.push(() => removeTempFolder(directory), () => { store.close(); });
  let clock = DEMO_CUTOFF * 1000;
  const now = () => { clock += 1000; return clock; };
  const samples: DashboardJob[] = [];
  const fixture = demoFetch(demoData(), now);
  const record = { on: (job: DashboardJob | null) => { if (job) samples.push(job); } };
  const service: DashboardService = new DashboardService({ store: () => store, now, prepareProviders: () => (job, signal) => createRealProviders({
    store, job, apiKey: 'synthetic-progress-key', now, signal, retry: { retries: 3, baseMs: 0, maxMs: 0, jitter: 0 },
    fetch: (input, init) => { record.on(service.job(DEMO_WALLET)); return fixture(input, init); } }) });
  cleanups.push(() => service.shutdown());
  return { service, samples, advance(seconds: number) { clock += seconds * 1000; } };
}

/** The progress dialog's two day counts as it renders them: "n of m days done" and the phase meter's "n / m days". */
function dayCounts(job: DashboardJob) {
  const text = renderToStaticMarkup(createElement(Progress, { job, now: job.progress.serverNow, close: () => undefined, action: () => undefined })).replaceAll('<!-- -->', '');
  const done = /(\d+) of (\d+) days? done/.exec(text);
  const meter = /(\d+) \/ (\d+) days</.exec(text);
  return { done: done ? [Number(done[1]), Number(done[2])] : null, meter: meter ? [Number(meter[1]), Number(meter[2])] : null };
}

describe('progress dialog day counts', () => {
  it('agree at every moment of a first scan, a refresh, a Load earlier batch and a rescan', async () => {
    const h = harness();
    const run = async (kind: DashboardJob['kind'], check?: { startTime: number; endTime: number }) => {
      h.samples.length = 0;
      const started = h.service.start(DEMO_WALLET, undefined, kind, check);
      await h.service.settle();
      const finished = h.service.job(started.id)!;
      expect(finished).toMatchObject({ kind, status: 'complete' });
      const samples = [...h.samples.filter(job => job.id === started.id), finished];
      for (const job of samples) {
        const counts = dayCounts(job);
        expect(counts.done).toEqual([job.savedDays.completed, job.savedDays.planned]);
        if (counts.meter) expect(counts.meter).toEqual(counts.done);
        if (job.progress.phaseProgress?.unit === 'days') {
          expect(job.progress.phaseProgress).toEqual({ completed: job.savedDays.completed, total: job.savedDays.planned, unit: 'days' });
        }
      }
      // The meter was on screen with the job part done, the moment the two counts used to differ.
      expect(samples.some(job => job.progress.phaseProgress?.unit === 'days' && job.savedDays.completed > 0 && job.savedDays.completed < job.savedDays.planned)).toBe(true);
      // Every kind completes its pricing phase once; only a rescan skips the lookups.
      expect(finished.progress.completedPhases).toContain('pricing');
      expect(finished.progress.events.some(event => event.action === 'Saved prices kept; a rescan requests none')).toBe(kind === 'check');
      return finished;
    };
    const first = await run('refresh');
    expect(first.batch?.kind).toBe('first');
    h.advance(2 * DAY);
    await run('refresh');
    await run('earlier');
    const cutoffDay = Math.floor(DEMO_CUTOFF / DAY) * DAY;
    const rescan = await run('check', { startTime: cutoffDay - 6 * DAY, endTime: cutoffDay + DAY });
    expect(rescan.checkResult).toMatchObject({ days: 7, checkedDays: 7 });
    expect(rescan.progress.events.filter(event => event.phase === 'pricing').map(event => event.action)).toEqual(['Saved prices kept; a rescan requests none']);
  });
});

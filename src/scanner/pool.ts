/**
 * Runs `work` over `items` with at most `limit` in flight and hands each result to `commit` strictly in item order, as soon
 * as every earlier item has been committed, so what is written never depends on which request finishes first. `admit` runs
 * before an item starts; returning false starts nothing further, as a serial loop's `break` would. When `admit`, `work` or
 * `commit` throws, nothing further starts or commits, in-flight work is awaited, and the error is rethrown. Returns how many
 * items were committed.
 */
export async function orderedPool<T, R>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<R>,
  commit: (result: R, item: T, index: number) => void, admit: (item: T, index: number) => boolean = () => true): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('Invalid pool size');
  const done = new Map<number, R>();
  const running = new Set<Promise<void>>();
  let started = 0;
  let committed = 0;
  let stopped = false;
  let failure: { error: unknown } | undefined;
  const fail = (error: unknown) => { failure ??= { error }; };
  const flush = () => {
    while (!failure && done.has(committed)) {
      const result = done.get(committed)!; done.delete(committed);
      try { commit(result, items[committed]!, committed); committed++; } catch (error) { fail(error); }
    }
  };
  while (true) {
    while (!failure && !stopped && started < items.length && running.size < limit) {
      const index = started;
      try { if (!admit(items[index]!, index)) { stopped = true; break; } } catch (error) { fail(error); break; }
      started++;
      let task: Promise<void>;
      try { task = work(items[index]!, index).then(result => { done.set(index, result); }, fail); } catch (error) { fail(error); break; }
      const tracked: Promise<void> = task.finally(() => { running.delete(tracked); });
      running.add(tracked);
    }
    if (running.size === 0) break;
    await Promise.race(running);
    flush();
  }
  flush();
  if (failure) throw failure.error;
  return committed;
}

import { describe, expect, it } from 'vitest';
import { runPool } from './uploadQueue';

const tick = () => new Promise((r) => setTimeout(r, 1));

describe('runPool', () => {
  it('processes every item (no truncation) with at most 2 running at once', async () => {
    const items = Array.from({ length: 500 }, (_, i) => i);
    const done: number[] = [];
    let active = 0;
    let peak = 0;
    await runPool(items, 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await tick();
      done.push(n);
      active--;
    });
    expect(done).toHaveLength(500);
    expect(new Set(done).size).toBe(500);
    expect(peak).toBe(2);
  });

  it('keeps going after failures, including thrown errors', async () => {
    const done: number[] = [];
    await runPool([1, 2, 3, 4, 5], 2, async (n) => {
      if (n % 2 === 0) throw new Error('boom');
      done.push(n);
    });
    expect(done.sort()).toEqual([1, 3, 5]);
  });

  it('stops starting new items after a stop result, letting running ones finish', async () => {
    const started: number[] = [];
    await runPool([1, 2, 3, 4, 5, 6], 2, async (n) => {
      started.push(n);
      await tick();
      return n === 2 ? 'stop' : 'continue';
    });
    expect(started.length).toBeLessThan(6);
    expect(started).toContain(1);
    expect(started).toContain(2);
  });

  it('stops when aborted', async () => {
    const ctrl = new AbortController();
    const started: number[] = [];
    await runPool([1, 2, 3, 4, 5, 6], 2, async (n) => {
      started.push(n);
      if (n === 2) ctrl.abort();
      await tick();
    }, ctrl.signal);
    expect(started.length).toBeLessThan(6);
  });

  it('handles an empty list', async () => {
    await expect(runPool([], 2, async () => undefined)).resolves.toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { createWorkQueue } from '../src/server/work-queue.js';

describe('bounded work queue', () => {
  it('keeps FIFO order and never exceeds the configured concurrency', async () => {
    const pending = ['one', 'two', 'three', 'four'];
    const started: string[] = [];
    let active = 0;
    let maximumActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queue = createWorkQueue({
      concurrency: 2,
      claim: () => pending.shift(),
      run: async (id) => {
        started.push(id);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await gate;
        active -= 1;
      }
    });

    queue.wake();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(started).toEqual(['one', 'two']);
    expect(maximumActive).toBe(2);
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await queue.stop();
    expect(started).toEqual(['one', 'two', 'three', 'four']);
    expect(maximumActive).toBe(2);
  });
});

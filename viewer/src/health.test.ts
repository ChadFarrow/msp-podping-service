import { describe, it, expect } from 'vitest';
import { CollectorProgress } from './health';

const T0 = Date.parse('2026-11-04T12:00:00.000Z');

describe('CollectorProgress', () => {
  it('counts from process start until the first block arrives', () => {
    const p = new CollectorProgress(T0);
    expect(p.lagSeconds(T0 + 30_000)).toBe(30);
  });

  it('measures behind the chain from the last block time', () => {
    const p = new CollectorProgress(T0);
    p.record('2026-11-04T12:00:10.000Z');
    expect(p.lagSeconds(T0 + 25_000)).toBe(15);
  });

  // A replay after an outage moves through old blocks: progress, but not current.
  it('reports a replayed old block as lag, not as fresh', () => {
    const p = new CollectorProgress(T0);
    p.record('2026-11-04T11:00:00.000Z');
    expect(p.lagSeconds(T0)).toBe(3600);
  });

  it('never goes negative when the block clock is ahead of this one', () => {
    const p = new CollectorProgress(T0);
    p.record('2026-11-04T12:00:05.000Z');
    expect(p.lagSeconds(T0)).toBe(0);
  });
});

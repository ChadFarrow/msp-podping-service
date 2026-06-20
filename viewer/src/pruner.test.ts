import { describe, it, expect, vi } from 'vitest';
import { runPrune } from './pruner';

describe('runPrune', () => {
  it('calls db.prune with the retention value and returns count', async () => {
    const db = { prune: vi.fn(async () => 7) };
    expect(await runPrune(db as any, 30)).toBe(7);
    expect(db.prune).toHaveBeenCalledWith(30);
  });
  it('passes null through (keep forever)', async () => {
    const db = { prune: vi.fn(async () => 0) };
    expect(await runPrune(db as any, null)).toBe(0);
    expect(db.prune).toHaveBeenCalledWith(null);
  });
});

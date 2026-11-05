/**
 * How far the collector is behind the chain, for /health.
 *
 * It reads the time of the last block stored, not the time a block was seen. A
 * replay after an outage is busy but not current, and a collector retrying a block
 * it can't store isn't advancing at all; both have to count as lag. The viewer sat
 * dead from 2026-08-10 to 2026-09-26 and from 2026-10-10 to 2026-10-23, and nothing
 * said so.
 *
 * Kept in memory on purpose: the check needs no table scan, and a new process starts
 * counting from its own start, so a collector that never gets going still goes stale.
 */
export class CollectorProgress {
  private lastBlockMs: number | null = null;

  constructor(private readonly startedMs: number = Date.now()) {}

  record(blockTimeIso: string): void {
    this.lastBlockMs = Date.parse(blockTimeIso);
  }

  lagSeconds(now: number = Date.now()): number {
    return Math.max(0, Math.round((now - (this.lastBlockMs ?? this.startedMs)) / 1000));
  }
}

import type { Db } from './db';
import type { Config } from './config';

export async function runPrune(db: Pick<Db, 'prune'>, retentionDays: number | null): Promise<number> {
  return db.prune(retentionDays);
}

export function startPruner(cfg: Config, db: Db): void {
  const tick = async () => {
    try {
      const n = await runPrune(db, cfg.retentionDays);
      if (n > 0) console.log(`[pruner] deleted ${n} podpings older than ${cfg.retentionDays} days`);
    } catch (err) {
      console.error('[pruner] error:', err);
    }
  };
  void tick();
  setInterval(tick, 24 * 60 * 60 * 1000);
}

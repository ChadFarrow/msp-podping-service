import { loadConfig } from './config';
import { Db } from './db';
import { startCollector } from './collector';
import { startEnricher } from './enricher';
import { startPruner } from './pruner';
import { buildServer } from './api';
import { registerUi } from './static';
import { join } from 'node:path';

async function main() {
  const cfg = loadConfig(process.env);
  const db = new Db(cfg.databaseUrl);
  await db.migrate();
  console.log('[viewer] migrated; starting workers');

  startCollector(cfg, db);
  startEnricher(cfg, db);
  startPruner(cfg, db);

  const app = buildServer({ db, corsOrigins: cfg.corsOrigins, mspAccount: cfg.mspAccount });
  await registerUi(app, join(__dirname, 'ui'));
  await app.listen({ host: '0.0.0.0', port: cfg.port });
  console.log(`[viewer] API listening on :${cfg.port}`);
}

main().catch((err) => {
  console.error('[viewer] fatal:', err);
  process.exit(1);
});

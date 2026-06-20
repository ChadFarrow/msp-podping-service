import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // DB-backed suites share one local Postgres; run files sequentially so their
    // TRUNCATE/insert/count steps don't interfere across parallel workers.
    fileParallelism: false,
    // The UI subproject has its own toolchain; don't let vitest pick up its files.
    exclude: ['**/node_modules/**', '**/dist/**', 'ui/**'],
  },
});

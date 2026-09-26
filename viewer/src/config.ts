export interface Config {
  databaseUrl: string;
  pi: { key: string; secret: string; userAgent: string };
  retentionDays: number | null;
  rpcNodes: string[];
  rewindBlocks: number;
  /** Past this many blocks behind, skip to the head instead of replaying; null = never skip. */
  maxCatchupBlocks: number | null;
  corsOrigins: string[];
  port: number;
  mspAccount: string | null;
  pgPoolMax: number;
}

const DEFAULT_RPC = [
  'https://api.hive.blog',
  'https://api.deathwing.me',
  'https://hive-api.arcange.eu',
];

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function list(v: string | undefined, fallback: string[]): string[] {
  if (v === undefined || v.trim() === '') return fallback;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const retentionRaw = env.RETENTION_DAYS;
  let retentionDays: number | null;
  if (retentionRaw === undefined) retentionDays = 30;
  else if (retentionRaw.trim() === '' || retentionRaw.trim() === '0') retentionDays = null;
  else retentionDays = Number(retentionRaw);

  // ~24 h of Hive blocks at 3 s each. '' or '0' = always catch up in full.
  const catchupRaw = env.MAX_CATCHUP_BLOCKS;
  let maxCatchupBlocks: number | null;
  if (catchupRaw === undefined) maxCatchupBlocks = 28_800;
  else if (catchupRaw.trim() === '' || catchupRaw.trim() === '0') maxCatchupBlocks = null;
  else maxCatchupBlocks = Number(catchupRaw);

  return {
    databaseUrl: required(env, 'DATABASE_URL'),
    pi: {
      key: required(env, 'PODCASTINDEX_API_KEY'),
      secret: required(env, 'PODCASTINDEX_API_SECRET'),
      userAgent: env.PI_USER_AGENT || 'msp-podping-viewer/1.0',
    },
    retentionDays,
    rpcNodes: list(env.HIVE_RPC_NODES, DEFAULT_RPC),
    rewindBlocks: env.REWIND_BLOCKS ? Number(env.REWIND_BLOCKS) : 200,
    maxCatchupBlocks,
    corsOrigins: list(env.CORS_ORIGINS, []),
    port: env.PORT ? Number(env.PORT) : 8080,
    mspAccount: (env.MSP_ACCOUNT || env.HIVE_ACCOUNT_NAME || 'chadf').trim().toLowerCase() || null,
    // Cap the pg connection pool so backends don't multiply against a low
    // Postgres max_connections. Default matches pg's own default (10).
    pgPoolMax: env.PG_POOL_MAX ? Number(env.PG_POOL_MAX) : 10,
  };
}

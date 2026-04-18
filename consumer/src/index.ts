import { Client, BlockchainMode, Operation, SignedBlock } from '@hiveio/dhive';

const {
  STABLEKRAFT_BASE_URL,
  HIVE_RPC_NODES = 'https://api.hive.blog,https://api.deathwing.me,https://hive-api.arcange.eu',
  HIVE_ACCOUNT_NAME,
  CONSUMER_REWIND_BLOCKS = '200',
  CONSUMER_ENABLED = 'true',
} = process.env;

const baseUrl = (STABLEKRAFT_BASE_URL || '').replace(/\/$/, '');
const mspAccount = (HIVE_ACCOUNT_NAME || '').toLowerCase();
const rewindBlocks = Math.max(0, parseInt(CONSUMER_REWIND_BLOCKS, 10) || 200);
const rpcNodes = HIVE_RPC_NODES.split(',').map(s => s.trim()).filter(Boolean);

const MAX_DEDUP_SIZE = 5000;
const seenTxIds = new Set<string>();

function rememberTxId(txId: string): boolean {
  if (seenTxIds.has(txId)) return false;
  if (seenTxIds.size >= MAX_DEDUP_SIZE) {
    const first = seenTxIds.values().next().value;
    if (first !== undefined) seenTxIds.delete(first);
  }
  seenTxIds.add(txId);
  return true;
}

interface PodpingJson {
  version?: string;
  medium?: string;
  reason?: string;
  iris?: unknown;
  url?: unknown;
  urls?: unknown;
}

function extractIris(raw: string): string[] {
  let payload: PodpingJson;
  try {
    payload = JSON.parse(raw);
  } catch {
    return [];
  }
  const out: string[] = [];
  if (Array.isArray(payload.iris)) {
    for (const x of payload.iris) if (typeof x === 'string') out.push(x);
  }
  if (Array.isArray(payload.urls)) {
    for (const x of payload.urls) if (typeof x === 'string') out.push(x);
  }
  if (typeof payload.url === 'string') out.push(payload.url);
  return out;
}

interface IriMatchQuery {
  url?: string;
  guid?: string;
}

function iriToQuery(iri: string): IriMatchQuery | null {
  // podcast:guid:<guid>
  const guidMatch = iri.match(/^podcast:guid:([0-9a-f-]+)$/i);
  if (guidMatch) return { guid: guidMatch[1] };

  // Plain URL (http/https)
  try {
    const parsed = new URL(iri);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return { url: parsed.toString() };
    }
  } catch {
    return null;
  }
  return null;
}

async function checkExists(q: IriMatchQuery): Promise<boolean> {
  const params = new URLSearchParams();
  if (q.url) params.set('url', q.url);
  if (q.guid) params.set('guid', q.guid);
  const res = await fetch(`${baseUrl}/api/feeds/exists?${params.toString()}`);
  if (!res.ok) throw new Error(`exists ${res.status}`);
  const body = (await res.json()) as { exists?: boolean };
  return Boolean(body.exists);
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  const delays = [0, 2000, 8000];
  let lastErr: unknown;
  for (const delay of delays) {
    if (delay > 0) await sleep(delay);
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
    }
  }
  console.warn(`[consumer] ${label}: giving up after retries:`, lastErr);
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function handleIri(txId: string, iri: string, fromMsp: boolean): Promise<void> {
  const q = iriToQuery(iri);
  if (!q) {
    console.log(`[${txId}] skip unsupported iri: ${iri}`);
    return;
  }

  let exists: boolean;
  try {
    exists = await checkExists(q);
  } catch (err) {
    console.warn(`[${txId}] exists check failed for ${iri}:`, err);
    return;
  }

  if (exists && q.url) {
    const res = await withRetry(`refresh ${iri}`, async () => {
      const r = await postJson('/api/feeds/refresh-by-url', { originalUrl: q.url });
      if (r.status >= 500) throw new Error(`5xx ${r.status}`);
      return r;
    });
    if (res) console.log(`[${txId}] refresh ${res.status} ${iri}`);
    return;
  }

  if (exists && q.guid) {
    // Feed is tracked by GUID, but refresh-by-url needs a URL. Skip — podping should
    // typically carry a URL form if we're meant to refresh. Revisit if this is common.
    console.log(`[${txId}] tracked by guid ${q.guid}, no URL variant in podping; skip refresh`);
    return;
  }

  if (!exists && fromMsp && q.url) {
    const res = await withRetry(`import ${iri}`, async () => {
      const r = await postJson('/api/feeds', { originalUrl: q.url, type: 'album' });
      if (r.status >= 500) throw new Error(`5xx ${r.status}`);
      return r;
    });
    if (res) console.log(`[${txId}] import(msp) ${res.status} ${iri}`);
    return;
  }

  // Untracked, non-MSP → ignore silently (too chatty to log each one).
}

async function processBlock(block: SignedBlock): Promise<void> {
  const txIds = block.transaction_ids;
  const txs = block.transactions;
  for (let i = 0; i < txs.length; i++) {
    const txId = txIds?.[i] || `${block.block_id}-${i}`;
    const ops = txs[i].operations || [];
    for (const op of ops) {
      if (!isCustomJsonMusicPodping(op)) continue;
      const payload = op[1] as {
        required_auths: string[];
        required_posting_auths: string[];
        id: string;
        json: string;
      };
      if (!rememberTxId(txId)) continue;
      const signers = Array.isArray(payload.required_posting_auths)
        ? payload.required_posting_auths.map(s => (typeof s === 'string' ? s.toLowerCase() : ''))
        : [];
      const fromMsp = signers.length > 0 && signers[0] === mspAccount;
      const iris = extractIris(payload.json);
      if (iris.length === 0) {
        console.log(`[${txId}] ${payload.id}: empty iris`);
        continue;
      }
      console.log(
        `[${txId}] ${payload.id} signer=${signers[0] || '?'} ${fromMsp ? '(msp)' : ''} iris=${iris.length}`
      );
      for (const iri of iris) {
        await handleIri(txId, iri, fromMsp);
      }
    }
  }
}

function isCustomJsonMusicPodping(op: Operation): boolean {
  if (op[0] !== 'custom_json') return false;
  const payload = op[1] as { id?: unknown };
  if (typeof payload?.id !== 'string') return false;
  // Temporary smoke-test widening: also log any pp_ podping so we can confirm
  // classification works end-to-end. Narrow back to pp_music_ before deploy.
  if (process.env.CONSUMER_SMOKE_ANY_PP === 'true') {
    return payload.id.startsWith('pp_');
  }
  return payload.id.startsWith('pp_music_');
}

async function main(): Promise<void> {
  const client = new Client(rpcNodes, { failoverThreshold: 3, timeout: 15 * 1000 });

  let lastProcessed = 0;

  while (true) {
    try {
      if (lastProcessed === 0) {
        const props = await client.database.getDynamicGlobalProperties();
        const lib = (props as unknown as { last_irreversible_block_num: number }).last_irreversible_block_num;
        lastProcessed = Math.max(1, lib - rewindBlocks);
      }
      console.log(
        `[consumer] streaming from block ${lastProcessed} (mode=Irreversible, msp=${mspAccount})`
      );
      const stream = client.blockchain.getBlocks({
        from: lastProcessed,
        mode: BlockchainMode.Irreversible,
      });
      let seenBlocks = 0;
      for await (const block of stream) {
        const blockNum = blockNumFromId(block.block_id);
        await processBlock(block);
        if (blockNum) lastProcessed = blockNum + 1;
        seenBlocks++;
        if (seenBlocks % 100 === 0) {
          console.log(`[consumer] processed ${seenBlocks} blocks, head=${blockNum}`);
        }
      }
      console.warn('[consumer] stream ended, reconnecting in 5s');
    } catch (err) {
      console.error('[consumer] stream error, reconnecting in 5s:', err);
    }
    await sleep(5000);
  }
}

function blockNumFromId(blockId: string): number | null {
  // block_id is 40 hex chars, first 8 = block number (big-endian uint32)
  if (typeof blockId !== 'string' || blockId.length < 8) return null;
  const n = parseInt(blockId.slice(0, 8), 16);
  return Number.isFinite(n) ? n : null;
}

// Boot. Required-env issues idle the consumer rather than dying, so a
// missing STABLEKRAFT_BASE_URL doesn't take down the pusher in the same
// container via our wait -n supervision.
function idleForever(reason: string): void {
  console.warn(`[consumer] idling: ${reason}`);
  setInterval(() => undefined, 1 << 30);
}

if (CONSUMER_ENABLED !== 'true') {
  idleForever('CONSUMER_ENABLED != "true"');
} else if (!STABLEKRAFT_BASE_URL) {
  idleForever('STABLEKRAFT_BASE_URL is not set (set it on Railway to enable the consumer)');
} else if (!HIVE_ACCOUNT_NAME) {
  idleForever('HIVE_ACCOUNT_NAME is not set (used for MSP-signer match)');
} else {
  main().catch(err => {
    console.error('[consumer] fatal:', err);
    process.exit(1);
  });
}

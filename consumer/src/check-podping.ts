/**
 * check-podping — answer "was a podping ever broadcast for this feed?"
 *
 * Podping is fire-and-forget: a ping is just a `custom_json` op on Hive, and
 * there is no public index keyed by feed URL/GUID. So to check retroactively we
 * scan Hive history ourselves and grep the podping payloads for the identifier.
 *
 * Two modes:
 *   1. Account-history scan (default, fast): walk the `custom_json` history of a
 *      small set of accounts — the Podcast Index aggregators (podping.aaa..eee)
 *      re-emit pings for feeds they poll, so a tracked feed usually shows up
 *      under one of them. Add your own signer with --accounts.
 *   2. Block-range scan (--blocks N): stream the last N irreversible blocks and
 *      inspect every podping, regardless of signer. Slower, but signer-agnostic.
 *
 * Matching is permissive: a hit is any pp_ op whose JSON contains the GUID
 * (raw or in `podcast:guid:<guid>` form) or any provided URL substring.
 *
 * Usage (run where Hive RPC is reachable — your machine or Railway):
 *   npm run build
 *   node dist/check-podping.js --guid 9fdb6b12-4998-5180-ba8b-3675df9a7140
 *   node dist/check-podping.js --url https://example.com/feed.xml --blocks 100000
 *   node dist/check-podping.js --guid <g> --accounts podping.aaa,myaccount --pages 5
 *
 * Flags:
 *   --guid <guid>        feed GUID to look for (matches raw + podcast:guid: form)
 *   --url <url>          feed URL substring to look for (repeatable)
 *   --accounts a,b,c     accounts to scan in mode 1
 *                        (default: podping.aaa,podping.bbb,podping.ccc,podping.ddd,podping.eee)
 *   --pages N            history pages per account (1000 ops each), default 1
 *   --blocks N           switch to mode 2: scan the last N irreversible blocks
 *   --any                match any pp_ id (default: pp_music_/pp_podcast_ only)
 *
 * Env: HIVE_RPC_NODES (comma-separated), same default as the consumer.
 */
import { Client, BlockchainMode } from '@hiveio/dhive';

const DEFAULT_NODES =
  'https://api.hive.blog,https://api.deathwing.me,https://hive-api.arcange.eu';
const DEFAULT_ACCOUNTS = [
  'podping.aaa',
  'podping.bbb',
  'podping.ccc',
  'podping.ddd',
  'podping.eee',
];

interface Args {
  guid?: string;
  urls: string[];
  accounts: string[];
  pages: number;
  blocks?: number;
  any: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { urls: [], accounts: DEFAULT_ACCOUNTS, pages: 1, any: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--guid':
        out.guid = next().toLowerCase();
        break;
      case '--url':
        out.urls.push(next());
        break;
      case '--accounts':
        out.accounts = next().split(',').map(s => s.trim()).filter(Boolean);
        break;
      case '--pages':
        out.pages = Math.max(1, parseInt(next(), 10) || 1);
        break;
      case '--blocks':
        out.blocks = Math.max(1, parseInt(next(), 10) || 1);
        break;
      case '--any':
        out.any = true;
        break;
      default:
        console.error(`unknown flag: ${a}`);
        process.exit(2);
    }
  }
  return out;
}

function isPodpingId(id: unknown, any: boolean): id is string {
  if (typeof id !== 'string') return false;
  if (any) return id.startsWith('pp_');
  return id.startsWith('pp_music_') || id.startsWith('pp_podcast_');
}

/** True if a podping's JSON string references the target feed. */
function matchesTarget(json: string, args: Args): string | null {
  const hay = json.toLowerCase();
  if (args.guid && hay.includes(args.guid)) return `guid:${args.guid}`;
  for (const u of args.urls) {
    if (hay.includes(u.toLowerCase())) return `url:${u}`;
  }
  return null;
}

interface Hit {
  block: number;
  txId: string;
  timestamp: string;
  signer: string;
  id: string;
  matched: string;
}

function reportHit(h: Hit): void {
  console.log(
    `HIT  block=${h.block} ${h.timestamp} signer=${h.signer} id=${h.id} ${h.matched}\n     trx=${h.txId}`
  );
}

async function scanAccount(client: Client, account: string, args: Args): Promise<Hit[]> {
  const hits: Hit[] = [];
  let start = -1;
  const limit = 1000;
  for (let page = 0; page < args.pages; page++) {
    let history: [number, any][];
    try {
      history = (await client.call('condenser_api', 'get_account_history', [
        account,
        start,
        page === 0 ? limit : Math.min(limit, start),
      ])) as [number, any][];
    } catch (err) {
      console.error(`[${account}] history page ${page} failed:`, (err as Error).message);
      break;
    }
    if (!history || history.length === 0) break;
    for (const [, entry] of history) {
      const op = entry?.op;
      if (!Array.isArray(op) || op[0] !== 'custom_json') continue;
      const data = op[1] || {};
      if (!isPodpingId(data.id, args.any)) continue;
      const matched = matchesTarget(String(data.json || ''), args);
      if (!matched) continue;
      const signers: string[] = Array.isArray(data.required_posting_auths)
        ? data.required_posting_auths
        : Array.isArray(data.required_auths)
          ? data.required_auths
          : [];
      hits.push({
        block: entry.block,
        txId: entry.trx_id,
        timestamp: entry.timestamp,
        signer: signers[0] || account,
        id: data.id,
        matched,
      });
    }
    const lowest = history[0][0];
    if (lowest <= 0) break;
    start = lowest - 1;
  }
  return hits;
}

async function scanBlocks(client: Client, lastN: number, args: Args): Promise<Hit[]> {
  const hits: Hit[] = [];
  const props = await client.database.getDynamicGlobalProperties();
  const head = (props as unknown as { last_irreversible_block_num: number })
    .last_irreversible_block_num;
  const from = Math.max(1, head - lastN);
  console.error(`scanning blocks ${from}..${head} (${head - from} blocks)`);
  let processed = 0;
  const stream = client.blockchain.getBlocks({ from, to: head, mode: BlockchainMode.Irreversible });
  for await (const block of stream) {
    const txIds: string[] = (block as any).transaction_ids || [];
    block.transactions.forEach((tx, i) => {
      for (const op of tx.operations || []) {
        if (op[0] !== 'custom_json') continue;
        const data = op[1] as any;
        if (!isPodpingId(data.id, args.any)) continue;
        const matched = matchesTarget(String(data.json || ''), args);
        if (!matched) continue;
        const signers: string[] = data.required_posting_auths || data.required_auths || [];
        hits.push({
          block: (block as any).block_num ?? parseInt(block.block_id.slice(0, 8), 16),
          txId: txIds[i] || `${block.block_id}-${i}`,
          timestamp: block.timestamp,
          signer: signers[0] || '?',
          id: data.id,
          matched,
        });
      }
    });
    if (++processed % 1000 === 0) console.error(`  ...${processed} blocks scanned`);
  }
  return hits;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.guid && args.urls.length === 0) {
    console.error('error: provide --guid and/or --url to search for');
    process.exit(2);
  }
  const nodes = (process.env.HIVE_RPC_NODES || DEFAULT_NODES)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const client = new Client(nodes, { failoverThreshold: 3, timeout: 15 * 1000 });

  console.error(
    `searching for ${args.guid ? `guid=${args.guid} ` : ''}${args.urls.map(u => `url=${u}`).join(' ')}`.trim()
  );

  let hits: Hit[];
  if (args.blocks) {
    hits = await scanBlocks(client, args.blocks, args);
  } else {
    console.error(`scanning accounts: ${args.accounts.join(', ')} (${args.pages} page(s) each)`);
    hits = [];
    for (const acct of args.accounts) {
      hits.push(...(await scanAccount(client, acct, args)));
    }
  }

  if (hits.length === 0) {
    console.log('\nNo podping found for that feed in the scanned range.');
    console.log('Note: absence here is not proof none was ever sent — widen --pages,');
    console.log('add the publisher\'s own account to --accounts, or use --blocks N.');
    process.exit(1);
  }
  console.log(`\nFound ${hits.length} matching podping(s):`);
  hits.sort((a, b) => a.block - b.block).forEach(reportHit);
}

main().catch(err => {
  console.error('fatal:', err);
  process.exit(1);
});

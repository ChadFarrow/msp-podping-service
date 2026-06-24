/**
 * resolve-feed — turn a podcast:guid (or feed id) into its RSS feed URL via
 * the Podcast Index API.
 *
 * Why this exists: a podcast:guid is a UUIDv5 hash of the feed URL (Podcasting
 * 2.0 spec, namespace ead4c236-bf58-58c6-a2c6-a6b28d128cb6), so it cannot be
 * reversed to a URL locally. The only way to go guid -> URL is a lookup table
 * that already has the mapping; Podcast Index is that table. This also doubles
 * as an "is it in Podcast Index yet?" check: a hit means indexed, no hit means
 * not (yet).
 *
 * Auth uses the standard Podcast Index scheme: Authorization is
 * sha1(apiKey + apiSecret + unixTime), sent with X-Auth-Key and X-Auth-Date.
 *
 * Usage (run where api.podcastindex.org is reachable):
 *   PODCASTINDEX_API_KEY=... PODCASTINDEX_API_SECRET=... \
 *     node dist/resolve-feed.js --guid 9fdb6b12-4998-5180-ba8b-3675df9a7140
 *   ... node dist/resolve-feed.js --feedid 123456
 *   ... node dist/resolve-feed.js --guid <g> --json   # dump the full response
 *
 * On a hit it prints the RSS URL on its own last line so you can pipe/copy it:
 *   FEED_URL  https://...
 * Exit code 0 = found, 1 = not found, 2 = bad usage/missing creds.
 */
import { createHash } from 'node:crypto';

const API_BASE = 'https://api.podcastindex.org/api/1.0';

interface Args {
  guid?: string;
  feedid?: string;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--guid':
        out.guid = next();
        break;
      case '--feedid':
        out.feedid = next();
        break;
      case '--json':
        out.json = true;
        break;
      default:
        console.error(`unknown flag: ${a}`);
        process.exit(2);
    }
  }
  return out;
}

function authHeaders(key: string, secret: string): Record<string, string> {
  const date = Math.floor(Date.now() / 1000).toString();
  const hash = createHash('sha1').update(key + secret + date).digest('hex');
  return {
    'User-Agent': 'msp-podping-service/1.0',
    'X-Auth-Key': key,
    'X-Auth-Date': date,
    Authorization: hash,
  };
}

interface PiFeed {
  id?: number;
  podcastGuid?: string;
  title?: string;
  author?: string;
  url?: string;
  originalUrl?: string;
  medium?: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.guid && !args.feedid) {
    console.error('error: provide --guid <podcast:guid> or --feedid <id>');
    process.exit(2);
  }
  const key = process.env.PODCASTINDEX_API_KEY;
  const secret = process.env.PODCASTINDEX_API_SECRET;
  if (!key || !secret) {
    console.error('error: set PODCASTINDEX_API_KEY and PODCASTINDEX_API_SECRET');
    process.exit(2);
  }

  const url = args.guid
    ? `${API_BASE}/podcasts/byguid?guid=${encodeURIComponent(args.guid)}`
    : `${API_BASE}/podcasts/byfeedid?id=${encodeURIComponent(args.feedid!)}`;

  let res: Response;
  try {
    res = await fetch(url, { headers: authHeaders(key, secret) });
  } catch (err) {
    console.error('request failed:', (err as Error).message);
    process.exit(2);
  }
  const body = (await res.json()) as { status?: unknown; feed?: PiFeed | PiFeed[] };
  if (args.json) {
    console.log(JSON.stringify(body, null, 2));
  }

  // byguid returns feed as an object; some endpoints return an array. Normalize.
  const feed: PiFeed | undefined = Array.isArray(body.feed) ? body.feed[0] : body.feed;
  const found = res.ok && feed && (feed.id || feed.url);
  if (!found) {
    console.log('NOT FOUND in Podcast Index — not indexed yet (or wrong guid).');
    console.log('Get the RSS URL from the source instead: Fountain app -> album ->');
    console.log('share/"Copy RSS feed", or the host (e.g. wavlake.com) directly.');
    process.exit(1);
  }

  console.log(`FOUND in Podcast Index:`);
  console.log(`  feedId : ${feed.id ?? '?'}`);
  console.log(`  title  : ${feed.title ?? '?'}`);
  console.log(`  author : ${feed.author ?? '?'}`);
  console.log(`  medium : ${feed.medium ?? '?'}`);
  console.log(`  guid   : ${feed.podcastGuid ?? '?'}`);
  // Last line, easy to copy/pipe into stablekraft's POST /api/feeds:
  console.log(`FEED_URL  ${feed.url || feed.originalUrl}`);
}

main().catch(err => {
  console.error('fatal:', err);
  process.exit(1);
});

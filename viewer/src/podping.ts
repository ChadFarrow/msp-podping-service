export interface PodpingRecord {
  txId: string;
  opIdx: number;
  blockNum: number;
  ts: string;
  signer: string;
  opId: string;
  medium: string | null;
  reason: string | null;
  iris: string[];
  raw: unknown;
}

export function parseOpId(id: string): { medium: string | null; reason: string | null } {
  const rest = id.startsWith('pp_') ? id.slice(3) : id;
  const parts = rest.split('_').filter(Boolean);
  if (parts.length === 0) return { medium: null, reason: null };
  if (parts.length === 1) return { medium: null, reason: parts[0] };
  return { medium: parts[0], reason: parts.slice(1).join('_') };
}

export function extractIris(json: unknown): string[] {
  if (!json || typeof json !== 'object') return [];
  const j = json as Record<string, unknown>;
  if (Array.isArray(j.iris)) return j.iris.filter((x): x is string => typeof x === 'string');
  if (Array.isArray(j.urls)) return j.urls.filter((x): x is string => typeof x === 'string');
  if (typeof j.url === 'string') return [j.url];
  return [];
}

export function classifyOp(
  op: [string, any],
  ctx: { txId: string; opIdx: number; blockNum: number; ts: string },
): PodpingRecord | null {
  if (op[0] !== 'custom_json') return null;
  const cj = op[1] ?? {};
  const id: string | undefined = cj.id;
  if (!id || !id.startsWith('pp_')) return null;

  let parsed: unknown = {};
  try {
    parsed = typeof cj.json === 'string' ? JSON.parse(cj.json) : cj.json;
  } catch {
    parsed = {};
  }

  const signer =
    (Array.isArray(cj.required_posting_auths) && cj.required_posting_auths[0]) ||
    (Array.isArray(cj.required_auths) && cj.required_auths[0]) ||
    'unknown';

  const { medium, reason } = parseOpId(id);
  return {
    txId: ctx.txId,
    opIdx: ctx.opIdx,
    blockNum: ctx.blockNum,
    ts: ctx.ts,
    signer,
    opId: id,
    medium,
    reason,
    iris: extractIris(parsed),
    raw: cj,
  };
}

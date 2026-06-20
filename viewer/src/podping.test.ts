import { describe, it, expect } from 'vitest';
import { classifyOp, parseOpId, extractIris } from './podping';

const ctx = { txId: 'tx1', opIdx: 0, blockNum: 100, ts: '2026-06-20T00:00:00Z' };

describe('parseOpId', () => {
  it('splits medium and reason', () => {
    expect(parseOpId('pp_music_update')).toEqual({ medium: 'music', reason: 'update' });
    expect(parseOpId('pp_podcast_update')).toEqual({ medium: 'podcast', reason: 'update' });
    expect(parseOpId('pp_publisher_update')).toEqual({ medium: 'publisher', reason: 'update' });
  });
  it('handles multi-word reasons', () => {
    expect(parseOpId('pp_music_liveitem')).toEqual({ medium: 'music', reason: 'liveitem' });
  });
});

describe('extractIris', () => {
  it('reads iris array', () => {
    expect(extractIris({ iris: ['https://a/feed.xml', 'podcast:guid:abc'] }))
      .toEqual(['https://a/feed.xml', 'podcast:guid:abc']);
  });
  it('falls back to urls/url', () => {
    expect(extractIris({ urls: ['https://b/f.xml'] })).toEqual(['https://b/f.xml']);
    expect(extractIris({ url: 'https://c/f.xml' })).toEqual(['https://c/f.xml']);
  });
  it('returns [] for missing/garbage', () => {
    expect(extractIris({})).toEqual([]);
    expect(extractIris(null)).toEqual([]);
  });
});

describe('classifyOp', () => {
  it('builds a record for a pp_ custom_json op', () => {
    const op: [string, any] = ['custom_json', {
      id: 'pp_music_update',
      json: JSON.stringify({ iris: ['https://x/feed.xml'] }),
      required_posting_auths: ['ChadF'],
    }];
    const r = classifyOp(op, ctx)!;
    expect(r.opId).toBe('pp_music_update');
    expect(r.medium).toBe('music');
    expect(r.signer).toBe('ChadF');
    expect(r.iris).toEqual(['https://x/feed.xml']);
    expect(r.txId).toBe('tx1');
  });
  it('ignores non-custom_json ops', () => {
    expect(classifyOp(['transfer', {}], ctx)).toBeNull();
  });
  it('ignores non-pp custom_json ops', () => {
    expect(classifyOp(['custom_json', { id: 'ssc-mainnet-hive', json: '{}' }], ctx)).toBeNull();
  });
  it('uses required_auths when posting auths absent', () => {
    const op: [string, any] = ['custom_json', {
      id: 'pp_podcast_update', json: '{"iris":[]}', required_auths: ['someacct'],
    }];
    expect(classifyOp(op, ctx)!.signer).toBe('someacct');
  });
  it('survives bad JSON by returning a record with empty iris', () => {
    const op: [string, any] = ['custom_json', { id: 'pp_music_update', json: '{bad', required_posting_auths: ['a'] }];
    const r = classifyOp(op, ctx)!;
    expect(r.iris).toEqual([]);
  });
});

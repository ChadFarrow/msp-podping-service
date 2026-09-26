// Run: npm test (compiles, then node --test over dist)
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExistsBody, refreshUrlFor } from './refresh-target.js';

const FEED = 'https://pc2.basspistol.com/mans1/Hip-Hop_Taoists.xml';

test('a URL podping for a tracked feed refreshes that URL', () => {
  assert.equal(refreshUrlFor({ url: FEED }, { exists: true }), FEED);
});

test('a guid podping for a tracked feed refreshes the URL stablekraft returned', () => {
  const answer = parseExistsBody({ exists: true, url: FEED });
  assert.equal(refreshUrlFor({ guid: '89961bdd-7f5c-4772-b59b-d3220929930d' }, answer), FEED);
});

test('a guid podping with no URL in the answer is skipped, as before', () => {
  assert.equal(refreshUrlFor({ guid: 'g' }, parseExistsBody({ exists: true })), null);
});

test('an untracked feed is never refreshed', () => {
  assert.equal(refreshUrlFor({ url: FEED }, { exists: false }), null);
  assert.equal(refreshUrlFor({ guid: 'g' }, parseExistsBody({ exists: false, url: FEED })), null);
});

test('parseExistsBody keeps only http(s) URLs and survives junk', () => {
  assert.deepEqual(parseExistsBody({ exists: true, url: 'javascript:alert(1)' }), { exists: true });
  assert.deepEqual(parseExistsBody({ exists: true, url: 42 }), { exists: true });
  assert.deepEqual(parseExistsBody(null), { exists: false });
  assert.deepEqual(parseExistsBody('nope'), { exists: false });
});

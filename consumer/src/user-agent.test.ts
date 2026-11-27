// Run: npm test (compiles, then node --test over dist)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { APP_NAME, APP_URL, APP_VERSION, USER_AGENT } from './user-agent.js';

const ROOT = join(__dirname, '..');

test('USER_AGENT has the form <AppName>/<version> (+<link>)', () => {
  assert.equal(USER_AGENT, `${APP_NAME}/${APP_VERSION} (+${APP_URL})`);
  assert.match(USER_AGENT, /^[a-z][a-z0-9.-]*\/\d+\.\d+\.\d+ \(\+https:\/\/[^\s()]+\)$/);
  assert.ok(!USER_AGENT.includes('@'));
  assert.doesNotMatch(USER_AGENT, /mozilla|chrome|safari|applewebkit|gecko/i);
});

test('APP_VERSION equals the consumer package.json version', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
  assert.equal(APP_VERSION, pkg.version);
});

test('APP_URL is the public repo over https', () => {
  assert.equal(APP_URL, 'https://github.com/ChadFarrow/msp-podping-service');
});

test('no other User-Agent is written in consumer/src', () => {
  const literal = /['"]user-agent['"]\s*:\s*['"`]|USER_AGENT\s*=\s*['"`]/i;
  const offenders = readdirSync(join(ROOT, 'src'))
    .filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts') && n !== 'user-agent.ts')
    .filter((n) => literal.test(readFileSync(join(ROOT, 'src', n), 'utf8')));
  assert.deepEqual(offenders, []);
});

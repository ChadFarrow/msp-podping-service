import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_NAME, APP_URL, APP_VERSION, USER_AGENT } from './user-agent';
import { loadConfig } from './config';

const base = {
  DATABASE_URL: 'postgres://localhost/x',
  PODCASTINDEX_API_KEY: 'k',
  PODCASTINDEX_API_SECRET: 's',
};

describe('USER_AGENT', () => {
  it('has the form <AppName>/<version> (+<link>)', () => {
    expect(USER_AGENT).toBe(`${APP_NAME}/${APP_VERSION} (+${APP_URL})`);
    expect(USER_AGENT).toMatch(/^[a-z][a-z0-9.-]*\/\d+\.\d+\.\d+ \(\+https:\/\/[^\s()]+\)$/);
    expect(USER_AGENT).not.toContain('@');
    expect(USER_AGENT).not.toMatch(/mozilla|chrome|safari|applewebkit|gecko/i);
  });

  it('carries the viewer package.json version', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string };
    expect(APP_VERSION).toBe(pkg.version);
  });

  it('links the public viewer site', () => {
    expect(APP_URL).toBe('https://pp.musicsideproject.com');
  });

  it('is the Podcast Index default, and PI_USER_AGENT still overrides it', () => {
    expect(loadConfig({ ...base } as any).pi.userAgent).toBe(USER_AGENT);
    expect(loadConfig({ ...base, PI_USER_AGENT: 'Other/2.0' } as any).pi.userAgent).toBe('Other/2.0');
  });
});

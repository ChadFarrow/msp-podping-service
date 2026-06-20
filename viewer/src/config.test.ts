import { describe, it, expect } from 'vitest';
import { loadConfig } from './config';

const base = {
  DATABASE_URL: 'postgres://localhost/x',
  PODCASTINDEX_API_KEY: 'k',
  PODCASTINDEX_API_SECRET: 's',
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig({ ...base } as any);
    expect(c.databaseUrl).toBe('postgres://localhost/x');
    expect(c.retentionDays).toBe(30);
    expect(c.rewindBlocks).toBe(200);
    expect(c.port).toBe(8080);
    expect(c.rpcNodes.length).toBeGreaterThan(0);
    expect(c.corsOrigins).toEqual([]);
    expect(c.pi.userAgent).toContain('msp-podping-viewer');
  });

  it('treats empty RETENTION_DAYS as keep-forever (null)', () => {
    expect(loadConfig({ ...base, RETENTION_DAYS: '' } as any).retentionDays).toBeNull();
    expect(loadConfig({ ...base, RETENTION_DAYS: '0' } as any).retentionDays).toBeNull();
    expect(loadConfig({ ...base, RETENTION_DAYS: '90' } as any).retentionDays).toBe(90);
  });

  it('parses lists and port', () => {
    const c = loadConfig({
      ...base,
      HIVE_RPC_NODES: 'https://a.com, https://b.com',
      CORS_ORIGINS: 'https://musicsideproject.com,https://www.musicsideproject.com',
      PORT: '3001',
    } as any);
    expect(c.rpcNodes).toEqual(['https://a.com', 'https://b.com']);
    expect(c.corsOrigins).toEqual(['https://musicsideproject.com', 'https://www.musicsideproject.com']);
    expect(c.port).toBe(3001);
  });

  it('throws when a required var is missing', () => {
    expect(() => loadConfig({ PODCASTINDEX_API_KEY: 'k', PODCASTINDEX_API_SECRET: 's' } as any))
      .toThrow(/DATABASE_URL/);
  });
});

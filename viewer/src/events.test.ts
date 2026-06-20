import { describe, it, expect } from 'vitest';
import { bus, sseFrame } from './events';

describe('events', () => {
  it('bus relays a podping payload', async () => {
    const got = await new Promise((resolve) => {
      bus.once('podping', resolve);
      bus.emit('podping', { id: 1, signer: 'chadf' });
    });
    expect((got as any).signer).toBe('chadf');
  });

  it('sseFrame serializes as an SSE data frame', () => {
    const frame = sseFrame({ id: 5, opId: 'pp_music_update' } as any);
    expect(frame).toBe('data: {"id":5,"opId":"pp_music_update"}\n\n');
  });
});

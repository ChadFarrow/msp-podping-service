import { EventEmitter } from 'node:events';
import type { PodpingRow } from './db';

export const bus = new EventEmitter();
bus.setMaxListeners(0); // many SSE clients

export function sseFrame(row: PodpingRow): string {
  return `data: ${JSON.stringify(row)}\n\n`;
}

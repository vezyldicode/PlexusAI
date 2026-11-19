import { EventEmitter } from 'node:events';
import { getDb, now } from './db.ts';
import type { PlexusEvent } from '../shared/types.ts';

/** In-process event bus; every event is also persisted (except high-volume log lines). */
class Bus extends EventEmitter {
  emitEvent(type: string, projectId: string | null, data: unknown, persist = true): PlexusEvent {
    let id = 0;
    const createdAt = now();
    if (persist) {
      const r = getDb().prepare('INSERT INTO events (project_id, type, data, created_at) VALUES (?, ?, ?, ?)')
        .run(projectId, type, JSON.stringify(data ?? null), createdAt);
      id = Number(r.lastInsertRowid);
    }
    const ev: PlexusEvent = { id, projectId, type, data, createdAt };
    this.emit('event', ev);
    return ev;
  }
}

export const bus = new Bus();
bus.setMaxListeners(100);

export function recentEvents(projectId: string, limit = 200): PlexusEvent[] {
  const rows = getDb().prepare('SELECT * FROM events WHERE project_id = ? ORDER BY id DESC LIMIT ?').all(projectId, limit) as any[];
  return rows.reverse().map(r => ({ id: r.id, projectId: r.project_id, type: r.type, data: JSON.parse(r.data ?? 'null'), createdAt: r.created_at }));
}

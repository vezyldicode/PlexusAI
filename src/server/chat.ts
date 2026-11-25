// Coordinator chat sessions. Every chat message belongs to exactly one session; system/agent messages raise an
// "unread" mark on the session they were routed to (see routeSession).
import { randomBytes } from 'node:crypto';
import type { ChatSession } from '../shared/types.ts';
import { getDb, now } from './db.ts';
import { bus } from './events.ts';
import { getTask } from './tasks.ts';
import { deleteSessionImages } from './attachments.ts';

const rowToSession = (r: any): ChatSession => ({
  id: r.id, projectId: r.project_id, title: r.title, archived: !!r.archived, unread: r.unread ?? 0,
  cliSessionId: r.cli_session_id ?? null, cliAccountId: r.cli_account_id ?? null, cliSyncedMessageId: r.cli_synced_message_id ?? 0,
  createdAt: r.created_at, updatedAt: r.updated_at,
});

/** Unread = system/agent messages newer than the last time the user looked at the session. */
const SELECT = `SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id AND m.id > s.last_read_message_id AND m.author IN ('system', 'agent')) AS unread FROM chat_sessions s`;

export function getSession(id: string): ChatSession | null {
  const r = getDb().prepare(`${SELECT} WHERE s.id = ?`).get(id);
  return r ? rowToSession(r) : null;
}

export function listSessions(projectId: string, includeArchived = false): ChatSession[] {
  const rows = getDb().prepare(`${SELECT} WHERE s.project_id = ? ${includeArchived ? '' : 'AND s.archived = 0'} ORDER BY s.updated_at DESC, s.created_at DESC`).all(projectId) as any[];
  const out = rows.map(rowToSession);
  if (!out.length && !includeArchived) return [createSession(projectId)];
  return out;
}

export function createSession(projectId: string, title = ''): ChatSession {
  const id = `${projectId}-c${randomBytes(3).toString('hex')}`;
  const t = now();
  getDb().prepare('INSERT INTO chat_sessions (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, projectId, title.trim().slice(0, 80), t, t);
  const s = getSession(id)!;
  bus.emitEvent('chat.session', projectId, s, false);
  return s;
}

export function mustSession(id: string): ChatSession {
  const s = getSession(id);
  if (!s) throw new Error(`no such chat session ${id}`);
  return s;
}

/** The session a message without an explicit one belongs to: the most recently used live session. */
export function defaultSession(projectId: string): ChatSession {
  return listSessions(projectId)[0];
}

export function updateSession(id: string, patch: { title?: string; archived?: boolean }): ChatSession {
  const s = mustSession(id);
  getDb().prepare('UPDATE chat_sessions SET title = ?, archived = ? WHERE id = ?')
    .run(patch.title !== undefined ? patch.title.trim().slice(0, 80) : s.title, (patch.archived ?? s.archived) ? 1 : 0, id);
  const out = getSession(id)!;
  bus.emitEvent('chat.session', s.projectId, out, false);
  return out;
}

export function deleteSession(id: string): void {
  const s = mustSession(id);
  deleteSessionImages(id);
  const db = getDb();
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
  db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(id);
  // Anything that pointed at the session falls back to the project's default routing.
  db.prepare('UPDATE tasks SET origin_session_id = NULL WHERE origin_session_id = ?').run(id);
  db.prepare('UPDATE projects SET control_session_id = NULL WHERE control_session_id = ?').run(id);
  bus.emitEvent('chat.session', s.projectId, { ...s, deleted: true }, false);
}

export function deleteProjectSessions(projectId: string): void {
  for (const s of listSessions(projectId, true)) deleteSessionImages(s.id);
  getDb().prepare('DELETE FROM chat_sessions WHERE project_id = ?').run(projectId);
}

export function markRead(id: string): ChatSession {
  const s = mustSession(id);
  const last = (getDb().prepare('SELECT MAX(id) AS m FROM messages WHERE session_id = ?').get(id) as any)?.m ?? 0;
  getDb().prepare('UPDATE chat_sessions SET last_read_message_id = ? WHERE id = ?').run(last, id);
  const out = getSession(id)!;
  bus.emitEvent('chat.session', s.projectId, out, false);
  return out;
}

export function touchSession(id: string): void {
  getDb().prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(now(), id);
}

/** Name an untitled session after its first user message. */
export function autoTitle(id: string, text: string): void {
  const s = getSession(id);
  if (!s || s.title) return;
  const t = text.replace(/\s+/g, ' ').trim();
  if (t) updateSession(id, { title: t.length > 40 ? t.slice(0, 40).trimEnd() + '…' : t });
}

/** Remember the provider CLI conversation of a session. `null` forgets it (the next turn sends the full history). */
export function setCliSession(id: string, cli: { sessionId: string; accountId: string; syncedMessageId: number } | null): void {
  getDb().prepare('UPDATE chat_sessions SET cli_session_id = ?, cli_account_id = ?, cli_synced_message_id = ? WHERE id = ?')
    .run(cli?.sessionId ?? null, cli?.accountId ?? null, cli?.syncedMessageId ?? 0, id);
}

/** The session that last started/paused/resumed/stopped the project; project-level notices go there. */
export function setControlSession(projectId: string, sessionId: string | null | undefined): void {
  if (!sessionId || !getSession(sessionId)) return;
  getDb().prepare('UPDATE projects SET control_session_id = ? WHERE id = ?').run(sessionId, projectId);
}

/**
 * Where a system/agent message goes, in order:
 * 1. the session that created the task it is about (tasks.origin_session_id, inherited by child tasks),
 * 2. the project's control session (who last started/paused/resumed/stopped it),
 * 3. the most recently used session (created if the project has none).
 */
export function routeSession(projectId: string, meta?: Record<string, unknown> | null): string {
  const live = (id: unknown) => (typeof id === 'string' && id && getSession(id)?.archived === false ? id : null);
  const taskId = typeof meta?.taskId === 'string' ? meta.taskId : null;
  const fromTask = taskId ? live(getTask(taskId)?.originSessionId) : null;
  if (fromTask) return fromTask;
  const ctl = (getDb().prepare('SELECT control_session_id AS c FROM projects WHERE id = ?').get(projectId) as any)?.c;
  return live(ctl) ?? defaultSession(projectId).id;
}

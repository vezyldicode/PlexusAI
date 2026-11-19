import { DatabaseSync } from 'node:sqlite';
import { paths } from './paths.ts';

let db: DatabaseSync | null = null;

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS accounts (
     id TEXT PRIMARY KEY, provider TEXT NOT NULL, label TEXT NOT NULL, home TEXT NOT NULL,
     enabled INTEGER NOT NULL DEFAULT 1, priority INTEGER NOT NULL DEFAULT 10,
     max_concurrency INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'unknown',
     state_reason TEXT, cooldown_until TEXT, quota TEXT, created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS projects (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, goal TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT 'idle', phase TEXT NOT NULL DEFAULT 'new', main_branch TEXT NOT NULL DEFAULT 'main',
     settings TEXT NOT NULL DEFAULT '{}', eval_rounds INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS tasks (
     id TEXT PRIMARY KEY, project_id TEXT NOT NULL, seq INTEGER NOT NULL, title TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '', role TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
     deps TEXT NOT NULL DEFAULT '[]', parent_id TEXT, branch TEXT, worktree TEXT, priority INTEGER NOT NULL DEFAULT 50,
     attempts INTEGER NOT NULL DEFAULT 0, account_id TEXT, last_account_id TEXT, author_account_id TEXT,
     review_cycles INTEGER NOT NULL DEFAULT 0, acceptance TEXT NOT NULL DEFAULT '[]', result TEXT, error TEXT,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project_id, status);
   CREATE TABLE IF NOT EXISTS runs (
     id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, account_id TEXT NOT NULL, started_at TEXT NOT NULL,
     ended_at TEXT, outcome TEXT, classification TEXT, log_path TEXT NOT NULL, exit_code INTEGER);
   CREATE TABLE IF NOT EXISTS messages (
     id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL,
     meta TEXT, created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS events (
     id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, type TEXT NOT NULL, data TEXT, created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS skills (
     name TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 0,
     source TEXT NOT NULL DEFAULT '', path TEXT NOT NULL, created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  // Per-task model override, keyed by provider (set from the swarm network in the UI).
  `ALTER TABLE tasks ADD COLUMN models TEXT NOT NULL DEFAULT '{}';`,
  // Files/directories a task expects to touch, so the scheduler can keep overlapping writers apart.
  `ALTER TABLE tasks ADD COLUMN paths TEXT NOT NULL DEFAULT '[]';`,
];

export function getDb(): DatabaseSync {
  if (db) return db;
  db = new DatabaseSync(paths.db);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)');
  const row = db.prepare('SELECT v FROM schema_version').get() as { v: number } | undefined;
  let v = row?.v ?? 0;
  if (!row) db.prepare('INSERT INTO schema_version (v) VALUES (0)').run();
  for (; v < MIGRATIONS.length; v++) {
    db.exec(MIGRATIONS[v]);
    db.prepare('UPDATE schema_version SET v = ?').run(v + 1);
  }
  return db;
}

export function closeDb(): void {
  db?.close();
  db = null;
}

export const now = (): string => new Date().toISOString();

export function json<T>(s: unknown, fallback: T): T {
  if (typeof s !== 'string' || !s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

export function getSetting<T>(key: string, fallback: T): T {
  const r = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return r ? json(r.value, fallback) : fallback;
}

export function setSetting(key: string, value: unknown): void {
  getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

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
  // Per-task model override, keyed by provider (set from the Plexus network in the UI).
  `ALTER TABLE tasks ADD COLUMN models TEXT NOT NULL DEFAULT '{}';`,
  // Files/directories a task expects to touch, so the scheduler can keep overlapping writers apart.
  `ALTER TABLE tasks ADD COLUMN paths TEXT NOT NULL DEFAULT '[]';`,
  // Per-task reasoning effort override, keyed by provider.
  `ALTER TABLE tasks ADD COLUMN efforts TEXT NOT NULL DEFAULT '{}';`,
  // Coordinator chat sessions: every message belongs to exactly one session. cli_* remember the provider CLI conversation
  // (claude --resume / codex exec resume) so a turn only has to send what is new.
  `CREATE TABLE IF NOT EXISTS chat_sessions (
     id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', archived INTEGER NOT NULL DEFAULT 0,
     last_read_message_id INTEGER NOT NULL DEFAULT 0, cli_session_id TEXT, cli_account_id TEXT, cli_synced_message_id INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS chat_sessions_project ON chat_sessions(project_id);
   ALTER TABLE messages ADD COLUMN session_id TEXT;
   CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, id);
   ALTER TABLE tasks ADD COLUMN origin_session_id TEXT;
   ALTER TABLE projects ADD COLUMN control_session_id TEXT;
   INSERT INTO chat_sessions (id, project_id, title, last_read_message_id, created_at, updated_at)
     SELECT p.id || '-default', p.id, 'Default', COALESCE((SELECT MAX(id) FROM messages m WHERE m.project_id = p.id), 0), p.created_at, p.created_at FROM projects p;
   UPDATE messages SET session_id = project_id || '-default' WHERE project_id IN (SELECT id FROM projects);
   UPDATE projects SET control_session_id = id || '-default';`,
  // Acceptance criterion ids a task serves (from the planner), so its prompt carries only those criteria.
  `ALTER TABLE tasks ADD COLUMN ac_ids TEXT NOT NULL DEFAULT '[]';`,
  // Chat-requested single-agent tasks, and the CLI conversation of a task's last attempt (resumed by fixes/retries).
  `ALTER TABLE tasks ADD COLUMN adhoc INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE tasks ADD COLUMN cli_session_id TEXT;
   ALTER TABLE tasks ADD COLUMN cli_account_id TEXT;`,
  // Tokens per run (normalized, see usage.ts; JSON null = nothing readable), and the last report of each CLI conversation
  // so a resumed turn that reports thread totals (Codex) is counted by its own share.
  `ALTER TABLE runs ADD COLUMN usage TEXT;
   CREATE TABLE IF NOT EXISTS cli_usage (session_id TEXT PRIMARY KEY, usage TEXT NOT NULL, updated_at TEXT NOT NULL);`,
  // Lanes (a task continuing another task's agent), account pins, messages for an agent, and the context size of the
  // last call of a task's CLI conversation (resume only while that is cheaper than starting fresh).
  `ALTER TABLE tasks ADD COLUMN cli_ctx_tokens INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE tasks ADD COLUMN cli_used_at TEXT;
   ALTER TABLE tasks ADD COLUMN pinned_account_id TEXT;
   ALTER TABLE tasks ADD COLUMN lane_from TEXT;
   ALTER TABLE tasks ADD COLUMN inbox TEXT NOT NULL DEFAULT '[]';`,
  // The model and effort a run was started with (what the UI shows as "in use").
  `ALTER TABLE runs ADD COLUMN model TEXT;
   ALTER TABLE runs ADD COLUMN effort TEXT;`,
  // Where a run's time went (startup, model, tools, compaction, waiting), and a conversation a task forks from another
  // working directory (the coordinator's chat, held in the project folder) instead of resuming it in place.
  `ALTER TABLE runs ADD COLUMN timing TEXT;
   ALTER TABLE tasks ADD COLUMN cli_fork_cwd TEXT;`,
  // The account, model and effort a chat session's coordinator stays on (changed only when that account cannot run).
  `ALTER TABLE chat_sessions ADD COLUMN coord_account_id TEXT;
   ALTER TABLE chat_sessions ADD COLUMN coord_model TEXT;
   ALTER TABLE chat_sessions ADD COLUMN coord_effort TEXT;`,
  // Whether that account was picked automatically (the picker shows Automatic) or chosen by the user for this session.
  `ALTER TABLE chat_sessions ADD COLUMN coord_auto INTEGER NOT NULL DEFAULT 1;`,
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

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync, renameSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DEFAULT_PROJECT_SETTINGS, type ChatMessage, type Project, type ProjectSettings, type ProjectStatus } from '../shared/types.ts';
import { getDb, json, now } from './db.ts';
import { bus } from './events.ts';

function rowToProject(r: any): Project {
  return {
    id: r.id, name: r.name, path: r.path, goal: r.goal, status: r.status, phase: r.phase, mainBranch: r.main_branch,
    settings: { ...DEFAULT_PROJECT_SETTINGS, ...json<Partial<ProjectSettings>>(r.settings, {}) }, evalRounds: r.eval_rounds, createdAt: r.created_at,
  };
}

export function listProjects(): Project[] {
  return (getDb().prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as any[]).map(rowToProject);
}

export function getProject(id: string): Project | null {
  const r = getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id);
  return r ? rowToProject(r) : null;
}

export function mustProject(id: string): Project {
  const p = getProject(id);
  if (!p) throw new Error(`no such project ${id}`);
  return p;
}

export function createProject(input: { path: string; name?: string; goal?: string; settings?: Partial<ProjectSettings> }): Project {
  const path = resolve(input.path);
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
  if (!statSync(path).isDirectory()) throw new Error('project path is not a folder');
  const name = input.name?.trim() || basename(path);
  let goal = input.goal?.trim() ?? '';
  if (!goal && existsSync(join(path, 'GOAL.md'))) goal = readFileSync(join(path, 'GOAL.md'), 'utf8').trim();
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'project';
  const id = `${slug}-${randomBytes(2).toString('hex')}`;
  getDb().prepare('INSERT INTO projects (id, name, path, goal, settings, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, name, path, goal, JSON.stringify({ ...DEFAULT_PROJECT_SETTINGS, ...input.settings }), now());
  mkdirSync(memoryDir(getProject(id)!), { recursive: true });
  const p = getProject(id)!;
  writeMemory(p, 'goal.md', goal);
  bus.emitEvent('project.created', id, p);
  return p;
}

export function updateProject(id: string, patch: Partial<Pick<Project, 'name' | 'goal' | 'phase' | 'mainBranch' | 'evalRounds'>> & { settings?: Partial<ProjectSettings> }): Project {
  const p = mustProject(id);
  const settings = { ...p.settings, ...patch.settings };
  getDb().prepare('UPDATE projects SET name = ?, goal = ?, phase = ?, main_branch = ?, eval_rounds = ?, settings = ? WHERE id = ?')
    .run(patch.name ?? p.name, patch.goal ?? p.goal, patch.phase ?? p.phase, patch.mainBranch ?? p.mainBranch, patch.evalRounds ?? p.evalRounds, JSON.stringify(settings), id);
  if (patch.goal !== undefined) writeMemory(p, 'goal.md', patch.goal);
  const out = mustProject(id);
  bus.emitEvent('project.updated', id, out, patch.phase !== undefined && patch.phase !== p.phase);
  return out;
}

export function setProjectStatus(id: string, status: ProjectStatus): Project {
  getDb().prepare('UPDATE projects SET status = ? WHERE id = ?').run(status, id);
  const p = mustProject(id);
  bus.emitEvent('project.status', id, { status });
  return p;
}

export function deleteProject(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM tasks WHERE project_id = ?').run(id);
  db.prepare('DELETE FROM messages WHERE project_id = ?').run(id);
  db.prepare('DELETE FROM events WHERE project_id = ?').run(id);
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
}

// ---------------- memory (lives in the project: <project>/.plexus/memory) ----------------

export function plexusDir(p: Project): string {
  const dir = join(p.path, '.plexus'), legacy = join(p.path, '.swarm'); // folder name before the rename
  if (!existsSync(dir) && existsSync(legacy)) renameSync(legacy, dir);
  return dir;
}
export const memoryDir = (p: Project) => join(plexusDir(p), 'memory');
export const MEMORY_FILES = ['goal.md', 'brief.md', 'acceptance.md', 'decisions.md', 'directives.md', 'known-issues.md', 'planning-notes.md'] as const;

export function readMemory(p: Project, file: string): string {
  const f = join(memoryDir(p), file);
  return existsSync(f) ? readFileSync(f, 'utf8') : '';
}

export function writeMemory(p: Project, file: string, content: string): void {
  if (!/^[a-z0-9.-]+$/i.test(file)) throw new Error('bad memory file name');
  mkdirSync(memoryDir(p), { recursive: true });
  writeFileSync(join(memoryDir(p), file), content.endsWith('\n') || !content ? content : content + '\n');
  bus.emitEvent('memory.updated', p.id, { file }, false);
}

export function appendMemory(p: Project, file: string, content: string): void {
  mkdirSync(memoryDir(p), { recursive: true });
  appendFileSync(join(memoryDir(p), file), content.endsWith('\n') ? content : content + '\n');
  bus.emitEvent('memory.updated', p.id, { file }, false);
}

export interface AcceptanceItem { id: string; criterion: string; verify: string; pass?: boolean | null; evidence?: string }

export function readAcceptance(p: Project): AcceptanceItem[] {
  return json<AcceptanceItem[]>(readMemory(p, 'acceptance.json'), []);
}

export function writeAcceptance(p: Project, items: AcceptanceItem[]): void {
  writeMemory(p, 'acceptance.json', JSON.stringify(items, null, 2));
  writeMemory(p, 'acceptance.md', '# Acceptance criteria\n\n' + items.map(a =>
    `- [${a.pass ? 'x' : ' '}] **${a.id}** ${a.criterion}${a.verify ? ` — verify: ${a.verify}` : ''}${a.evidence ? `\n  - evidence: ${a.evidence}` : ''}`).join('\n'));
}

export function recordDecision(p: Project, d: { title: string; decision: string; rationale?: string }, by: string): void {
  appendMemory(p, 'decisions.md', `\n## ${d.title}\n- Decision: ${d.decision}\n${d.rationale ? `- Rationale: ${d.rationale}\n` : ''}- By: ${by} · ${now()}\n`);
}

// ---------------- chat ----------------

export function postMessage(projectId: string, author: ChatMessage['author'], text: string, meta: Record<string, unknown> | null = null): ChatMessage {
  const r = getDb().prepare('INSERT INTO messages (project_id, author, text, meta, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(projectId, author, text, meta ? JSON.stringify(meta) : null, now());
  const m = getMessage(Number(r.lastInsertRowid))!;
  bus.emitEvent('chat.message', projectId, m, false);
  return m;
}

export function getMessage(id: number): ChatMessage | null {
  const r = getDb().prepare('SELECT * FROM messages WHERE id = ?').get(id) as any;
  return r ? { id: r.id, projectId: r.project_id, author: r.author, text: r.text, meta: json(r.meta, null), createdAt: r.created_at } : null;
}

export function updateMessageMeta(id: number, meta: Record<string, unknown>): void {
  getDb().prepare('UPDATE messages SET meta = ? WHERE id = ?').run(JSON.stringify(meta), id);
  const m = getMessage(id);
  if (m) bus.emitEvent('chat.updated', m.projectId, m, false);
}

export function listMessages(projectId: string, limit = 300): ChatMessage[] {
  const rows = getDb().prepare('SELECT * FROM messages WHERE project_id = ? ORDER BY id DESC LIMIT ?').all(projectId, limit) as any[];
  return rows.reverse().map(r => ({ id: r.id, projectId: r.project_id, author: r.author, text: r.text, meta: json(r.meta, null), createdAt: r.created_at }));
}

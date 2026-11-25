import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync, renameSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DEFAULT_PROJECT_SETTINGS, type ChatMessage, type Decision, type Project, type ProjectSettings, type ProjectStatus } from '../shared/types.ts';
import { getDb, json, now } from './db.ts';
import { deleteProjectSessions, touchSession, routeSession } from './chat.ts';
import { bus } from './events.ts';
import { cleanProjectSettings, projectDefaults } from './config.ts';
import { listTasks } from './tasks.ts';
import { deleteTaskImages } from './attachments.ts';

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
    .run(id, name, path, goal, JSON.stringify({ ...projectDefaults(), ...cleanProjectSettings((input.settings ?? {}) as Record<string, unknown>) }), now());
  mkdirSync(memoryDir(getProject(id)!), { recursive: true });
  const p = getProject(id)!;
  writeMemory(p, 'goal.md', goal);
  bus.emitEvent('project.created', id, p);
  return p;
}

export function updateProject(id: string, patch: Partial<Pick<Project, 'name' | 'goal' | 'phase' | 'mainBranch' | 'evalRounds'>> & { settings?: Partial<ProjectSettings> }): Project {
  const p = mustProject(id);
  const settings = { ...p.settings, ...cleanProjectSettings((patch.settings ?? {}) as Record<string, unknown>) };
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
  for (const t of listTasks(id)) deleteTaskImages(t.id);
  db.prepare('DELETE FROM tasks WHERE project_id = ?').run(id);
  db.prepare('DELETE FROM messages WHERE project_id = ?').run(id);
  deleteProjectSessions(id);
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
export const MEMORY_FILES = ['goal.md', 'summary.md', 'brief.md', 'acceptance.md', 'decisions.md', 'directives.md', 'known-issues.md', 'planning-notes.md', 'codemap.md', 'open-gaps.md'] as const;

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

/** `pass: 'blocked'`: cannot be checked in this environment (needs an install, a person or a decision). */
export interface AcceptanceItem { id: string; criterion: string; verify: string; pass?: boolean | 'blocked' | null; evidence?: string; needs?: string }

export const acMark = (a: Pick<AcceptanceItem, 'pass'>) => (a.pass === true ? 'x' : a.pass === 'blocked' ? '~' : ' ');

export function readAcceptance(p: Project): AcceptanceItem[] {
  return json<AcceptanceItem[]>(readMemory(p, 'acceptance.json'), []);
}

export function writeAcceptance(p: Project, items: AcceptanceItem[]): void {
  writeMemory(p, 'acceptance.json', JSON.stringify(items, null, 2));
  writeMemory(p, 'acceptance.md', '# Acceptance criteria\n\n' + items.map(a =>
    `- [${acMark(a)}] **${a.id}** ${a.criterion}${a.verify ? ` — verify: ${a.verify}` : ''}${a.pass === 'blocked' ? ` — blocked${a.needs ? ` (needs ${a.needs})` : ''}` : ''}${a.evidence ? `\n  - evidence: ${a.evidence}` : ''}`).join('\n'));
}

/** Add known issues, skipping ones already recorded (same text apart from the task tag and spacing). */
export function appendIssues(p: Project, tag: string, issues: string[]): number {
  const norm = (l: string) => l.replace(/^-\s*/, '').replace(/^\[T\d+\]\s*/, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const seen = new Set(readMemory(p, 'known-issues.md').split('\n').map(norm).filter(Boolean));
  const fresh = issues.map(i => i.trim()).filter(i => i && !seen.has(norm(i)) && (seen.add(norm(i)), true));
  if (fresh.length) appendMemory(p, 'known-issues.md', fresh.map(i => `- ${tag ? `[${tag}] ` : ''}${i}`).join('\n'));
  return fresh.length;
}

/** Remove the directives (lines of directives.md) whose text contains `match`, case-insensitive. Returns the removed lines. */
export function removeDirectives(p: Project, match: string): string[] {
  const m = match.trim().toLowerCase();
  if (!m) return [];
  const lines = readMemory(p, 'directives.md').split('\n');
  const gone = lines.filter(l => l.trim().startsWith('-') && l.toLowerCase().includes(m));
  if (gone.length) writeMemory(p, 'directives.md', lines.filter(l => !gone.includes(l)).join('\n').replace(/\n{3,}/g, '\n\n'));
  return gone;
}

// ---------------- hand-off notes (kept after a task's worktree is gone) ----------------

export const handoffDir = (p: Project) => join(memoryDir(p), 'handoff');

/** Keep what an agent wrote in progress.md (and its result summary) beyond its worktree, for whoever continues. */
export function writeHandoff(p: Project, taskShort: string, text: string): void {
  if (!/^T\d+$/.test(taskShort) || !text.trim()) return;
  mkdirSync(handoffDir(p), { recursive: true });
  const body = text.length > 20_000 ? '…(earlier notes omitted)\n' + text.slice(-20_000) : text;
  writeFileSync(join(handoffDir(p), `${taskShort}.md`), body);
}

export function readHandoff(p: Project, taskShort: string): string {
  const f = join(handoffDir(p), `${taskShort}.md`);
  return existsSync(f) ? readFileSync(f, 'utf8') : '';
}

export interface DecisionEntry extends Decision { by: string; at: string }

function decisionMd(d: Decision & { by?: string; at?: string }): string {
  const scope = [d.paths?.length ? `paths: ${d.paths.join(', ')}` : '', d.ac_ids?.length ? `ACs: ${d.ac_ids.join(', ')}` : ''].filter(Boolean).join(' · ');
  const lines = [`## ${d.title}`, `- Decision: ${d.decision}`];
  if (d.rationale) lines.push(`- Rationale: ${d.rationale}`);
  if (scope) lines.push(`- Scope: ${scope}`);
  if (d.by || d.at) lines.push(`- By: ${[d.by, d.at].filter(Boolean).join(' · ')}`);
  return '\n' + lines.join('\n') + '\n';
}

export function recordDecision(p: Project, d: { title: string; decision: string; rationale?: string; paths?: string[]; ac_ids?: string[] }, by: string): void {
  appendMemory(p, 'decisions.md', decisionMd({ rationale: '', paths: [], ac_ids: [], ...d, by, at: now() }));
}

/** Parse decisions.md back into entries (the format written by recordDecision; unknown lines are kept in the decision text). */
export function parseDecisions(md: string): DecisionEntry[] {
  const out: DecisionEntry[] = [];
  for (const block of ('\n' + md).split(/\n## /).slice(1)) {
    const [title, ...lines] = block.split('\n');
    const e: DecisionEntry = { title: title.trim(), decision: '', rationale: '', paths: [], ac_ids: [], by: '', at: '' };
    const extra: string[] = [];
    for (const l of lines) {
      const m = l.match(/^- (Decision|Rationale|Scope|By): (.*)$/);
      if (!m) { if (l.trim()) extra.push(l.trim()); continue; }
      if (m[1] === 'Decision') e.decision = m[2];
      else if (m[1] === 'Rationale') e.rationale = m[2];
      else if (m[1] === 'By') { const [by, at] = m[2].split(' · '); e.by = by ?? ''; e.at = at ?? ''; }
      else for (const part of m[2].split(' · ')) {
        const i = part.indexOf(':');
        const k = part.slice(0, i).trim(), vals = part.slice(i + 1).split(',').map(x => x.trim()).filter(Boolean);
        if (k === 'paths') e.paths = vals; else if (k === 'ACs') e.ac_ids = vals;
      }
    }
    if (extra.length) e.decision = [e.decision, ...extra].filter(Boolean).join(' ');
    if (e.title) out.push(e);
  }
  return out;
}

export function readDecisions(p: Project): DecisionEntry[] { return parseDecisions(readMemory(p, 'decisions.md')); }

/**
 * Replace the first `covered` decisions with a compacted digest (librarian result); decisions recorded after the
 * librarian's snapshot are kept after it. The replaced text is appended to decisions-archive.md.
 */
export function replaceDecisions(p: Project, digest: Decision[], covered: number, by: string): void {
  const all = readDecisions(p);
  appendMemory(p, 'decisions-archive.md', `\n# Archived ${now()} (compacted by ${by})\n${readMemory(p, 'decisions.md')}`);
  const body = [...digest.map(d => decisionMd({ ...d, by: `digest by ${by}` })), ...all.slice(covered).map(d => decisionMd(d))].join('');
  writeMemory(p, 'decisions.md', body.replace(/^\n/, ''));
}

// ---------------- chat ----------------

const rowToMessage = (r: any): ChatMessage => ({
  id: r.id, projectId: r.project_id, sessionId: r.session_id, author: r.author, text: r.text, meta: json(r.meta, null), createdAt: r.created_at,
});

/**
 * Store a chat message. user/coordinator messages must name their session; system/agent messages without one are routed
 * (task origin → control session → latest session) so the user sees an unread mark on the right conversation.
 */
export function postMessage(projectId: string, author: ChatMessage['author'], text: string, meta: Record<string, unknown> | null = null, sessionId?: string | null): ChatMessage {
  const sid = sessionId || routeSession(projectId, meta);
  const r = getDb().prepare('INSERT INTO messages (project_id, session_id, author, text, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(projectId, sid, author, text, meta ? JSON.stringify(meta) : null, now());
  if (author === 'user' || author === 'coordinator') touchSession(sid);
  const m = getMessage(Number(r.lastInsertRowid))!;
  bus.emitEvent('chat.message', projectId, m, false);
  return m;
}

export function getMessage(id: number): ChatMessage | null {
  const r = getDb().prepare('SELECT * FROM messages WHERE id = ?').get(id) as any;
  return r ? rowToMessage(r) : null;
}

export function updateMessageMeta(id: number, meta: Record<string, unknown>): void {
  getDb().prepare('UPDATE messages SET meta = ? WHERE id = ?').run(JSON.stringify(meta), id);
  const m = getMessage(id);
  if (m) bus.emitEvent('chat.updated', m.projectId, m, false);
}

/** Latest messages of a project, or of one chat session when given. */
export function listMessages(projectId: string, limit = 300, sessionId?: string | null): ChatMessage[] {
  const rows = (sessionId
    ? getDb().prepare('SELECT * FROM messages WHERE project_id = ? AND session_id = ? ORDER BY id DESC LIMIT ?').all(projectId, sessionId, limit)
    : getDb().prepare('SELECT * FROM messages WHERE project_id = ? ORDER BY id DESC LIMIT ?').all(projectId, limit)) as any[];
  return rows.reverse().map(rowToMessage);
}

/** Messages of a session after a given id (oldest first), for catching a resumed CLI conversation up. */
export function messagesAfter(sessionId: string, afterId: number, beforeId: number): ChatMessage[] {
  return (getDb().prepare('SELECT * FROM messages WHERE session_id = ? AND id > ? AND id < ? ORDER BY id').all(sessionId, afterId, beforeId) as any[]).map(rowToMessage);
}

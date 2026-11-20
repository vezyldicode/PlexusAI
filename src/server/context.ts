// What project memory each task gets in its prompt, and the full copies it can read on demand.
//
// Every agent turn re-reads the whole prompt, so the prompt carries only what the task needs: a short project summary,
// the acceptance criteria and decisions that concern it, and one-line indexes of the rest. Full copies of the memory
// are written to .plexus-task/context/ in the task's worktree for the agent to open when it needs more.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Project, Task, TaskKind } from '../shared/types.ts';
import { readAcceptance, readDecisions, readMemory, type AcceptanceItem, type DecisionEntry } from './projects.ts';
import { getTask, normAcIds, pathsOverlap, shortId } from './tasks.ts';

export const CONTEXT_DIR = '.plexus-task/context';

/** How much of each memory file goes into the prompt. */
export interface ContextProfile {
  brief: 'full' | 'summary' | 'none';
  acceptance: 'full' | 'task' | 'none';
  decisions: 'full' | 'relevant';
  issues: 'full' | 'task' | 'none';
}

const FULL: ContextProfile = { brief: 'full', acceptance: 'full', decisions: 'full', issues: 'full' };
const WORKER: ContextProfile = { brief: 'summary', acceptance: 'task', decisions: 'relevant', issues: 'task' };

export const PROFILES: Record<TaskKind | 'coordinator', ContextProfile> = {
  ingest: { brief: 'none', acceptance: 'none', decisions: 'full', issues: 'none' },
  architect: { brief: 'full', acceptance: 'full', decisions: 'full', issues: 'none' },
  plan: FULL,
  build: WORKER,
  fix: WORKER,
  custom: WORKER,
  integrate: { ...WORKER, issues: 'none' },
  review: { ...WORKER, issues: 'none' },
  qa: { brief: 'summary', acceptance: 'full', decisions: 'relevant', issues: 'full' },
  evaluate: { brief: 'summary', acceptance: 'full', decisions: 'relevant', issues: 'full' },
  compact: { brief: 'summary', acceptance: 'none', decisions: 'full', issues: 'none' },
  // A single agent building the whole project needs all of it (chat requests use the worker profile, see buildTaskPrompt).
  solo: FULL,
  coordinator: { brief: 'summary', acceptance: 'full', decisions: 'relevant', issues: 'full' },
};

const LIMITS = { brief: 12_000, summary: 1_800, acceptance: 8_000, decisionsFull: 8_000, decisionsRelevant: 4_000, indexTitles: 80, issues: 3_000, taskIssues: 1_500 };

const head = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '\n…(truncated)' : s);
const tail = (s: string, n: number) => (s.length > n ? '…(earlier entries omitted)\n' + s.slice(-n) : s);
const orNone = (s: string, none = '(none yet)') => s.trim() || none;
const file = (name: string) => `\`${CONTEXT_DIR}/${name}\``;

/** The task and its ancestors (fix → review → build), nearest first. */
function chain(t: Task): Task[] {
  const out = [t];
  let cur = t.parentId ? getTask(t.parentId) : null;
  for (let i = 0; cur && i < 10; i++) { out.push(cur); cur = cur.parentId ? getTask(cur.parentId) : null; }
  return out;
}

/** Acceptance criterion ids a task serves: recorded ones plus any "AC12" mentioned in its title, description or done-when. */
export function taskAcIds(t: Task): string[] {
  const text = [t.title, t.description, ...t.acceptance].join('\n');
  return normAcIds([...t.acIds, ...[...text.matchAll(/\bAC\d+\b/gi)].map(m => m[0])]);
}

/** Short project summary: summary.md from the analyst, else the start of the brief. */
export function projectSummary(p: Project): string {
  const s = readMemory(p, 'summary.md').trim();
  if (s) return head(s, LIMITS.summary);
  const brief = readMemory(p, 'brief.md').trim();
  if (!brief) return '';
  if (brief.length <= LIMITS.summary) return brief;
  const cut = brief.slice(0, LIMITS.summary);
  const para = cut.lastIndexOf('\n\n');
  return (para > LIMITS.summary / 2 ? cut.slice(0, para) : cut) + `\n…(full brief in ${file('brief.md')})`;
}

const acLine = (a: AcceptanceItem) => `- [${a.pass ? 'x' : ' '}] **${a.id}** ${a.criterion}${a.verify ? ` — verify: ${a.verify}` : ''}`;

function decisionText(d: DecisionEntry): string {
  return `### ${d.title}\n- Decision: ${d.decision}${d.rationale ? `\n- Rationale: ${d.rationale}` : ''}`;
}

/** Decisions that concern a task: same acceptance criteria, overlapping paths, or made by the task's own chain. */
export function relevantDecisions(all: DecisionEntry[], t: Task | null): DecisionEntry[] {
  if (!t) return [];
  const ac = new Set(taskAcIds(t));
  const ids = chain(t).map(shortId);
  const byChain = (by: string) => ids.some(id => new RegExp(`^(?:${id})\\b`).test(by.trim()));
  return all.filter(d => d.ac_ids.some(a => ac.has(a.toUpperCase())) || (t.paths.length && d.paths.length && pathsOverlap(t.paths, d.paths)) || byChain(d.by));
}

function decisionsSection(p: Project, prof: ContextProfile, t: Task | null): string {
  if (prof.decisions === 'full') return `## Decisions so far\n${orNone(tail(readMemory(p, 'decisions.md'), LIMITS.decisionsFull))}`;
  const all = readDecisions(p);
  if (!all.length) return '## Decisions so far\n(none yet)';
  const rel = relevantDecisions(all, t);
  const relSet = new Set(rel);
  const others = all.filter(d => !relSet.has(d)).slice(-LIMITS.indexTitles);
  const parts = [`## Decisions so far\n${all.length} recorded. Full text: ${file('decisions.md')}. Read it before making a design choice that could conflict with one of the titles below.`];
  if (rel.length) parts.push(`### Decisions that concern this task\n${head(rel.map(decisionText).join('\n'), LIMITS.decisionsRelevant)}`);
  if (others.length) parts.push(`### Other decisions (titles only)\n${others.map(d => `- ${d.title}`).join('\n')}`);
  return parts.join('\n\n');
}

function acceptanceSection(p: Project, prof: ContextProfile, t: Task | null): string {
  if (prof.acceptance === 'none') return '';
  if (prof.acceptance === 'full') return `## Acceptance criteria\n${orNone(head(readMemory(p, 'acceptance.md'), LIMITS.acceptance))}`;
  const all = readAcceptance(p);
  if (!all.length) return `## Acceptance criteria\n${orNone(head(readMemory(p, 'acceptance.md'), LIMITS.acceptance))}`;
  const ids = new Set(t ? taskAcIds(t) : []);
  const mine = all.filter(a => ids.has(a.id.toUpperCase()));
  const pointer = `All ${all.length} criteria: ${file('acceptance.md')}.`;
  return `## Acceptance criteria\n${mine.length ? `Criteria this task serves:\n${mine.map(acLine).join('\n')}\n\n${pointer}` : `${pointer} This task names none; read the file if you need them.`}`;
}

function issuesSection(p: Project, prof: ContextProfile, t: Task | null): string {
  if (prof.issues === 'none') return '';
  const md = readMemory(p, 'known-issues.md');
  if (prof.issues === 'full' || !t) return `## Known issues\n${orNone(tail(md, LIMITS.issues))}`;
  const ids = chain(t).map(shortId);
  const re = new RegExp(`\\b(?:${ids.join('|')})\\b`);
  const lines = md.split('\n').filter(l => l.trim());
  const mine = lines.filter(l => re.test(l));
  if (!lines.length) return '';
  return `## Known issues\n${mine.length ? tail(mine.join('\n'), LIMITS.taskIssues) + '\n' : ''}${lines.length} recorded in total: ${file('known-issues.md')}.`;
}

function briefSection(p: Project, prof: ContextProfile): string {
  if (prof.brief === 'none') return '';
  if (prof.brief === 'full') return `## Project brief\n${orNone(head(readMemory(p, 'brief.md'), LIMITS.brief), '(not written yet; read the documentation in the repository)')}`;
  return `## Project summary\n${orNone(projectSummary(p), '(not written yet; read the documentation in the repository)')}\nFull brief: ${file('brief.md')}.`;
}

/**
 * Project context split in two: `shared` is the same for every task with this profile (kept early in the prompt so
 * providers that cache by prefix can reuse it), `task` depends on the task itself.
 */
export function projectContext(p: Project, prof: ContextProfile, t: Task | null): { shared: string; task: string } {
  const shared = [
    `# PROJECT: ${p.name}`,
    `## Goal\n${orNone(readMemory(p, 'goal.md') || p.goal, '(see documentation in the repository)')}`,
    `## Directives from the user (must be followed)\n${orNone(readMemory(p, 'directives.md'))}`,
    briefSection(p, prof),
    prof.decisions === 'full' ? decisionsSection(p, prof, t) : '',
  ];
  const task = [
    acceptanceSection(p, prof, t),
    prof.decisions === 'relevant' ? decisionsSection(p, prof, t) : '',
    issuesSection(p, prof, t),
  ];
  return { shared: shared.filter(Boolean).join('\n\n'), task: task.filter(Boolean).join('\n\n') };
}

/** Full copies of the project memory in the task's worktree (git-ignored), for the agent to read on demand. */
export function writeContextFiles(p: Project, wt: string): void {
  const dir = join(wt, CONTEXT_DIR);
  mkdirSync(dir, { recursive: true });
  for (const f of ['goal.md', 'summary.md', 'brief.md', 'acceptance.md', 'decisions.md', 'directives.md', 'known-issues.md']) {
    writeFileSync(join(dir, f), readMemory(p, f) || '(empty)\n');
  }
}

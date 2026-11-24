// What project memory each task gets in its prompt, and the full copies it can read on demand.
//
// Every agent turn re-reads the whole prompt, so the prompt carries only what the task needs: a short project summary,
// the acceptance criteria and decisions that concern it, and one-line indexes of the rest. Full copies of the memory
// are written to .plexus-task/context/ in the task's worktree for the agent to open when it needs more.
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Project, Task, TaskKind } from '../shared/types.ts';
import { acMark, handoffDir, readAcceptance, readDecisions, readHandoff, readMemory, type AcceptanceItem, type DecisionEntry } from './projects.ts';
import { getTask, normAcIds, pathsOverlap, shortId } from './tasks.ts';
import { appConfig } from './config.ts';

export const CONTEXT_DIR = '.plexus-task/context';

/** How much of each memory file goes into the prompt. */
export interface ContextProfile {
  brief: 'full' | 'summary' | 'none';
  acceptance: 'full' | 'task' | 'none';
  decisions: 'full' | 'relevant';
  /** 'index': only how many are recorded and where (the coordinator reads the file when a question needs it). */
  issues: 'full' | 'task' | 'index' | 'none';
  /** Where the pointers to full copies lead, relative to the agent's folder (default: the worktree's CONTEXT_DIR). */
  memoryDir?: string;
  /** Leave out sections that have nothing in them instead of writing "(none yet)". */
  skipEmpty?: boolean;
  /** The code map (modules, entry points, how to test) so the agent does not re-explore the code to find its way. */
  codemap?: boolean;
}

const FULL: ContextProfile = { brief: 'full', acceptance: 'full', decisions: 'full', issues: 'full', codemap: true };
const WORKER: ContextProfile = { brief: 'summary', acceptance: 'task', decisions: 'relevant', issues: 'task', codemap: true };

export const PROFILES: Record<TaskKind | 'coordinator' | 'gap', ContextProfile> = {
  ingest: { brief: 'none', acceptance: 'none', decisions: 'full', issues: 'none' },
  architect: { brief: 'full', acceptance: 'full', decisions: 'full', issues: 'none', codemap: true },
  plan: FULL,
  build: WORKER,
  fix: WORKER,
  custom: WORKER,
  integrate: { ...WORKER, issues: 'none' },
  review: { ...WORKER, issues: 'none' },
  qa: { brief: 'summary', acceptance: 'full', decisions: 'relevant', issues: 'full', codemap: true },
  evaluate: { brief: 'summary', acceptance: 'full', decisions: 'relevant', issues: 'full', codemap: true },
  compact: { brief: 'summary', acceptance: 'none', decisions: 'full', issues: 'none' },
  // A single agent building the whole project needs all of it (chat requests use the worker profile, see buildTaskPrompt).
  solo: FULL,
  // A later round of a single-agent build: only the criteria still open (its acIds) and what concerns them.
  gap: WORKER,
  // The coordinator runs in the project folder, where the memory is .plexus/memory (no .plexus-task/context copies).
  coordinator: { brief: 'summary', acceptance: 'full', decisions: 'relevant', issues: 'index', memoryDir: '.plexus/memory', skipEmpty: true },
};

/** The profile of a task: chat requests and gap rounds (a solo task with the open criteria as acIds) get the worker profile. */
export function profileFor(t: Task): ContextProfile {
  if (t.kind === 'solo' && t.adhoc) return PROFILES.custom;
  if (t.kind === 'solo' && t.acIds.length) return PROFILES.gap;
  return PROFILES[t.kind] ?? PROFILES.custom;
}

/** Characters of each memory file in a prompt (Settings → Context). */
const limits = () => {
  const c = appConfig();
  return { brief: c.briefChars, summary: c.summaryChars, acceptance: c.acceptanceChars, decisionsFull: c.decisionsFullChars, decisionsRelevant: c.decisionsRelevantChars,
    indexTitles: c.decisionTitles, issues: c.issuesChars, taskIssues: c.taskIssuesChars, codemap: c.codemapChars };
};

const head = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '\n…(truncated)' : s);
const tail = (s: string, n: number) => (s.length > n ? '…(earlier entries omitted)\n' + s.slice(-n) : s);
const orNone = (s: string, none = '(none yet)') => s.trim() || none;
const file = (name: string, prof?: ContextProfile) => `\`${prof?.memoryDir ?? CONTEXT_DIR}/${name}\``;

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
export function projectSummary(p: Project, prof?: ContextProfile): string {
  const s = readMemory(p, 'summary.md').trim();
  if (s) return head(s, limits().summary);
  const brief = readMemory(p, 'brief.md').trim();
  if (!brief) return '';
  if (brief.length <= limits().summary) return brief;
  const cut = brief.slice(0, limits().summary);
  const para = cut.lastIndexOf('\n\n');
  return (para > limits().summary / 2 ? cut.slice(0, para) : cut) + `\n…(full brief in ${file('brief.md', prof)})`;
}

/** One criterion for a prompt: no evidence (that stays in acceptance.md; the agent re-checks anyway). */
const acLine = (a: AcceptanceItem) => `- [${acMark(a)}] **${a.id}** ${a.criterion}${a.verify ? ` — verify: ${a.verify}` : ''}${a.pass === 'blocked' ? ' — blocked (needs environment/person)' : ''}`;

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
  if (prof.decisions === 'full') return `## Decisions so far\n${orNone(tail(readMemory(p, 'decisions.md'), limits().decisionsFull))}`;
  const all = readDecisions(p);
  if (!all.length) return prof.skipEmpty ? '' : '## Decisions so far\n(none yet)';
  const rel = relevantDecisions(all, t);
  const relSet = new Set(rel);
  const n = limits().indexTitles;
  const others = n ? all.filter(d => !relSet.has(d)).slice(-n) : [];
  const parts = [`## Decisions so far\n${all.length} recorded. Full text: ${file('decisions.md', prof)}. Read it before making a design choice that could conflict with one of the titles below.`];
  if (rel.length) parts.push(`### Decisions that concern this task\n${head(rel.map(decisionText).join('\n'), limits().decisionsRelevant)}`);
  if (others.length) parts.push(`### Other decisions (titles only)\n${others.map(d => `- ${d.title}`).join('\n')}`);
  return parts.join('\n\n');
}

function acceptanceSection(p: Project, prof: ContextProfile, t: Task | null): string {
  if (prof.acceptance === 'none') return '';
  const all = readAcceptance(p);
  if (prof.skipEmpty && !all.length && !readMemory(p, 'acceptance.md').trim()) return '';
  if (prof.acceptance === 'full') {
    return `## Acceptance criteria\n${all.length ? head(all.map(acLine).join('\n'), limits().acceptance) : orNone(head(readMemory(p, 'acceptance.md'), limits().acceptance))}`;
  }
  if (!all.length) return `## Acceptance criteria\n${orNone(head(readMemory(p, 'acceptance.md'), limits().acceptance))}`;
  const ids = new Set(t ? taskAcIds(t) : []);
  const mine = all.filter(a => ids.has(a.id.toUpperCase()));
  const pointer = `All ${all.length} criteria: ${file('acceptance.md', prof)}.`;
  return `## Acceptance criteria\n${mine.length ? `Criteria this task serves:\n${mine.map(acLine).join('\n')}\n\n${pointer}` : `${pointer} This task names none; read the file if you need them.`}`;
}

function issuesSection(p: Project, prof: ContextProfile, t: Task | null): string {
  if (prof.issues === 'none') return '';
  const md = readMemory(p, 'known-issues.md');
  if (prof.issues === 'index') {
    const n = md.split('\n').filter(l => l.trim()).length;
    return n || !prof.skipEmpty ? `## Known issues\n${n} recorded: ${file('known-issues.md', prof)}. Read it when a question concerns them.` : '';
  }
  if (prof.skipEmpty && !md.trim()) return '';
  if (prof.issues === 'full' || !t) return `## Known issues\n${orNone(tail(md, limits().issues))}`;
  const ids = chain(t).map(shortId);
  if (t.laneFrom) ids.push(shortId({ seq: Number(t.laneFrom.split('-T').pop()) || 0 }));
  const re = new RegExp(`\\b(?:${ids.join('|')})\\b`);
  const lines = md.split('\n').filter(l => l.trim());
  const mine = lines.filter(l => re.test(l));
  if (!lines.length) return '';
  return `## Known issues\n${mine.length ? tail(mine.join('\n'), limits().taskIssues) + '\n' : ''}${lines.length} recorded in total: ${file('known-issues.md', prof)}.`;
}

function briefSection(p: Project, prof: ContextProfile): string {
  if (prof.brief === 'none') return '';
  const hasBrief = !!readMemory(p, 'brief.md').trim();
  if (prof.skipEmpty && !hasBrief && !readMemory(p, 'summary.md').trim()) return '';
  if (prof.brief === 'full') return `## Project brief\n${orNone(head(readMemory(p, 'brief.md'), limits().brief), '(not written yet; read the documentation in the repository)')}`;
  return `## Project summary\n${orNone(projectSummary(p, prof), '(not written yet; read the documentation in the repository)')}${hasBrief || !prof.skipEmpty ? `\nFull brief: ${file('brief.md', prof)}.` : ''}`;
}

function codemapSection(p: Project, prof: ContextProfile): string {
  if (!prof.codemap) return '';
  const m = readMemory(p, 'codemap.md').trim();
  return m ? `## Code map (from earlier agents; check it against the code, update it in \`codemap\` if it is wrong)\n${head(m, limits().codemap)}` : '';
}

/** What the agent this task continues left behind (its progress notes), for a fresh start in its place. */
export function laneNotes(p: Project, t: Task): string {
  if (!t.laneFrom) return '';
  const prev = getTask(t.laneFrom);
  if (!prev) return '';
  const notes = readHandoff(p, shortId(prev)).trim();
  return notes ? `## Notes left by the previous agent on this work (${shortId(prev)}: ${prev.title})\n${tail(notes, appConfig().laneNotesChars)}` : '';
}

/**
 * Project context split in two: `shared` is the same for every task with this profile (kept early in the prompt so
 * providers that cache by prefix can reuse it), `task` depends on the task itself.
 */
export function projectContext(p: Project, prof: ContextProfile, t: Task | null): { shared: string; task: string } {
  const goal = (readMemory(p, 'goal.md') || p.goal || '').trim(), directives = readMemory(p, 'directives.md').trim();
  const shared = [
    `# PROJECT: ${p.name}`,
    goal || !prof.skipEmpty ? `## Goal\n${orNone(goal, '(see documentation in the repository)')}` : '',
    directives || !prof.skipEmpty ? `## Directives from the user (must be followed)\n${orNone(directives)}` : '',
    briefSection(p, prof),
    prof.decisions === 'full' ? decisionsSection(p, prof, t) : '',
  ];
  const task = [
    codemapSection(p, prof),
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
  for (const f of ['goal.md', 'summary.md', 'brief.md', 'acceptance.md', 'decisions.md', 'directives.md', 'known-issues.md', 'codemap.md', 'open-gaps.md']) {
    writeFileSync(join(dir, f), readMemory(p, f) || '(empty)\n');
  }
  // Hand-off notes of earlier tasks (the newest few), so evidence written in one round is still there in the next.
  const src = handoffDir(p);
  if (existsSync(src)) {
    const files = readdirSync(src).filter(f => /^T\d+\.md$/.test(f)).sort((a, b) => Number(b.slice(1, -3)) - Number(a.slice(1, -3))).slice(0, appConfig().handoffFiles);
    if (files.length) mkdirSync(join(dir, 'handoff'), { recursive: true });
    for (const f of files) cpSync(join(src, f), join(dir, 'handoff', f));
  }
}

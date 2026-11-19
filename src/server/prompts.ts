import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Account, ChatMessage, Project, Role, Task } from '../shared/types.ts';
import { appRoot } from './paths.ts';
import { readMemory } from './projects.ts';
import { getTask, shortId } from './tasks.ts';

export const TASK_DIR = '.plexus-task';
export const RESULT_FILE = `${TASK_DIR}/result.json`;
export const PROGRESS_FILE = `${TASK_DIR}/progress.md`;

const base = () => readFileSync(join(appRoot, 'defaults', 'base.md'), 'utf8');
const tail = (s: string, n: number) => (s.length > n ? '…(earlier entries omitted)\n' + s.slice(-n) : s);
const head = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '\n…(truncated)' : s);
const orNone = (s: string, none = '(none yet)') => s.trim() || none;

function projectContext(p: Project): string {
  return [
    `# PROJECT: ${p.name}`,
    `## Goal\n${orNone(readMemory(p, 'goal.md') || p.goal, '(see documentation in the repository)')}`,
    `## Project brief\n${orNone(head(readMemory(p, 'brief.md'), 12_000), '(not written yet; read the documentation in the repository)')}`,
    `## Acceptance criteria\n${orNone(head(readMemory(p, 'acceptance.md'), 8_000))}`,
    `## Decisions so far\n${orNone(tail(readMemory(p, 'decisions.md'), 8_000))}`,
    `## Directives from the user (must be followed)\n${orNone(readMemory(p, 'directives.md'))}`,
    `## Known issues\n${orNone(tail(readMemory(p, 'known-issues.md'), 3_000))}`,
  ].join('\n\n');
}

const COMMON_FIELDS = `  "status": "done" | "partial" | "blocked" | "failed",
  "summary": "what you did, in 2-6 sentences",
  "decisions": [{ "title": "...", "decision": "...", "rationale": "..." }],
  "issues": ["problems found that are not fixed"],
  "questions": [{ "question": "...", "default_answer": "the assumption you used" }],
  "follow_up_tasks": [{ "title": "...", "description": "...", "role": "implementer", "acceptance": ["..."], "paths": ["files or directories it will change"] }]`;

const KIND_FIELDS: Partial<Record<Task['kind'], string>> = {
  ingest: `  "project_brief": "markdown",
  "acceptance_criteria": [{ "id": "AC1", "criterion": "...", "verify": "how to check" }]`,
  plan: `  "tasks": [{ "key": "auth-api", "title": "...", "description": "...", "role": "implementer", "depends_on": ["db-schema"], "acceptance": ["..."], "paths": ["src/auth/", "test/auth.test.ts"] }]`,
  review: `  "review": { "verdict": "approve" | "changes_requested", "comments": ["file:line — what to change"] }`,
  evaluate: `  "evaluation": { "complete": false, "criteria": [{ "id": "AC1", "pass": true, "evidence": "..." }], "report": "markdown" }`,
};

function outputContract(kind: Task['kind']): string {
  const extra = KIND_FIELDS[kind];
  return `# OUTPUT CONTRACT
When finished, write this JSON object to \`${RESULT_FILE}\` (create the folder if needed; it is git-ignored):
{
${COMMON_FIELDS}${extra ? ',\n' + extra : ''}
}
Omit empty arrays if you like. After writing the file, end your reply with the same JSON in a \`\`\`json block.`;
}

function taskSection(p: Project, t: Task): string {
  const parts = [`# TASK ${shortId(t)}: ${t.title}`, `- kind: ${t.kind}\n- role: ${t.role}\n- main branch: ${p.mainBranch}${t.branch ? `\n- your branch: ${t.branch}` : ''}`];
  if (t.description) parts.push(`## Description\n${t.description}`);
  if (t.acceptance.length) parts.push(`## Done when\n${t.acceptance.map(a => `- ${a}`).join('\n')}`);
  const parent = t.parentId ? getTask(t.parentId) : null;
  if (t.kind === 'plan') {
    const notes = readMemory(p, 'planning-notes.md').trim();
    if (notes) parts.push(`## Suggestions from earlier agents (consider them; you decide the final plan)
${head(notes, 6_000)}`);
  }
  if (t.kind === 'review' && parent) {
    parts.push(`## Change under review\nTask ${shortId(parent)}: ${parent.title}\n${parent.description}\n\nAuthor's summary: ${parent.result?.summary ?? '(none)'}\nreview_cycle: ${t.reviewCycles}`);
  }
  if (t.kind === 'fix' && parent) {
    const comments = parent.kind === 'review' ? parent.result?.review?.comments ?? [] : [];
    parts.push(`## Review comments to address\n${comments.map(c => `- ${c}`).join('\n') || '(see description)'}`);
  }
  return parts.join('\n\n');
}

function continuationSection(t: Task, account: Account, progress: string): string {
  if (t.attempts === 0 && !progress.trim()) return '';
  return `# CONTINUATION
This task was started before (attempt ${t.attempts + 1}). Previous attempts may have been interrupted (quota, crash, timeout)
or failed: ${t.error ?? 'no error recorded'}.
Before doing anything: read \`${PROGRESS_FILE}\`, \`git log --oneline -20\` and \`git status\` to see what is already done,
then continue from there. Do not redo finished work. You are now running as account ${account.id}.

## Current ${PROGRESS_FILE}
${head(progress, 6_000) || '(empty)'}`;
}

export function buildTaskPrompt(p: Project, t: Task, role: Role, account: Account, progress: string, skills: string[]): string {
  const meta = `<!-- plexus-meta\nrole: ${role.name}\nkind: ${t.kind}\ntask_id: ${shortId(t)}\nresult_file: ${RESULT_FILE}\n-->`;
  return [
    meta,
    `# RULES\n${base()}`,
    `# YOUR ROLE: ${role.name}\n${role.instructions}`,
    skills.length ? `# SKILLS\nThese skills are installed in this repository (.claude/skills or .agents/skills); use them when relevant: ${skills.join(', ')}` : '',
    projectContext(p),
    taskSection(p, t),
    continuationSection(t, account, progress),
    outputContract(t.kind),
  ].filter(Boolean).join('\n\n');
}

export interface StatusDigest { tasks: string; accounts: string; events: string; counts: string }

export function buildCoordinatorPrompt(p: Project, role: Role, status: StatusDigest, history: ChatMessage[], userText: string): string {
  const meta = `<!-- plexus-meta\nrole: coordinator\nkind: coordinator\ntask_id: chat\nresult_file: none\n-->`;
  const hist = history.slice(-20).map(m => `[${m.author}] ${head(m.text, 1500)}`).join('\n');
  return [
    meta,
    `# YOUR ROLE: coordinator\n${role.instructions}`,
    projectContext(p),
    `# STATUS\nProject status: ${p.status} · phase: ${p.phase}\nTask counts: ${status.counts}\n\n## Tasks\n${status.tasks}\n\n## Accounts\n${status.accounts}\n\n## Recent events\n${status.events}`,
    `# CHAT HISTORY\n${hist || '(empty)'}`,
    `USER MESSAGE:\n${userText}\n---`,
    `# OUTPUT
You may read files in the repository to answer, but do not modify anything.
Respond with ONLY one JSON object (no prose before or after):
{ "reply": "your answer to the user",
  "actions": [ ... ],
  "proposal": null | { "summary": "what will change and why", "actions": [ ... ] } }
Action types:
{"type":"pause"} {"type":"resume"} {"type":"stop"}
{"type":"add_task","title":"...","description":"...","role":"implementer","depends_on":["T3"],"priority":50}
{"type":"cancel_task","task_id":"T5"} {"type":"retry_task","task_id":"T5"} {"type":"reprioritize","task_id":"T5","priority":90}
{"type":"update_task","task_id":"T5","description":"new description"}
{"type":"record_decision","title":"...","decision":"...","rationale":"..."}
{"type":"add_directive","text":"instruction all agents must follow from now on"}
{"type":"set_goal","goal":"..."} {"type":"replan","reason":"..."}
Use "actions" only for what the user clearly asked; put large changes in "proposal". Questions only need a reply.`,
  ].join('\n\n');
}

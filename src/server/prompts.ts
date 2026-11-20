import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Account, ChatMessage, Project, Role, Task } from '../shared/types.ts';
import { appRoot } from './paths.ts';
import { CONTEXT_DIR, PROFILES, projectContext } from './context.ts';
import { readMemory } from './projects.ts';
import { getTask, shortId } from './tasks.ts';

export const TASK_DIR = '.plexus-task';
export const RESULT_FILE = `${TASK_DIR}/result.json`;
export const PROGRESS_FILE = `${TASK_DIR}/progress.md`;

const base = () => readFileSync(join(appRoot, 'defaults', 'base.md'), 'utf8');
const head = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '\n…(truncated)' : s);

const COMMON_FIELDS = `  "status": "done" | "partial" | "blocked" | "failed",
  "summary": "what you did, in 2-6 sentences",
  "decisions": [{ "title": "...", "decision": "...", "rationale": "...", "paths": ["files it concerns"], "ac_ids": ["AC3"] }],
  "issues": ["problems found that are not fixed"],
  "questions": [{ "question": "...", "default_answer": "the assumption you used" }],
  "follow_up_tasks": [{ "title": "...", "description": "...", "role": "implementer", "acceptance": ["..."], "paths": ["files or directories it will change"], "ac_ids": ["AC3"] }]`;

const PLAN_TASKS = `  "tasks": [{ "key": "auth-api", "title": "...", "description": "...", "role": "implementer", "depends_on": ["db-schema"], "acceptance": ["..."], "paths": ["src/auth/", "test/auth.test.ts"], "ac_ids": ["AC3", "AC7"] }]
  (ac_ids: the acceptance criteria each task serves; the task's agent sees only those criteria)`;
const EVALUATION = `  "evaluation": { "complete": false, "criteria": [{ "id": "AC1", "pass": true, "evidence": "..." }], "report": "markdown" }`;

const KIND_FIELDS: Partial<Record<Task['kind'], string>> = {
  ingest: `  "docs_check": { "sufficient": true, "questions": ["what to ask the user when the docs are not enough (then omit everything below)"] },
  "execution": { "mode": "single" | "team", "reason": "one sentence" },
  "project_brief": "markdown",
  "project_summary": "the brief in at most ~1200 characters: purpose, main features, stack constraints (most agents only read this)",
  "acceptance_criteria": [{ "id": "AC1", "criterion": "...", "verify": "how to check" }]`,
  plan: PLAN_TASKS,
  architect: PLAN_TASKS,
  compact: `  "decisions_digest": [{ "title": "...", "decision": "...", "rationale": "...", "paths": ["..."], "ac_ids": ["..."] }]`,
  review: `  "review": { "verdict": "approve" | "changes_requested", "comments": ["file:line — what to change"] }`,
  evaluate: EVALUATION,
  solo: `${EVALUATION},
  "escalate": null | { "reason": "why the rest needs a team (only when the work splits into large independent parts)" }`,
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

const DECISION_SCOPE = `In \`decisions\`, give \`paths\` and/or \`ac_ids\` when a decision only concerns some files or criteria: agents see the full text of a decision only when it concerns their task.`;

/**
 * Order matters for cost: the parts that are the same for many tasks (rules, project context of this profile, role)
 * come first so providers that cache by prompt prefix can reuse them; task-specific parts and the meta block come last.
 */
export function buildTaskPrompt(p: Project, t: Task, role: Role, account: Account, progress: string, skills: string[]): string {
  const meta = `<!-- plexus-meta\nrole: ${role.name}\nkind: ${t.kind}\ntask_id: ${shortId(t)}\nresult_file: ${RESULT_FILE}\n-->`;
  // A chat request done by one agent is usually small: it gets the worker profile, not the whole project memory.
  const ctx = projectContext(p, t.kind === 'solo' && t.adhoc ? PROFILES.custom : PROFILES[t.kind] ?? PROFILES.custom, t);
  return [
    `# RULES\n${base()}`,
    ctx.shared,
    `# YOUR ROLE: ${role.name}\n${role.instructions}`,
    skills.length ? `# SKILLS\nThese skills are installed in this repository (.claude/skills or .agents/skills); use them when relevant: ${skills.join(', ')}` : '',
    ctx.task ? `# PROJECT CONTEXT FOR THIS TASK\nFull copies of the project memory are in \`${CONTEXT_DIR}/\`.\n\n${ctx.task}` : '',
    taskSection(p, t),
    continuationSection(t, account, progress),
    `${outputContract(t.kind)}\n${DECISION_SCOPE}`,
    meta,
  ].filter(Boolean).join('\n\n');
}

/**
 * Prompt for a run that continues the CLI conversation of an earlier attempt in the same worktree (same account):
 * rules, role and project context are already in that conversation, so only the new task, fresh directives and the
 * output contract are sent. This is what makes a fix after review or a retry cheap.
 */
export function buildResumePrompt(p: Project, t: Task, role: Role, progress: string): string {
  const meta = `<!-- plexus-meta\nrole: ${role.name}\nkind: ${t.kind}\ntask_id: ${shortId(t)}\nresult_file: ${RESULT_FILE}\n-->`;
  const directives = readMemory(p, 'directives.md').trim();
  const again = t.attempts > 0 || !!t.error;
  const how = again
    ? `The previous attempt ended early (${t.error ?? 'interrupted'}): check \`git status\` and \`${PROGRESS_FILE}\`, then continue without redoing finished work.`
    : 'Do only what this step asks.';
  return [
    `# NEXT STEP IN THIS CONVERSATION\nYou are continuing in the same worktree and conversation as before, now as the ${role.name}. The rules, project\ncontext and your earlier work above still apply. ${how}`,
    directives ? `## Directives from the user (must be followed)\n${directives}` : '',
    taskSection(p, t),
    again && progress.trim() ? `## Current ${PROGRESS_FILE}\n${head(progress, 3_000)}` : '',
    `${outputContract(t.kind)}\n${DECISION_SCOPE}`,
    meta,
  ].filter(Boolean).join('\n\n');
}

export interface StatusDigest { tasks: string; accounts: string; events: string; counts: string }

const COORDINATOR_META = `<!-- plexus-meta\nrole: coordinator\nkind: coordinator\ntask_id: chat\nresult_file: none\n-->`;
const statusSection = (p: Project, status: StatusDigest) =>
  `# STATUS\nProject status: ${p.status} · phase: ${p.phase}\nTask counts: ${status.counts}\n\n## Tasks\n${status.tasks}\n\n## Accounts\n${status.accounts}\n\n## Recent events\n${status.events}`;
const fmtMsg = (m: ChatMessage) => `[${m.author}] ${head(m.text, 1500)}`;

/**
 * A turn of a resumed CLI conversation: the role, project context and earlier chat are already in it, so send only the
 * fresh status, what happened in this chat since the last reply, and the new message.
 */
export function buildCoordinatorTurnPrompt(p: Project, status: StatusDigest, news: ChatMessage[], userText: string): string {
  return [
    COORDINATOR_META,
    statusSection(p, status),
    news.length ? `# NEW SINCE YOUR LAST REPLY\n${news.slice(-20).map(fmtMsg).join('\n')}` : '',
    `USER MESSAGE:\n${userText}\n---`,
    COORDINATOR_OUTPUT,
  ].filter(Boolean).join('\n\n');
}

export function buildCoordinatorPrompt(p: Project, role: Role, status: StatusDigest, history: ChatMessage[], userText: string): string {
  const hist = history.slice(-20).map(fmtMsg).join('\n');
  const ctx = projectContext(p, PROFILES.coordinator, null);
  return [
    COORDINATOR_META,
    `# YOUR ROLE: coordinator\n${role.instructions}`,
    ctx.shared,
    ctx.task,
    'Full project memory (brief, decisions, acceptance criteria) is in .plexus/memory/ of the repository.',
    statusSection(p, status),
    `# CHAT HISTORY\n${hist || '(empty)'}`,
    `USER MESSAGE:\n${userText}\n---`,
    COORDINATOR_OUTPUT,
  ].join('\n\n');
}

const COORDINATOR_OUTPUT = `# OUTPUT
You may read files in the repository to answer, but do not modify anything.
Respond with ONLY one JSON object (no prose before or after):
{ "reply": "your answer to the user",
  "actions": [ ... ],
  "proposal": null | { "summary": "what will change and why", "actions": [ ... ] } }
Action types:
{"type":"pause"} {"type":"resume"} {"type":"stop"}
{"type":"solo_task","title":"...","description":"everything the agent needs: what to change, where, how to verify"}
  → you do the work yourself as ONE agent (your model, own worktree, tests, self-review, merge). Runs even when the
    project is idle or finished. DEFAULT for anything the user asks to build, change or fix.
{"type":"add_task","title":"...","description":"...","role":"implementer","depends_on":["T3"],"priority":50}
  → a task for the team pipeline (implementer, review when large). Only for large work that splits into parallel parts.
{"type":"cancel_task","task_id":"T5"} {"type":"retry_task","task_id":"T5"} {"type":"reprioritize","task_id":"T5","priority":90}
{"type":"update_task","task_id":"T5","description":"new description"}
{"type":"record_decision","title":"...","decision":"...","rationale":"..."}
{"type":"add_directive","text":"instruction all agents must follow from now on"}
{"type":"set_goal","goal":"..."} {"type":"replan","reason":"..."}
Use "actions" only for what the user clearly asked; put large changes in "proposal". Questions only need a reply.
Prefer one solo_task over several add_task: every hand-off between agents re-reads the whole context and costs quota.
Phase needs_input: the user is answering what to build; record it (set_goal / add_directive), then resume.`;

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Account, ChatMessage, Project, Role, Task } from '../shared/types.ts';
import { appRoot, paths } from './paths.ts';
import { laneNotes, profileFor, PROFILES, projectContext } from './context.ts';
import { readDecisions, readMemory } from './projects.ts';
import { getTask, isUserFollowUp, shortId } from './tasks.ts';
import { appConfig } from './config.ts';
import { autoCommit, baseRef } from './checkout.ts';

export const TASK_DIR = '.plexus-task';
export const RESULT_FILE = `${TASK_DIR}/result.json`;
export const PROGRESS_FILE = `${TASK_DIR}/progress.md`;
/** The output contract, also kept as a file: a compacted conversation loses the exact schema of the first prompt. */
export const CONTRACT_FILE = `${TASK_DIR}/contract.md`;

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
const EVALUATION = `  "evaluation": { "complete": false, "criteria": [{ "id": "AC1", "pass": true, "evidence": "..." }], "report": "markdown" }
  (pass: true | false | "blocked". "blocked" = cannot be checked here: a dependency or tool that may not be installed, a
   GUI/hardware/account a person must use, or a decision only the user can make; add "needs": "environment" | "human" |
   "decision". Blocked criteria are never retried by agents; the user is asked. Use false only for what code can fix.)`;
const CODEMAP = `  "codemap": "markdown, at most ~60 lines: modules and what they do, entry points, where tests live and how to run them; omit when the code map you were given is still right"`;

const KIND_FIELDS: Partial<Record<Task['kind'], string>> = {
  ingest: `  "docs_check": { "sufficient": true, "questions": ["what to ask the user when the docs are not enough (then omit everything below)"] },
  "execution": { "mode": "single" | "team", "reason": "one sentence" },
  "project_brief": "markdown",
  "project_summary": "the brief in at most ~1200 characters: purpose, main features, stack constraints (most agents only read this)",
  "acceptance_criteria": [{ "id": "AC1", "criterion": "...", "verify": "how to check" }],
${CODEMAP}`,
  plan: PLAN_TASKS,
  architect: `${PLAN_TASKS},\n${CODEMAP}`,
  compact: `  "decisions_digest": [{ "title": "...", "decision": "...", "rationale": "...", "paths": ["..."], "ac_ids": ["..."] }]`,
  review: `  "review": { "verdict": "approve" | "changes_requested", "comments": ["file:line — what to change"] }`,
  evaluate: EVALUATION,
  solo: `${EVALUATION},
${CODEMAP},
  "escalate": null | { "reason": "why the rest needs a team (only when the work splits into large independent parts)" }`,
};

function outputContract(kind: Task['kind']): string {
  const extra = KIND_FIELDS[kind];
  return `# OUTPUT CONTRACT
When finished, write this JSON object to \`${RESULT_FILE}\` (create the folder if needed; it is git-ignored; UTF-8):
{
${COMMON_FIELDS}${extra ? ',\n' + extra : ''}
}
Omit empty arrays if you like. After writing the file, end your reply with the same JSON in a \`\`\`json block.
Keep these exact field names and types. A copy of this contract is in \`${CONTRACT_FILE}\`: if your context was
compacted, read that file again before you write the result.`;
}

/** Text of the contract file written into the worktree (see CONTRACT_FILE). */
export const contractText = (kind: Task['kind']): string => `${outputContract(kind)}\n${DECISION_SCOPE}\n`;

function taskSection(p: Project, t: Task): string {
  const parts = [`# TASK ${shortId(t)}: ${t.title}`, `- kind: ${t.kind}\n- role: ${t.role}\n- main branch: ${baseRef(p)}${t.branch ? `\n- your branch: ${t.branch}` : ''}`];
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

/** Messages for the agent from the coordinator or the user (delivered once, at the start of the run). */
function inboxSection(t: Task): string {
  return t.inbox.length ? `## Messages for you from the coordinator / user (follow them; they override earlier instructions)\n${t.inbox.map(m => `- ${m}`).join('\n')}` : '';
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

const metaBlock = (role: Role, t: Task) => `<!-- plexus-meta\nrole: ${role.name}\nkind: ${t.kind}\ntask_id: ${shortId(t)}\nresult_file: ${RESULT_FILE}\n-->`;

/**
 * A task prompt in two parts. `system` (rules and role) is the same for every task of a role, so it goes into the CLI's
 * system prompt where it is cached across tasks (Claude: --append-system-prompt-file); providers without that get it
 * at the head of the prompt. `prompt`: project context, then the task-specific parts, the meta block last.
 */
export function buildTaskParts(p: Project, t: Task, role: Role, account: Account, progress: string, skills: string[]): { system: string; prompt: string } {
  const ctx = projectContext(p, profileFor(t), t);
  const system = `# RULES\n${base()}\n\n# YOUR ROLE: ${role.name}\n${role.instructions}`;
  const prompt = [
    ctx.shared,
    skills.length ? `# SKILLS\nThese skills are installed in this repository (.claude/skills or .agents/skills); use them when relevant: ${skills.join(', ')}` : '',
    ctx.task ? `# PROJECT CONTEXT FOR THIS TASK\n${ctx.task}` : '',
    laneNotes(p, t),
    taskSection(p, t),
    inboxSection(t),
    continuationSection(t, account, progress),
    `${outputContract(t.kind)}\n${DECISION_SCOPE}`,
    metaBlock(role, t),
  ].filter(Boolean).join('\n\n');
  return { system, prompt };
}

/** The whole prompt as one text (system part first), for providers that take a single prompt and for tests. */
export function buildTaskPrompt(p: Project, t: Task, role: Role, account: Account, progress: string, skills: string[]): string {
  const { system, prompt } = buildTaskParts(p, t, role, account, progress, skills);
  return `${system}\n\n${prompt}`;
}

/** Decisions recorded after `since` (ISO time), the ones a resumed agent has not seen yet. */
function newDecisions(p: Project, since: string | null): string {
  if (!since) return '';
  const fresh = readDecisions(p).filter(d => d.at && d.at > since);
  if (!fresh.length) return '';
  return `## Decisions recorded since your last step\n${head(fresh.map(d => `- ${d.title}: ${d.decision}`).join('\n'), 2_000)}`;
}

/**
 * Prompt for a run that continues the CLI conversation of an earlier attempt or task in the same worktree (same account):
 * rules, role and project context are already in that conversation, so only the new task, what changed in the project
 * memory, messages and the output contract are sent. This is what makes a fix after review, a retry, a gap round or a
 * follow-up given to the same agent cheap.
 */
export function buildResumePrompt(p: Project, t: Task, role: Role, progress: string): string {
  const directives = readMemory(p, 'directives.md').trim();
  const again = t.attempts > 0 || !!t.error;
  const how = again
    ? `The previous attempt ended early (${t.error ?? 'interrupted'}): check \`git status\` and \`${PROGRESS_FILE}\`, then continue without redoing finished work.`
    : t.laneFrom
      ? 'This is new work in the same worktree (re-created from the main branch, which now contains your earlier merged work). Do only what this step asks.'
      : 'Do only what this step asks.';
  // A message the user typed to a finished agent may be a question ("why so slow?"), not more work.
  const fromUser = isUserFollowUp(t)
    ? `\nThe user wrote the step below directly to you. If it is a question or a remark (about your work, its speed, a result)
rather than a request for more work, answer it in \`summary\` with status "done" and change nothing; do not pick up
unfinished earlier work unless the message asks for it.`
    : '';
  return [
    `# NEXT STEP IN THIS CONVERSATION\nYou are continuing in the same worktree and conversation as before, now as the ${role.name}. The rules, project\ncontext and your earlier work above still apply. ${how}${fromUser}`,
    t.kind === 'ingest' ? `## Goal (may have changed)\n${readMemory(p, 'goal.md') || p.goal || '(see documentation)'}` : '',
    directives ? `## Directives from the user (must be followed)\n${directives}` : '',
    newDecisions(p, t.cliUsedAt),
    taskSection(p, t),
    inboxSection(t),
    again && progress.trim() ? `## Current ${PROGRESS_FILE}\n${head(progress, 3_000)}` : '',
    `${outputContract(t.kind)}\n${DECISION_SCOPE}`,
    metaBlock(role, t),
  ].filter(Boolean).join('\n\n');
}

/**
 * First prompt of a task that forks the coordinator's conversation: the coordinator already read the code and discussed
 * the request with the user, so the agent starts with that knowledge. Its rules and role were not in that conversation
 * (the coordinator has its own), so they come here, with the task and the output contract; the project context does not.
 */
export function buildForkPrompt(p: Project, t: Task, role: Role, system: string): string {
  const directives = readMemory(p, 'directives.md').trim();
  return [
    `# YOU ARE NOW THE AGENT DOING THE WORK
The conversation above was the coordinator's chat with the user. You continue it as a separate agent: you are no longer
the coordinator (its instructions in your system prompt no longer apply), your only plexus tool is plexus_plan (your
checklist), and your reply is not shown in the chat. You work in a new git worktree (the
current directory, branch ${t.branch ?? '(see TASK)'}, created from ${baseRef(p)}); the project folder you saw above is
not yours to edit. Use what you already learned above (files, causes, decisions) instead of searching again.`,
    system,
    directives ? `## Directives from the user (must be followed)\n${directives}` : '',
    taskSection(p, t),
    inboxSection(t),
    `${outputContract(t.kind)}\n${DECISION_SCOPE}`,
    metaBlock(role, t),
  ].filter(Boolean).join('\n\n');
}

/** The turn Plexus sends after stopping a run whose context was compacted too often: checkpoint, report, stop. */
export function buildCheckpointPrompt(t: Task, role: Role, compactions: number): string {
  const rest = t.kind === 'solo' ? ', or `escalate` when the rest splits into independent parts' : '';
  return `# STOP: CONTEXT BUDGET SPENT
Plexus stopped you: your context was compacted ${compactions} times in this run, so this work is larger than one session.
Do not start anything new. Now, in a few steps:
1. Make sure what you have is committed (finish or revert a half-done edit so the branch builds; run only the quick tests
   that cover what you changed).
2. Update \`${PROGRESS_FILE}\`: what is done, what is left, where you stopped.
3. Write \`${RESULT_FILE}\` with status "partial" (or "done" if it is in fact done): what you did, and the remaining work
   as \`follow_up_tasks\` (each a coherent slice with its files)${rest}. End your reply with the same JSON.

${metaBlock(role, t)}`;
}

export interface StatusDigest { tasks: string; accounts: string; events: string; counts: string }

const COORDINATOR_META = `<!-- plexus-meta\nrole: coordinator\nkind: coordinator\ntask_id: chat\nresult_file: none\n-->`;
const statusSection = (p: Project, status: StatusDigest, title = 'STATUS') =>
  `# ${title}\nProject status: ${p.status} · phase: ${p.phase}\nTask counts: ${status.counts}\n\n## Tasks\n${status.tasks}\n\n## Accounts\n${status.accounts}\n\n## Recent events\n${status.events}`;
const fmtMsg = (m: ChatMessage) => `[${m.author}] ${head(m.text, appConfig().chatMessageChars)}`;

/** Where things are and how the coordinator acts: with the plexus tools when the CLI loaded them, else with JSON actions. */
function coordinatorGuide(p: Project, tools: boolean): string {
  const where = `- Project folder (main checkout, branch ${p.mainBranch}): ${p.path}${autoCommit() ? '' : `
- Plexus never commits on the user's branches: finished work is merged on Plexus's internal base (${baseRef(p)}) and
  written into the project folder as uncommitted changes, which the user reviews and commits. In the project folder never
  run git commit, merge, rebase, reset, checkout, stash or push, unless the user asks you to in this chat.`}
- A commit you make keeps git's configured author (Plexus): add no Co-Authored-By or "Generated with" lines to its message.
- Task logs (prompt + agent stream, one file per run): ${join(paths.logs, p.id)}
- Task worktrees: ${join(paths.worktrees, p.id)} · project memory: ${join(p.path, '.plexus', 'memory')} (hand-off notes in handoff/)`;
  const how = tools
    ? `- Tools: read and edit files, run commands (git, tests), and plexus_status · plexus_task(id) · plexus_task_log(id, tail, grep) ·
  plexus_action(action) (any action under OUTPUT) · plexus_main_begin / plexus_main_commit(message: what you changed) ·
  plexus_workspace / plexus_workspace_merge(message) · plexus_plan(items): a checklist the user watches, for a request of
  several steps; send the whole list each time a step starts or finishes.
- Doing it yourself: plexus_main_begin first (it holds merges back so you never edit the main checkout while a task
  merges), edit, then plexus_main_commit. For a larger edit, plexus_workspace gives you your own worktree; finish with
  plexus_workspace_merge. Never edit files that a running task lists in its paths.
- A solo_task on your own Claude account continues a copy of this conversation: look at the relevant code before you
  hand the work over, and keep the description short.`
    : `- The plexus tools are not available in this run: act through the JSON actions under OUTPUT. You may still read files and logs.`;
  return `# HOW YOU WORK
${where}
${how}
- "Give X to account Y" means assign_account (or \`account\` on solo_task): which account runs a task is Plexus's job. Never
  put account or provider names in directives or task descriptions (agents read them as limits on their work); remove a
  wrong directive with remove_directive.`;
}

/**
 * The static part of the coordinator's instructions (role, how it works, output format). Sent as the CLI's system prompt
 * where it has one (the same text every turn, so it is cached), else at the head of the first prompt.
 */
export function buildCoordinatorSystem(p: Project, role: Role, tools = false): string {
  return [`# YOUR ROLE: coordinator\n${role.instructions.trimEnd()}`, coordinatorGuide(p, tools), coordinatorOutput(tools)].join('\n\n');
}

/**
 * A turn of a resumed CLI conversation: the project context and earlier chat are already in it, so send only what
 * changed since the last reply (status delta, new chat notices) and the new message.
 */
export function buildCoordinatorTurnPrompt(p: Project, status: StatusDigest, news: ChatMessage[], userText: string, tools = false): string {
  return [
    COORDINATOR_META,
    statusSection(p, status, 'STATUS (changes since your last reply)'),
    news.length ? `# NEW SINCE YOUR LAST REPLY\n${news.slice(-appConfig().chatHistoryMessages).map(fmtMsg).join('\n')}` : '',
    `USER MESSAGE:\n${userText}\n---`,
    tools ? 'Use the plexus tools only where the answer needs them; answer with the OUTPUT JSON as before.' : 'Answer with the OUTPUT JSON as before.',
  ].filter(Boolean).join('\n\n');
}

/** The first turn of a coordinator conversation: the variable part (context, status, chat); the rest is in the system prompt. */
export function buildCoordinatorPrompt(p: Project, status: StatusDigest, history: ChatMessage[], userText: string): string {
  const hist = history.slice(-appConfig().chatHistoryMessages).map(fmtMsg).join('\n');
  const ctx = projectContext(p, PROFILES.coordinator, null);
  return [
    COORDINATOR_META,
    ctx.shared,
    ctx.task,
    statusSection(p, status),
    `# CHAT HISTORY\n${hist || '(empty)'}`,
    `USER MESSAGE:\n${userText}\n---`,
    'Answer with the JSON described under OUTPUT in your instructions.',
  ].filter(Boolean).join('\n\n');
}

/** The reply format and the actions, one per line (with the plexus tools any of them also goes through plexus_action). */
function coordinatorOutput(tools: boolean): string {
  return `# OUTPUT
When work depends on a file the user attached (a screenshot or design to match, a log, a spec, a data file...; see CHAT ATTACHMENTS), include its id in the task action's optional "attachments" array: the agent gets the file. Omit it only if the file merely selected an option and everything needed is fully written in the description. If unsure, include it.
End with ONLY one JSON object (no prose after it):
{ "reply": "your answer to the user", "actions": [ ... ], "proposal": null | { "summary": "what will change and why", "actions": [ ... ] } }
"actions" are applied after your reply${tools ? '; do not repeat what you already did with the plexus tools' : ''}. Action types:
{"type":"pause"}
{"type":"stop"}
{"type":"resume"} → continues every unfinished pipeline task: only when the user wants the project itself to continue (with unfinished tasks, as a proposal); never to get a request done, which the other actions do while the project is paused, stopped or idle.
{"type":"solo_task","title":"...","description":"what to change, where (files, functions, the cause you found), and 2-5 checks that say it is done","account":"optional account id"} → ONE agent (your model, own worktree, tests, self-review, merge); runs even when the project is idle, paused or finished. Checks are commands the repo already runs (build, typecheck, tests), never screenshots, demo data, a running server, new test infrastructure, data models or endpoints the request does not need. Work larger than one session: a first slice, and name the rest.
{"type":"continue_task","task_id":"T5","instructions":"what to do next"} → more work for the agent that did T5, in its conversation and worktree.
{"type":"send_message","task_id":"T5","text":"..."} → delivered to that agent at the start of its next run.
{"type":"add_task","title":"...","description":"...","role":"implementer","depends_on":["T3"],"priority":50} → a team-pipeline task; while the project is paused, stopped or idle it runs right away with its review, fixes and merge, and can only depend on finished tasks or tasks of the same request.
{"type":"assign_account","task_id":"T5","account":"claude-01"} → "auto" clears it; another account takes over while it cannot run.
{"type":"cancel_task","task_id":"T5"}
{"type":"retry_task","task_id":"T5"}
{"type":"reprioritize","task_id":"T5","priority":90}
{"type":"update_task","task_id":"T5","description":"new description"}
{"type":"record_decision","title":"...","decision":"...","rationale":"..."}
{"type":"add_directive","text":"instruction all agents must follow from now on"}
{"type":"remove_directive","match":"text in it"}
{"type":"set_goal","goal":"..."}
{"type":"replan","reason":"..."}`;
}

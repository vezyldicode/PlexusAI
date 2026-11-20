// Settings tabs for how Plexus runs: the project pipeline, quota checks, the scheduler, context sizes, the coordinator chat
// and advanced options. Every row is a label with a tooltip and one control; a changed value carries a dot and goes back
// to its default from the row's right-click menu. Values save as they change.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { Check, RotateCcw } from 'lucide-react';
import { api } from './api.ts';
import type { AppConfig } from '../../src/shared/config.ts';
import type { Project, ProjectSettings } from './types.ts';
import { ContextMenu, Ic } from './ui.tsx';

export interface ConfigView {
  config: AppConfig;
  overrides: Partial<AppConfig>;
  defaults: AppConfig;
  bounds: Partial<Record<keyof AppConfig, [number, number]>>;
  projectDefaults: ProjectSettings;
  projectBuiltin: ProjectSettings;
}

export type SaveState = 'idle' | 'saving' | 'saved';

// ---------------------------------------------------------------- field specs

type Opt = { value: string; label: string; tip?: string };
interface Field<K extends string> {
  key: K;
  label: string;
  tip: string;
  kind: 'slider' | 'number' | 'seg' | 'toggle' | 'text';
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: Opt[];
  placeholder?: string;
  /** Shown instead of the number when the value is 0. */
  zero?: string;
}
interface Group<K extends string> { title: string; note?: string; fields: Field<K>[] }

type CK = keyof AppConfig;
type PK = keyof ProjectSettings | 'review';

export type EngineTab = 'quota' | 'scheduler' | 'context' | 'coordinator' | 'advanced';

export const ENGINE_GROUPS: Record<EngineTab, { lead: string; groups: Group<CK>[] }> = {
  quota: {
    lead: 'How often Plexus reads each account\'s usage, and when it lets an account rest. Reading usage never calls a model, so it costs no quota.',
    groups: [
      { title: 'Usage checks', fields: [
        { key: 'claudePollMin', label: 'Claude usage check', kind: 'slider', unit: 'min', tip: 'How often Plexus reads the usage of an idle Claude account. Busy accounts report usage in their output for free. Shorter keeps the quota bars fresher; the check is rate limited, so very short intervals can fail' },
        { key: 'codexPollSec', label: 'Codex usage check', kind: 'slider', unit: 's', step: 15, tip: 'How often Plexus reads the rate limits of Codex accounts from the Codex app server' },
        { key: 'claudeBackoffMaxMin', label: 'Longest retry wait', kind: 'slider', unit: 'min', step: 5, tip: 'When a Claude usage check keeps failing, Plexus waits twice as long each time, up to this long' },
        { key: 'limitedRecheckMin', label: 'Recheck spent accounts', kind: 'slider', unit: 'min', step: 5, tip: 'How often an account that ran out of quota, with no known reset time, is checked again' },
        { key: 'controlTimeoutSec', label: 'Status check timeout', kind: 'number', unit: 's', tip: 'How long to wait for the Claude CLI to answer a usage or login check before giving up' },
      ] },
      { title: 'Limits', fields: [
        { key: 'warnPercent', label: 'Nearly spent at', kind: 'slider', unit: '%', tip: 'Usage at which an account is marked as nearly spent. Such accounts are picked last for new tasks' },
        { key: 'exhaustedPercent', label: 'Treat as spent at', kind: 'slider', unit: '%', tip: 'Usage at which an account stops taking new work until its window resets. Below 100 leaves a margin, so a long task is not cut off halfway' },
        { key: 'unknownResetBackoffMin', label: 'Rest when reset is unknown', kind: 'number', unit: 'min', tip: 'How long an account rests after hitting its limit when the CLI did not say when the limit resets' },
        { key: 'transientBackoffSec', label: 'Rest after an API error', kind: 'number', unit: 's', tip: 'How long an account rests after a temporary error such as an overloaded API or a dropped connection' },
      ] },
    ],
  },
  scheduler: {
    lead: 'When tasks start, how long a silent agent may run, and when Plexus stops to ask instead of guessing.',
    groups: [
      { title: 'Pace', fields: [
        { key: 'tickSec', label: 'Scheduler interval', kind: 'slider', unit: 's', tip: 'How often Plexus looks for ready tasks and free accounts. Shorter starts work sooner; it also runs right after every task ends' },
        { key: 'noAccountNoticeMin', label: 'Waiting notice every', kind: 'slider', unit: 'min', step: 5, tip: 'How often the chat says that a task is waiting because no account is free' },
      ] },
      { title: 'Agent runs', note: 'The role\'s max runtime is used as the silence timeout, kept between these two', fields: [
        { key: 'idleTimeoutMinMin', label: 'Silence timeout, shortest', kind: 'slider', unit: 'min', max: 120, tip: 'An agent that prints nothing for this long is stopped, even when its role allows a shorter runtime' },
        { key: 'idleTimeoutMaxMin', label: 'Silence timeout, longest', kind: 'slider', unit: 'min', max: 240, tip: 'An agent that prints nothing for this long is always stopped, even when its role allows a longer runtime' },
        { key: 'resumeFailWindowSec', label: 'Resume retry window', kind: 'number', unit: 's', tip: 'When continuing a previous conversation fails this soon after the start, the CLI has lost it: Plexus starts a new conversation in the same attempt' },
      ] },
      { title: 'Pipeline', fields: [
        { key: 'gapBundleMax', label: 'Gaps for one agent', kind: 'slider', tip: 'After an evaluation, up to this many gaps go to a single agent. More become separate tasks for the team' },
        { key: 'mergeConflictTries', label: 'Conflict resolution tries', kind: 'slider', tip: 'How many times an integrator may try to resolve a merge conflict before the task is marked failed' },
        { key: 'mainHoldMin', label: 'Merge pause for coordinator edits', kind: 'slider', unit: 'min', max: 60, tip: 'While the coordinator edits the main checkout, merges wait until it commits, or at most this long' },
      ] },
      { title: 'Before starting', note: 'With a goal and docs shorter than both, Plexus asks what to build before spending quota', fields: [
        { key: 'minGoalChars', label: 'Shortest goal', kind: 'number', unit: 'chars', tip: 'A goal shorter than this, together with too little documentation, makes Plexus ask before starting' },
        { key: 'minDocChars', label: 'Least documentation', kind: 'number', unit: 'chars', tip: 'Documentation smaller than this, together with a short goal, makes Plexus ask before starting' },
      ] },
    ],
  },
  context: {
    lead: 'How much each agent reads. Every call re-reads the whole prompt and conversation, so these sizes decide most of the token use.',
    groups: [
      { title: 'Conversation reuse', note: 'A fix or retry continues the author\'s conversation while that is cheaper than starting over with notes', fields: [
        { key: 'laneCtxMaxK', label: 'Continue conversations up to', kind: 'slider', unit: 'k tokens', step: 10, max: 400, tip: 'A conversation larger than this is not continued: a fresh start with the previous agent\'s notes costs less' },
        { key: 'laneIdleMaxMin', label: 'Prompt cache lasts', kind: 'slider', unit: 'min', step: 5, max: 240, tip: 'After this long without use the provider\'s prompt cache has expired. Claude keeps it for an hour' },
        { key: 'laneColdCtxMaxK', label: 'Continue cold conversations up to', kind: 'slider', unit: 'k tokens', step: 5, max: 200, tip: 'A conversation whose cache has expired is still continued while it is at most this large' },
      ] },
      { title: 'Prompt size', note: 'Characters of each project file put into a prompt. Agents can open the full files when they need more', fields: [
        { key: 'briefChars', label: 'Project brief', kind: 'number', unit: 'chars', step: 500, tip: 'The analyst\'s brief, for agents that need all of it (architect, single-agent builds)' },
        { key: 'summaryChars', label: 'Project summary', kind: 'number', unit: 'chars', step: 100, tip: 'The short summary most agents read instead of the brief' },
        { key: 'acceptanceChars', label: 'Acceptance criteria', kind: 'number', unit: 'chars', step: 500, tip: 'The list of criteria, for agents that check all of them' },
        { key: 'codemapChars', label: 'Code map', kind: 'number', unit: 'chars', step: 500, tip: 'The map of modules, entry points and tests, so agents do not re-explore the code' },
        { key: 'decisionsFullChars', label: 'Decision log', kind: 'number', unit: 'chars', step: 500, tip: 'The decision log, for agents that read all of it (the latest entries are kept)' },
        { key: 'decisionsRelevantChars', label: 'Decisions for the task', kind: 'number', unit: 'chars', step: 500, tip: 'Full text of the decisions that concern a task\'s files or criteria' },
        { key: 'decisionTitles', label: 'Other decision titles', kind: 'number', unit: 'titles', tip: 'Titles of other decisions listed so an agent knows what to look up. 0 lists none' },
        { key: 'issuesChars', label: 'Known issues', kind: 'number', unit: 'chars', step: 500, tip: 'Known issues, for agents that read all of them' },
        { key: 'taskIssuesChars', label: 'Known issues for the task', kind: 'number', unit: 'chars', step: 100, tip: 'Known issues that name the task or its chain' },
        { key: 'laneNotesChars', label: 'Notes from the previous agent', kind: 'number', unit: 'chars', step: 500, tip: 'Progress notes of the agent whose work a task continues, when it starts fresh' },
        { key: 'handoffFiles', label: 'Hand-off notes copied', kind: 'number', unit: 'files', tip: 'How many of the newest hand-off notes are copied into each task\'s workspace' },
      ] },
    ],
  },
  coordinator: {
    lead: 'What the coordinator reads on each chat turn. A resumed conversation only receives what changed since its last reply.',
    groups: [
      { title: 'Chat', fields: [
        { key: 'chatHistoryMessages', label: 'Messages in the prompt', kind: 'slider', tip: 'How many recent chat messages go into the coordinator\'s prompt' },
        { key: 'chatMessageChars', label: 'Characters per message', kind: 'number', unit: 'chars', step: 100, tip: 'Longer messages are cut to this many characters in the prompt' },
        { key: 'chatCtxMaxK', label: 'Continue the chat up to', kind: 'slider', unit: 'k tokens', step: 10, max: 400, tip: 'A chat conversation larger than this starts over with the recent history instead of being continued' },
        { key: 'chatIdleTimeoutMin', label: 'Silence timeout', kind: 'slider', unit: 'min', tip: 'A coordinator turn that prints nothing for this long is stopped' },
      ] },
      { title: 'Status digest', fields: [
        { key: 'digestEvents', label: 'Recent events', kind: 'number', unit: 'events', tip: 'Recent project events listed in the status the coordinator reads' },
        { key: 'digestDone', label: 'Recently finished tasks', kind: 'number', unit: 'tasks', tip: 'Finished tasks listed in the status the coordinator reads' },
      ] },
    ],
  },
  advanced: {
    lead: 'Where the command line tools are, and how Plexus signs its commits.',
    groups: [
      { title: 'Command line tools', fields: [
        { key: 'claudeBin', label: 'Claude CLI path', kind: 'text', placeholder: 'Found on PATH', tip: 'Full path of the claude executable. Empty uses PLEXUS_CLAUDE_BIN, then the PATH' },
        { key: 'codexBin', label: 'Codex CLI path', kind: 'text', placeholder: 'Found on PATH', tip: 'Full path of the codex executable or its codex.js. Empty uses PLEXUS_CODEX_BIN, then the PATH' },
        { key: 'probeModel', label: 'Fallback probe model', kind: 'text', placeholder: 'haiku', tip: 'Model of the one tiny call used to check a Claude account when the free status check does not answer' },
        { key: 'modelCacheHours', label: 'Model list cache', kind: 'slider', unit: 'h', max: 72, tip: 'How long the list of models and efforts of an account is kept before it is read again' },
      ] },
      { title: 'Git', fields: [
        { key: 'gitName', label: 'Commit author name', kind: 'text', placeholder: 'Plexus', tip: 'Name on the commits Plexus makes (snapshots, merges, work in progress)' },
        { key: 'gitEmail', label: 'Commit author email', kind: 'text', placeholder: 'plexus@localhost', tip: 'Email on the commits Plexus makes' },
      ] },
    ],
  },
};

const PROJECT_GROUPS: Group<PK>[] = [
  { title: 'Work', fields: [
    { key: 'pipeline', label: 'Build mode', kind: 'seg', tip: 'How the project is built after the analyst reads the docs', options: [
      { value: 'auto', label: 'Analyst decides', tip: 'One agent for small work, a team for large work that splits into parts' },
      { value: 'single', label: 'One agent', tip: 'One strong agent designs, builds and verifies everything' },
      { value: 'team', label: 'Team', tip: 'An architect plans, implementers work in parallel, then evaluation' },
    ] },
    { key: 'maxParallel', label: 'Tasks at once', kind: 'slider', min: 1, max: 20, tip: 'Most tasks running at the same time in this project. Each account still runs only as many as its own limit' },
    { key: 'maxTasks', label: 'Task budget', kind: 'slider', min: 10, max: 500, step: 10, tip: 'Most tasks a project may have in total. Planned or follow-up tasks past this are not created' },
    { key: 'maxAttempts', label: 'Attempts per task', kind: 'slider', min: 1, max: 10, tip: 'How often a task is tried before it is marked failed. Attempts lost to quota or a stop do not count' },
    { key: 'maxEvalRounds', label: 'Evaluation rounds', kind: 'slider', min: 1, max: 10, tip: 'Most rounds of evaluate and fix before Plexus stops and reports' },
  ] },
  { title: 'Review', fields: [
    { key: 'review', label: 'Review changes', kind: 'seg', tip: 'When another agent reviews a change before it is merged', options: [
      { value: 'auto', label: 'Large or flagged', tip: 'Changes above the line threshold, or ones the author flagged' },
      { value: 'always', label: 'Always', tip: 'Every code change is reviewed' },
      { value: 'never', label: 'Never', tip: 'Changes are merged without review' },
    ] },
    { key: 'reviewMinLines', label: 'Review from', kind: 'slider', unit: 'lines', min: 0, max: 3000, step: 50, tip: 'Changes at least this large are reviewed when the review setting is Large or flagged' },
    { key: 'maxReviewCycles', label: 'Review rounds', kind: 'slider', min: 0, max: 10, tip: 'Rounds of review and fix before a change is merged with its open comments noted' },
    { key: 'independentReviewWaitMin', label: 'Wait for another reviewer', kind: 'slider', unit: 'min', min: 0, max: 240, step: 1, tip: 'How long a review waits for an account other than the author\'s before the author\'s account reviews it' },
    { key: 'qaPhase', label: 'Separate QA pass', kind: 'toggle', tip: 'Run a QA task on the merged product before evaluation. The evaluator tests anyway, so this is extra' },
  ] },
  { title: 'Accounts and context', fields: [
    { key: 'quotaStrategy', label: 'Account choice', kind: 'seg', tip: 'Which free account takes the next task', options: [
      { value: 'spread', label: 'Least used first', tip: 'Spread work so every account keeps some quota' },
      { value: 'drain', label: 'Most used first', tip: 'Use one account up before moving to the next' },
      { value: 'priority', label: 'By priority', tip: 'Follow the account priorities set under Accounts' },
    ] },
    { key: 'resumeSessions', label: 'Continue the author\'s conversation', kind: 'toggle', tip: 'Fixes and retries continue the conversation of the agent that wrote the code, instead of re-reading the project' },
    { key: 'autocompactTokens', label: 'Compact context at', kind: 'slider', unit: 'k tokens', min: 0, max: 1000, step: 10, zero: 'CLI default', tip: 'An agent\'s conversation is summarized once it passes this size. Claude needs at least 100k; 0 keeps the CLI\'s own default' },
    { key: 'maxCompactions', label: 'Stop after compactions', kind: 'slider', min: 0, max: 10, zero: 'No limit', tip: 'When the context of an agent has been compacted this many times in one run, the work is larger than one session: Plexus stops it, has it commit and report what is left. Claude only' },
    { key: 'decisionsCompactAt', label: 'Compact decision log at', kind: 'slider', unit: 'chars', min: 0, max: 30000, step: 500, zero: 'Never', tip: 'When the decision log grows past this, a librarian task rewrites it shorter. 0 never compacts it' },
  ] },
];

/** Keys each tab owns, for "reset to default" on the whole tab. */
export const engineKeys = (tab: EngineTab): CK[] => ENGINE_GROUPS[tab].groups.flatMap(g => g.fields.map(f => f.key));
const PROJECT_KEYS: (keyof ProjectSettings)[] = ['pipeline', 'maxParallel', 'maxTasks', 'maxAttempts', 'maxEvalRounds', 'reviewPolicy', 'reviewEnabled', 'reviewMinLines',
  'maxReviewCycles', 'independentReviewWaitMin', 'qaPhase', 'quotaStrategy', 'resumeSessions', 'autocompactTokens', 'maxCompactions', 'decisionsCompactAt'];

// ---------------------------------------------------------------- controls

/** Number input that keeps what is being typed and reports only valid values. */
function NumInput({ value, min, max, onValue, label }: { value: number; min: number; max: number; onValue: (n: number) => void; label: string }) {
  const [text, setText] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(String(value)); }, [value]);
  return (
    <input className="cfg-num num" type="number" min={min} max={max} value={text} aria-label={label}
      onFocus={() => { focused.current = true; }}
      onChange={e => {
        setText(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value !== '' && Number.isFinite(n) && n >= min && n <= max) onValue(Math.round(n));
      }}
      onBlur={() => { focused.current = false; setText(String(value)); }} />
  );
}

function TextInput({ value, onValue, label, placeholder }: { value: string; onValue: (s: string) => void; label: string; placeholder?: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return <input className="cfg-text mono" value={text} placeholder={placeholder} aria-label={label} spellCheck={false}
    onChange={e => setText(e.target.value)} onBlur={() => { if (text.trim() !== value) onValue(text.trim()); }}
    onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} />;
}

function Control<K extends string>({ f, value, bounds, onValue }: { f: Field<K>; value: unknown; bounds?: [number, number]; onValue: (v: unknown) => void }) {
  const min = f.min ?? bounds?.[0] ?? 0, max = f.max ?? bounds?.[1] ?? 100;
  // Always present, so number boxes line up in one column whether a row has a unit or not.
  const unit = <span className="cfg-unit">{f.unit ?? ''}</span>;
  if (f.kind === 'toggle') {
    return <button role="switch" aria-checked={!!value} aria-label={f.label} className="switch" onClick={() => onValue(!value)}><span className="switch-knob" /></button>;
  }
  if (f.kind === 'seg') {
    return (
      <div className="seg" role="radiogroup" aria-label={f.label}>
        {f.options!.map(o => <button key={o.value} role="radio" aria-checked={value === o.value} data-tip={o.tip} onClick={() => onValue(o.value)}>{o.label}</button>)}
      </div>
    );
  }
  if (f.kind === 'text') return <TextInput value={String(value ?? '')} onValue={onValue} label={f.label} placeholder={f.placeholder} />;
  const n = Number(value ?? 0);
  if (f.kind === 'number') return <span className="cfg-pair"><NumInput value={n} min={bounds?.[0] ?? min} max={bounds?.[1] ?? max} onValue={onValue} label={f.label} />{unit}</span>;
  // Slider with the exact figure next to it; the figure also takes values past the slider's range (within the bounds).
  const shown = Math.min(max, Math.max(min, n));
  const pct = max > min ? ((shown - min) / (max - min)) * 100 : 0;
  return (
    <span className="cfg-slider">
      <input type="range" min={min} max={max} step={f.step ?? 1} value={shown} aria-label={f.label} style={{ '--p': `${pct}%` } as CSSProperties}
        onChange={e => onValue(Number(e.target.value))} />
      <span className="cfg-pair">
        {f.zero && n === 0 ? <span className="cfg-zero" onClick={() => onValue(f.step ?? 1)}>{f.zero}</span>
          : <NumInput value={n} min={bounds?.[0] ?? min} max={bounds?.[1] ?? max} onValue={onValue} label={f.label} />}
        {f.zero && n === 0 ? null : unit}
      </span>
    </span>
  );
}

const fmtDefault = (v: unknown, f: Field<string>) => {
  if (f.kind === 'toggle') return v ? 'on' : 'off';
  if (f.kind === 'seg') return f.options?.find(o => o.value === v)?.label ?? String(v);
  if (f.kind === 'text') return v ? String(v) : 'empty';
  if (f.zero && v === 0) return f.zero;
  return `${typeof v === 'number' ? v.toLocaleString('en-US') : v}${f.unit ? ` ${f.unit}` : ''}`;
};

/** One setting: label (tooltip on hover), changed mark, control. Right-click resets it. */
function Row<K extends string>({ f, value, def, bounds, disabled, onValue, onReset }: {
  f: Field<K>; value: unknown; def: unknown; bounds?: [number, number]; disabled?: boolean; onValue: (v: unknown) => void; onReset: () => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const changed = JSON.stringify(value) !== JSON.stringify(def);
  return (
    <div className={`cfg-row ${disabled ? 'off' : ''} ${menu ? 'menu-open' : ''}`}
      onContextMenu={e => { if ((e.target as HTMLElement).closest('input[type=number], input.cfg-text')) return; e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}>
      <span className="cfg-label">
        <span className="cfg-name" data-tip={`${f.tip}. Default: ${fmtDefault(def, f as Field<string>)}`}>{f.label}</span>
        {changed && <span className="cfg-changed" title="Changed from the default" />}
      </span>
      <span className="cfg-control">
        <Control f={f} value={value} bounds={bounds} onValue={v => { if (!disabled) onValue(v); }} />
      </span>
      {menu && <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}
        items={[{ label: changed ? `Reset to default (${fmtDefault(def, f as Field<string>)})` : 'Already the default', icon: RotateCcw, disabled: !changed, onSelect: onReset }]} />}
    </div>
  );
}

const GroupBlock = ({ g, children }: { g: { title: string; note?: string }; children: ReactNode }) => (
  <div className="cfg-group">
    <div className="cfg-group-head"><h3>{g.title}</h3>{g.note && <span className="sub">{g.note}</span>}</div>
    <div className="cfg-rows">{children}</div>
  </div>
);

// ---------------------------------------------------------------- engine tabs

/** Saves each key a moment after its last change; the server answer is applied once nothing is pending. */
export function useConfig(onError: (e: string) => void) {
  const [view, setView] = useState<ConfigView | null>(null);
  const [saved, setSaved] = useState<SaveState>('idle');
  const pending = useRef<Record<string, unknown>>({});
  const timer = useRef<number>(undefined);
  const err = useRef(onError); err.current = onError;
  useEffect(() => { api<ConfigView>('GET', '/api/config').then(setView).catch(e => err.current(e.message)); }, []);
  const flush = () => {
    clearTimeout(timer.current);
    const body = pending.current;
    pending.current = {};
    if (!Object.keys(body).length) return;
    void api<ConfigView>('PATCH', '/api/config', body)
      .then(v => { if (!Object.keys(pending.current).length) { setView(v); setSaved('saved'); } })
      .catch(e => { setSaved('idle'); err.current(e.message); });
  };
  useEffect(() => () => flush(), []);
  const set = (patch: Partial<Record<CK, unknown>>, now = false) => {
    setView(v => {
      if (!v) return v;
      const config = { ...v.config };
      for (const [k, val] of Object.entries(patch)) (config as any)[k] = val === null ? v.defaults[k as CK] : val;
      return { ...v, config };
    });
    Object.assign(pending.current, patch);
    setSaved('saving');
    clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, now ? 0 : 450);
  };
  const resetKeys = (keys: CK[]) => set(Object.fromEntries(keys.map(k => [k, null])), true);
  const setProjectDefaults = (patch: Record<string, unknown>) => {
    setSaved('saving');
    return api<ConfigView>('PATCH', '/api/config/project-defaults', patch).then(v => { setView(v); setSaved('saved'); }).catch(e => { setSaved('idle'); err.current(e.message); });
  };
  return { view, saved, set, resetKeys, setProjectDefaults };
}
export type ConfigStore = ReturnType<typeof useConfig>;

const PRESETS = [
  { id: 'lean', label: 'Lean', factor: 0.5, tip: 'Half the default sizes: fewer tokens, agents open the full files more often' },
  { id: 'balanced', label: 'Balanced', factor: 1, tip: 'The default sizes' },
  { id: 'generous', label: 'Generous', factor: 2, tip: 'Twice the default sizes: more context up front, more tokens on every call' },
] as const;
const SIZE_KEYS: CK[] = ['briefChars', 'summaryChars', 'acceptanceChars', 'codemapChars', 'decisionsFullChars', 'decisionsRelevantChars', 'issuesChars', 'taskIssuesChars', 'laneNotesChars'];

function PromptPreset({ store }: { store: ConfigStore }) {
  const v = store.view!;
  const scaled = (k: CK, f: number) => {
    const [lo, hi] = v.bounds[k] ?? [0, Infinity];
    return Math.min(hi, Math.max(lo, Math.round(((v.defaults[k] as number) * f) / 100) * 100));
  };
  const cur = PRESETS.find(p => SIZE_KEYS.every(k => v.config[k] === scaled(k, p.factor)))?.id ?? 'custom';
  return (
    <div className="cfg-row">
      <span className="cfg-label"><span className="cfg-name" data-tip="Set every prompt size below at once. Adjust single sizes afterwards if needed">Size preset</span></span>
      <span className="cfg-control">
        <div className="seg" role="radiogroup" aria-label="Size preset">
          {PRESETS.map(p => <button key={p.id} role="radio" aria-checked={cur === p.id} data-tip={p.tip}
            onClick={() => store.set(Object.fromEntries(SIZE_KEYS.map(k => [k, p.factor === 1 ? null : scaled(k, p.factor)])), true)}>{p.label}</button>)}
          {cur === 'custom' && <button role="radio" aria-checked data-tip="Sizes set one by one">Custom</button>}
        </div>
      </span>
    </div>
  );
}

export function EngineSettings({ tab, title, store }: { tab: EngineTab; title: string; store: ConfigStore }) {
  const v = store.view;
  const spec = ENGINE_GROUPS[tab];
  return (
    <section className="cfg">
      <div className="settings-head"><h2>{title}</h2><SaveMarkSlot s={store.saved} /></div>
      <p className="lead">{spec.lead}</p>
      {!v ? <div className="sub cfg-loading">Loading</div> : spec.groups.map(g => (
        <GroupBlock key={g.title} g={g}>
          {tab === 'context' && g.title === 'Prompt size' && <PromptPreset store={store} />}
          {g.fields.map(f => (
            <Row key={f.key} f={f} value={v.config[f.key]} def={v.defaults[f.key]} bounds={v.bounds[f.key]}
              onValue={x => store.set({ [f.key]: x })} onReset={() => store.resetKeys([f.key])} />
          ))}
        </GroupBlock>
      ))}
    </section>
  );
}

// ---------------------------------------------------------------- project tab

type Scope = 'project' | 'defaults';

/** Value of a project field; `review` folds reviewEnabled into the policy. */
const projValue = (s: ProjectSettings, k: PK): unknown =>
  k === 'review' ? (s.reviewEnabled === false ? 'never' : s.reviewPolicy) : k === 'autocompactTokens' ? Math.round(s.autocompactTokens / 1000) : s[k];
const projPatch = (k: PK, v: unknown): Partial<ProjectSettings> =>
  k === 'review' ? { reviewPolicy: v as ProjectSettings['reviewPolicy'], reviewEnabled: true }
    : k === 'autocompactTokens' ? { autocompactTokens: Number(v) * 1000 } : { [k]: v } as Partial<ProjectSettings>;

export function ProjectSettingsPanel({ project, reloadProject, store, scope, onScope, onError }: {
  project: Project | null; reloadProject: () => void; store: ConfigStore; scope: Scope; onScope: (s: Scope) => void; onError: (e: string) => void;
}) {
  const v = store.view;
  const [local, setLocal] = useState<ProjectSettings | null>(project?.settings ?? null);
  const [saved, setSaved] = useState<SaveState>('idle');
  const pending = useRef<Partial<ProjectSettings>>({});
  const timer = useRef<number>(undefined);
  const pid = useRef(project?.id);
  useEffect(() => { if (!Object.keys(pending.current).length) setLocal(project?.settings ?? null); }, [project]);
  const flush = () => {
    clearTimeout(timer.current);
    const body = pending.current; pending.current = {};
    if (!Object.keys(body).length || !pid.current) return;
    void api('PATCH', `/api/projects/${pid.current}`, { settings: body }).then(() => { setSaved('saved'); reloadProject(); }).catch(e => { setSaved('idle'); onError(e.message); });
  };
  useEffect(() => { pid.current = project?.id; return flush; }, [project?.id]);

  const scopeProject = scope === 'project' && !!project;
  const cur: ProjectSettings | null = scopeProject ? local : v?.projectDefaults ?? null;
  // A project's own default is what new projects start with; the new-project defaults fall back to the built-in ones.
  const base: ProjectSettings | null = scopeProject ? v?.projectDefaults ?? null : v?.projectBuiltin ?? null;
  const apply = (patch: Partial<ProjectSettings>, now = false) => {
    if (scopeProject) {
      setLocal(s => (s ? { ...s, ...patch } : s));
      Object.assign(pending.current, patch);
      setSaved('saving');
      clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, now ? 0 : 450);
    } else void store.setProjectDefaults(patch as Record<string, unknown>);
  };

  return (
    <section className="cfg">
      <div className="settings-head"><h2>Project</h2><SaveMarkSlot s={scopeProject ? saved : store.saved} /></div>
      <p className="lead">How a project is built, reviewed and spread over accounts. Change the open project, or the values new projects start with.</p>
      <div className="seg cfg-scope" role="radiogroup" aria-label="Applies to">
        <button role="radio" aria-checked={scopeProject} disabled={!project} onClick={() => onScope('project')}
          data-tip={project ? `Settings of ${project.name}` : 'Open a project to change its settings'}>{project ? project.name : 'This project'}</button>
        <button role="radio" aria-checked={!scopeProject} onClick={() => onScope('defaults')} data-tip="What every new project starts with">New projects</button>
      </div>
      {!cur || !base ? <div className="sub cfg-loading">Loading</div> : PROJECT_GROUPS.map(g => (
        <GroupBlock key={g.title} g={g}>
          {g.fields.map(f => (
            <Row key={f.key} f={f} value={projValue(cur, f.key)} def={projValue(base, f.key)}
              disabled={f.key === 'reviewMinLines' && projValue(cur, 'review') !== 'auto'}
              onValue={x => apply(projPatch(f.key, x))}
              onReset={() => apply(projPatch(f.key, projValue(base, f.key)), true)} />
          ))}
        </GroupBlock>
      ))}
    </section>
  );
}

/** Reset every field of the Project tab (open project → new-project defaults; new-project defaults → built-in). */
export function resetProjectTab(scope: Scope, project: Project | null, store: ConfigStore, reloadProject: () => void, onError: (e: string) => void) {
  const v = store.view;
  if (!v) return;
  if (scope === 'project' && project) {
    const body = Object.fromEntries(PROJECT_KEYS.map(k => [k, v.projectDefaults[k]]));
    void api('PATCH', `/api/projects/${project.id}`, { settings: body }).then(reloadProject).catch(e => onError(e.message));
  } else void store.setProjectDefaults(Object.fromEntries(PROJECT_KEYS.map(k => [k, null])));
}

// ---------------------------------------------------------------- small shared bits

export const SaveMarkSlot = ({ s }: { s: SaveState }) => (
  <span className={`save-mark ${s}`} aria-live="polite">{s === 'saving' ? 'Saving' : s === 'saved' ? <><Ic i={Check} size={14} />Saved</> : ''}</span>
);

/** One tooltip for every `[data-tip]` inside `root`: shown after a short pause, under the element, kept on screen. */
export function TooltipLayer({ root }: { root: RefObject<HTMLElement | null> }) {
  const [tip, setTip] = useState<{ text: string; x: number; y: number; above: boolean } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let t = 0, cur: HTMLElement | null = null;
    const show = (target: HTMLElement) => {
      const text = target.dataset.tip;
      if (!text) return;
      const r = target.getBoundingClientRect();
      const above = r.bottom + 80 > innerHeight;
      setTip({ text, x: r.left, y: above ? r.top - 6 : r.bottom + 6, above });
    };
    const over = (e: Event) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>('[data-tip]');
      if (target === cur) return;
      cur = target; clearTimeout(t); setTip(null);
      if (target) t = window.setTimeout(() => show(target), e.type === 'focusin' ? 0 : 400);
    };
    const out = (e: Event) => {
      const to = (e as MouseEvent).relatedTarget as HTMLElement | null;
      if (cur && to && cur.contains(to)) return;
      cur = null; clearTimeout(t); setTip(null);
    };
    const hide = () => { cur = null; clearTimeout(t); setTip(null); };
    el.addEventListener('mouseover', over); el.addEventListener('mouseout', out);
    el.addEventListener('focusin', over); el.addEventListener('focusout', hide);
    el.addEventListener('mousedown', hide); el.addEventListener('scroll', hide, true);
    return () => {
      clearTimeout(t);
      el.removeEventListener('mouseover', over); el.removeEventListener('mouseout', out);
      el.removeEventListener('focusin', over); el.removeEventListener('focusout', hide);
      el.removeEventListener('mousedown', hide); el.removeEventListener('scroll', hide, true);
    };
  }, [root]);
  const [x, setX] = useState(0);
  useEffect(() => {
    const w = ref.current?.offsetWidth ?? 0;
    if (tip) setX(Math.max(8, Math.min(tip.x, innerWidth - w - 8)));
  }, [tip]);
  if (!tip) return null;
  return <div ref={ref} className={`tooltip ${tip.above ? 'above' : ''}`} role="tooltip" style={{ left: x || tip.x, top: tip.y }}>{tip.text}</div>;
}

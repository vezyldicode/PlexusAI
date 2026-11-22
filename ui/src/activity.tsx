// What an agent did besides talking: its tool calls, folded into one quiet line the way a reader skims them, and its
// checklist (the plexus_plan tool), pinned above the message box.
import { useState } from 'react';
import { Check, ChevronRight } from 'lucide-react';
import type { PlanItem } from './types.ts';
import { Ic } from './ui.tsx';

export type { PlanItem };

export function parsePlan(text: string): PlanItem[] | null {
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) && v.length ? v.filter(x => x && typeof x.text === 'string') : null;
  } catch { return null; }
}

/** A plan as one line, for logs and the network card: "Plan 2/5 · Run the tests". */
export function planLine(items: PlanItem[]): string {
  const done = items.filter(x => x.status === 'completed').length;
  const now = items.find(x => x.status === 'in_progress') ?? items.find(x => x.status === 'pending');
  return `Plan ${done}/${items.length}${now ? ` · ${now.text}` : ''}`;
}

// ---------------------------------------------------------------- tool calls

/** What kind of thing a tool line did, from its first word (Claude tool names, Codex `shell` / `edit`, plexus tools). */
type Verb = 'command' | 'read' | 'edit' | 'search' | 'web' | 'agent' | 'plexus' | 'other' | 'status';

function verbOf(kind: string, text: string): { verb: Verb; n: number } {
  if (kind === 'status') return { verb: 'status', n: 1 };
  const [head, ...rest] = text.trim().split(/\s+/);
  const name = (head ?? '').replace(/^mcp__\w+?__/, '');
  if (/^(Bash|PowerShell|shell|BashOutput|KillShell|Monitor)$/i.test(name)) return { verb: 'command', n: 1 };
  if (/^(Read|NotebookRead)$/.test(name)) return { verb: 'read', n: 1 };
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(name)) return { verb: 'edit', n: 1 };
  if (name === 'edit') return { verb: 'edit', n: Math.max(1, rest.join(' ').split(',').filter(x => x.trim()).length) };
  if (/^(Grep|Glob|LS|ToolSearch)$/.test(name)) return { verb: 'search', n: 1 };
  if (/^(WebSearch|WebFetch|web_search)$/.test(name)) return { verb: 'web', n: 1 };
  if (/^(Task|Agent|SendMessage)$/.test(name)) return { verb: 'agent', n: 1 };
  if (name.startsWith('plexus_')) return { verb: 'plexus', n: 1 };
  return { verb: 'other', n: 1 };
}

const PHRASE: Record<Exclude<Verb, 'status'>, (n: number) => string> = {
  command: n => n === 1 ? 'ran a command' : `ran ${n} commands`,
  read: n => n === 1 ? 'read a file' : `read ${n} files`,
  edit: n => n === 1 ? 'edited a file' : `edited ${n} files`,
  search: n => n === 1 ? 'searched once' : `searched ${n} times`,
  web: n => n === 1 ? 'looked up the web' : `made ${n} web lookups`,
  agent: n => n === 1 ? 'asked a sub-agent' : `asked ${n} sub-agents`,
  plexus: n => n === 1 ? 'checked Plexus' : `made ${n} Plexus calls`,
  other: n => n === 1 ? 'used a tool' : `used ${n} tools`,
};

/** "Ran 2 commands, read 3 files, edited a file", in the order each kind first appears. */
export function summarize(lines: { kind: string; text: string }[]): string {
  const counts = new Map<Verb, number>();
  for (const l of lines) { const { verb, n } = verbOf(l.kind, l.text); counts.set(verb, (counts.get(verb) ?? 0) + n); }
  const parts = [...counts].filter(([v]) => v !== 'status').map(([v, n]) => PHRASE[v as Exclude<Verb, 'status'>](n));
  if (!parts.length) { const n = counts.get('status') ?? 0; return n === 1 ? 'Status update' : `${n} status updates`; }
  const s = parts.join(', ');
  return s[0].toUpperCase() + s.slice(1);
}

/**
 * A run of tool calls (and status lines) between two messages: one grey line that names what happened, opening to the
 * calls themselves. `live` marks the group the agent is still adding to.
 */
export function ToolGroup({ lines, live, note }: { lines: { kind: string; text: string }[]; live?: boolean; note?: string }) {
  const [open, setOpen] = useState(false);
  if (!lines.length) return null;
  const last = lines.at(-1)!;
  return (
    <div className={`tgroup ${open ? 'open' : ''}`}>
      <button className="tgroup-head" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <span className="tgroup-sum">{summarize(lines)}</span>
        {note && <span className="tgroup-note num">{note}</span>}
        <Ic i={ChevronRight} size={14} />
      </button>
      {live && !open && last.kind === 'tool' && <div className="tgroup-now mono">{last.text}</div>}
      {open && (
        <ol className="tgroup-list">
          {lines.map((l, i) => <li key={i} className={`k-${l.kind}`}><span className="mono">{l.text}</span></li>)}
        </ol>
      )}
    </div>
  );
}

/** Status lines the run's end already says (how the CLI turn ended). */
const REDUNDANT = /^(result: success|turn completed)$/;

/** The items of a stream between messages: text stays as it is, each run of other events becomes one group. */
export function groupEvents<E extends { kind: string; text: string }>(events: E[]): ({ type: 'text'; e: E } | { type: 'group'; lines: E[] })[] {
  const out: ({ type: 'text'; e: E } | { type: 'group'; lines: E[] })[] = [];
  for (const e of events) {
    if (e.kind === 'plan' || e.kind === 'raw' || (e.kind === 'status' && REDUNDANT.test(e.text))) continue;
    const prev = out.at(-1);
    // Paragraphs the agent wrote one after another read as one message.
    if (e.kind === 'text') {
      if (prev?.type === 'text') prev.e = { ...prev.e, text: `${prev.e.text}

${e.text}` };
      else out.push({ type: 'text', e });
      continue;
    }
    if (prev?.type === 'group') prev.lines.push(e);
    else out.push({ type: 'group', lines: [e] });
  }
  return out;
}

// ---------------------------------------------------------------- checklist

/**
 * The agent's checklist: a header with how far it got, and the steps. Folds to the header; done steps go quiet, the
 * step in progress carries the live accent.
 */
export function PlanCard({ items, live }: { items: PlanItem[]; live: boolean }) {
  const done = items.filter(x => x.status === 'completed').length;
  // A finished plan folds to its header; one in progress shows its steps.
  const [open, setOpen] = useState(live || done < items.length);
  const now = items.find(x => x.status === 'in_progress');
  return (
    <section className={`plan ${open ? 'open' : ''}`} aria-label="Plan">
      <button className="plan-head" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <span className="plan-title">Plan</span>
        <span className="plan-count num">{done} of {items.length}</span>
        {!open && now && <span className="plan-now">{now.text}</span>}
        <Ic i={ChevronRight} size={14} />
      </button>
      {open && (
        <ol className="plan-list">
          {items.map((x, i) => (
            <li key={i} className={`plan-item s-${x.status} ${live ? 'live' : ''}`}>
              <span className="plan-mark" aria-label={x.status.replace('_', ' ')}>{x.status === 'completed' && <Ic i={Check} size={12} />}</span>
              <span className="plan-text">{x.text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

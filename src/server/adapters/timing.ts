import type { Provider, RunTiming } from '../../shared/types.ts';

/**
 * Where a run's wall time goes, read from the CLI's stream as the lines arrive: process startup (spawn to first event),
 * tool execution (time while at least one tool call is open, so parallel calls are not counted twice), automatic
 * compaction (Claude reports its duration) and the rest, which is the model reading and writing.
 */
export interface RunTimer {
  line(line: string, at?: number): void;
  /** Compactions seen so far (Claude's compact_boundary events). */
  readonly compactions: number;
  finish(at?: number): RunTiming;
}

export function createRunTimer(provider: Provider, startedAt = Date.now()): RunTimer {
  let first: number | null = null, toolMs = 0, compactMs = 0, compactions = 0, toolCalls = 0;
  const open = new Set<string>();
  const calls = new Set<string>();
  let openSince = 0;
  const openTool = (id: string, at: number) => {
    if (open.has(id)) return;
    if (!open.size) openSince = at;
    open.add(id);
    toolCalls++;
  };
  const closeTool = (id: string, at: number) => {
    if (!open.delete(id)) return;
    if (!open.size) toolMs += at - openSince;
  };

  const claude = (e: any, at: number) => {
    if (e.type === 'assistant') {
      if (e.parent_tool_use_id) return; // a sub-agent's own calls run inside the parent's tool call
      if (e.message?.id) calls.add(e.message.id);
      for (const c of e.message?.content ?? []) if (c?.type === 'tool_use' && c.id) openTool(c.id, at);
    } else if (e.type === 'user') {
      for (const c of e.message?.content ?? []) if (c?.type === 'tool_result' && c.tool_use_id) closeTool(c.tool_use_id, at);
    } else if (e.type === 'system' && e.subtype === 'compact_boundary') {
      compactions++;
      compactMs += Number(e.compact_metadata?.duration_ms) || 0;
    }
  };
  const codex = (e: any, at: number) => {
    const it = e.item ?? {};
    const isTool = ['command_execution', 'mcp_tool_call', 'web_search'].includes(it.type);
    if (isTool && it.id && e.type === 'item.started') openTool(it.id, at);
    else if (isTool && it.id && e.type === 'item.completed') closeTool(it.id, at);
    else if (/compact/i.test(String(e.type)) || /compact/i.test(String(it.type ?? ''))) { if (e.type !== 'item.started') compactions++; }
  };

  return {
    line(line: string, at = Date.now()) {
      if (first === null) first = at;
      let e: any;
      try { e = JSON.parse(line); } catch { return; }
      if (provider === 'claude') claude(e, at); else if (provider === 'codex') codex(e, at);
    },
    get compactions() { return compactions; },
    finish(at = Date.now()): RunTiming {
      if (open.size) { toolMs += at - openSince; open.clear(); }
      const totalMs = Math.max(0, at - startedAt);
      const startupMs = Math.max(0, (first ?? at) - startedAt);
      const modelMs = Math.max(0, totalMs - startupMs - toolMs - compactMs);
      return { totalMs, startupMs, modelMs, toolMs, compactMs, waitMs: 0, toolCalls, compactions, ...(calls.size ? { calls: calls.size } : {}) };
    },
  };
}

/** Timing of an attempt made of several CLI invocations (a failed resume and the fresh start, a checkpoint turn). */
export function addTiming(a: RunTiming | null | undefined, b: RunTiming | null | undefined): RunTiming | null {
  if (!a) return b ?? null;
  if (!b) return a;
  const calls = (a.calls ?? 0) + (b.calls ?? 0);
  return {
    totalMs: a.totalMs + b.totalMs, startupMs: a.startupMs + b.startupMs, modelMs: a.modelMs + b.modelMs, toolMs: a.toolMs + b.toolMs,
    compactMs: a.compactMs + b.compactMs, waitMs: a.waitMs + b.waitMs, toolCalls: a.toolCalls + b.toolCalls, compactions: a.compactions + b.compactions,
    ...(calls ? { calls } : {}),
  };
}

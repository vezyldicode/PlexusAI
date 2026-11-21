// An agent's checklist: the steps of its work and where it stands. Agents report it with the `plexus_plan` tool (Plexus's
// MCP server), or with their CLI's own todo tool where it has one (Claude Code TodoWrite, Codex todo_list items). The
// stream event carries the whole list each time, so the latest event is the current plan.
import type { PlanItem } from '../../shared/types.ts';

export const PLAN_TOOL = 'plexus_plan';

export type StreamEvent = { kind: 'text' | 'tool' | 'status' | 'plan' | 'raw'; text: string };

const STATUSES = new Set(['pending', 'in_progress', 'completed']);

/** The items of a plan in any of the shapes the tools use, or null when there are none. */
export function planItems(list: unknown): PlanItem[] | null {
  if (!Array.isArray(list)) return null;
  const items: PlanItem[] = [];
  for (const x of list) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const text = String(o.step ?? o.text ?? o.content ?? '').trim();
    if (!text) continue;
    const status = typeof o.status === 'string' && STATUSES.has(o.status) ? o.status as PlanItem['status']
      : o.completed === true ? 'completed' : 'pending';
    items.push({ text: text.slice(0, 300), status });
  }
  return items.length ? items.slice(0, 50) : null;
}

export const planEvent = (items: PlanItem[]): StreamEvent => ({ kind: 'plan', text: JSON.stringify(items) });

/** The plan an event carries (its text is the JSON list). */
export function parsePlan(text: string): PlanItem[] | null {
  try { return planItems(JSON.parse(text)); } catch { return null; }
}

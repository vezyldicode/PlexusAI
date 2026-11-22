// Drag and drop on the task board: which column a card may be dropped on, and what the drop does.
// A drop only calls the existing task endpoints; Plexus sets running, in review and done itself.
import type { Task } from './types.ts';

export type DropAction = 'retry' | 'cancel';

/** Columns that accept drops, by title, with the statuses a card may come from. */
const DROPS: Record<string, { action: DropAction; from: Task['status'][] }> = {
  'Queued': { action: 'retry', from: ['blocked', 'failed', 'cancelled', 'interrupted', 'done'] },
  'Failed or cancelled': { action: 'cancel', from: ['pending', 'interrupted', 'blocked', 'running'] },
};

/** What dropping a task with this status on the column does, or null when the column does not accept it. */
export function dropAction(status: Task['status'], column: string): DropAction | null {
  const d = DROPS[column];
  return d && d.from.includes(status) ? d.action : null;
}

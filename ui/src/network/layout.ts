import type { Task } from '../types.ts';

/**
 * Lays the agent network out as lanes, left to right:
 *  - the coordinator (main agent) on the far left,
 *  - one "Pipeline" lane for the phase tasks (analyse → architect → plan → QA → evaluate),
 *  - one lane per feature: a root build task followed by its review / fix / integrate children,
 *  - one "From chat" lane, last, for the work asked for in the coordinator chat and the coordinator's own edits,
 *    laid out as a grid because those tasks don't depend on each other.
 * Positions are deterministic so nodes don't jump around while Plexus runs.
 */

export const NODE_W = 208;
export const NODE_H = 76;
export const COORD_W = 208;
export const COORD_H = 76;
const COL = 256;          // node width + horizontal gap
const ROW = 92;           // node height + vertical gap inside a lane
const LANE_LABEL = 28;    // lane title above its nodes
const LANE_GAP = 32;      // space between lanes
const LEFT = COORD_W + 96; // first task column starts after the coordinator

const PIPELINE_KINDS = new Set(['ingest', 'architect', 'plan', 'qa', 'evaluate']);
const FINISHED = new Set(['done', 'cancelled']);
const CHAT = 'chat';
const CHAT_COLS = 2; // as wide as the pipeline lane

/** Where a task came from: the planned pipeline, the coordinator chat, or the coordinator's own edit. */
export const originOf = (t: Task): 'plan' | 'chat' | 'coordinator' => (t.kind === 'coordinator' ? 'coordinator' : t.adhoc ? 'chat' : 'plan');

export interface NodeBox { id: string; x: number; y: number; task: Task }
export interface Edge { id: string; from: string; to: string; kind: 'assign' | 'parent' | 'dep' | 'flow'; live: boolean; d: string }
export interface Lane { id: string; title: string; x: number; y: number; w: number; h: number; done: number; total: number; finished: boolean; running: number }
export interface Graph { nodes: NodeBox[]; edges: Edge[]; lanes: Lane[]; coord: { x: number; y: number }; width: number; height: number; hiddenLanes: number }

export const COORDINATOR = 'coordinator';

export function layout(tasks: Task[], showFinished: boolean): Graph {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const rootOf = (t: Task): Task => {
    let cur = t;
    const seen = new Set<string>();
    while (cur.parentId && byId.has(cur.parentId) && !seen.has(cur.id)) { seen.add(cur.id); cur = byId.get(cur.parentId)!; }
    return cur;
  };
  const depthOf = (t: Task): number => {
    let d = 0, cur = t;
    const seen = new Set<string>();
    while (cur.parentId && byId.has(cur.parentId) && !seen.has(cur.id)) { seen.add(cur.id); cur = byId.get(cur.parentId)!; d++; }
    return d;
  };

  // Group into lanes.
  const sorted = [...tasks].sort((a, b) => a.seq - b.seq);
  const pipelineRoots = sorted.filter(t => !t.parentId && PIPELINE_KINDS.has(t.kind));
  const pipeIndex = new Map(pipelineRoots.map((t, i) => [t.id, i]));
  const laneOf = new Map<string, string>();
  const laneTasks = new Map<string, Task[]>();
  const laneOrder: string[] = [];
  for (const t of sorted) {
    const r = rootOf(t);
    const key = r.adhoc ? CHAT : PIPELINE_KINDS.has(r.kind) && !r.parentId ? 'pipeline' : r.id;
    laneOf.set(t.id, key);
    if (!laneTasks.has(key)) { laneTasks.set(key, []); laneOrder.push(key); }
    laneTasks.get(key)!.push(t);
  }
  // Pipeline first, features in creation order, chat last.
  const rank = (k: string) => (k === 'pipeline' ? 0 : k === CHAT ? 2 : 1);
  laneOrder.sort((a, b) => rank(a) - rank(b));

  const nodes: NodeBox[] = [];
  const lanes: Lane[] = [];
  const pos = new Map<string, NodeBox>();
  let y = 0;
  let maxX = LEFT + NODE_W;
  let hiddenLanes = 0;

  for (const key of laneOrder) {
    const list = laneTasks.get(key)!;
    const done = list.filter(t => FINISHED.has(t.status)).length;
    const finished = key !== 'pipeline' && done === list.length;
    if (finished && !showFinished) { hiddenLanes++; continue; }

    const cols = new Map<number, Task[]>();
    // Chat lane: newest first, so recent work stays near the top.
    const ordered = key === CHAT ? [...list].reverse() : list;
    ordered.forEach((t, i) => {
      const col = key === CHAT ? i % CHAT_COLS : key === 'pipeline' ? (pipeIndex.get(rootOf(t).id) ?? 0) + depthOf(t) : depthOf(t);
      if (!cols.has(col)) cols.set(col, []);
      cols.get(col)!.push(t);
    });
    const rows = Math.max(...[...cols.values()].map(c => c.length));
    const top = y + LANE_LABEL;
    for (const [col, ts] of cols) {
      ts.forEach((t, i) => {
        const n = { id: t.id, x: LEFT + col * COL, y: top + i * ROW, task: t };
        nodes.push(n); pos.set(t.id, n);
        maxX = Math.max(maxX, n.x + NODE_W);
      });
    }
    const colCount = Math.max(...cols.keys()) + 1;
    const root = list[0];
    lanes.push({
      id: key, title: key === 'pipeline' ? 'Pipeline' : key === CHAT ? 'From chat' : `T${root.seq} ${root.title}`,
      x: LEFT, y, w: (colCount - 1) * COL + NODE_W, h: LANE_LABEL + (rows - 1) * ROW + NODE_H,
      done, total: list.length, finished, running: list.filter(t => t.status === 'running').length,
    });
    y = top + (rows - 1) * ROW + NODE_H + LANE_GAP;
  }

  const height = Math.max(COORD_H, y - LANE_GAP);
  // The coordinator sits level with the first lane, so it stays on screen when the view is anchored top-left.
  const coord = { x: 0, y: lanes.length ? LANE_LABEL - 4 : 0 };

  // Edges.
  const edges: Edge[] = [];
  const add = (from: string, to: string, kind: Edge['kind']) => {
    const a = from === COORDINATOR ? { x: coord.x, y: coord.y, w: COORD_W, h: COORD_H } : pos.get(from) && { ...pos.get(from)!, w: NODE_W, h: NODE_H };
    const b = pos.get(to);
    if (!a || !b) return;
    const live = b.task.status === 'running';
    edges.push({ id: `${kind}:${from}>${to}`, from, to, kind, live, d: curve(a.x + a.w, a.y + a.h / 2, b.x, b.y + NODE_H / 2) });
  };
  const visible = (id: string) => pos.has(id);
  let prevPipe: string | null = null;
  for (const t of pipelineRoots) {
    if (!visible(t.id)) continue;
    add(prevPipe ?? COORDINATOR, t.id, prevPipe ? 'flow' : 'assign');
    prevPipe = t.id;
  }
  for (const t of sorted) {
    if (!visible(t.id)) continue;
    if (t.parentId && visible(t.parentId)) add(t.parentId, t.id, 'parent');
    // Chat tasks get an edge only while they run; a line to every past request would bury the feature lanes.
    else if (laneOf.get(t.id) === CHAT ? t.status === 'running' : laneOf.get(t.id) !== 'pipeline') add(COORDINATOR, t.id, 'assign');
    for (const d of t.deps) {
      if (!visible(d)) continue;
      if (laneOf.get(d) === 'pipeline' && laneOf.get(t.id) === 'pipeline') continue; // already drawn as flow
      add(d, t.id, 'dep');
    }
  }
  // Running agents report back to the coordinator; draw their edges last so the signal sits on top.
  edges.sort((a, b) => Number(a.live) - Number(b.live) || order(a.kind) - order(b.kind));

  return { nodes, edges, lanes, coord, width: maxX, height, hiddenLanes };
}

const order = (k: Edge['kind']) => ({ dep: 0, assign: 1, flow: 2, parent: 3 })[k];

function curve(x1: number, y1: number, x2: number, y2: number): string {
  if (x2 > x1 + 16) {
    const c = Math.max(32, (x2 - x1) / 2);
    return `M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}`;
  }
  // Target sits left of (or under) the source: loop out to the right and come back in from the left.
  const c = 64;
  return `M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}`;
}

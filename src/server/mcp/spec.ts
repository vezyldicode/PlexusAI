import { join } from 'node:path';
import type { McpServerSpec } from '../adapters/types.ts';
import { PLAN_TOOL } from '../adapters/plan.ts';
import { appRoot } from '../paths.ts';

/** The `plexus` MCP server (plexus-mcp.ts, run by this same Node or Electron binary) with the given environment. */
export function plexusMcp(env: Record<string, string>): McpServerSpec {
  return {
    name: 'plexus', command: process.execPath, args: [join(appRoot, 'src', 'server', 'mcp', 'plexus-mcp.ts')],
    env: { ...env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
  };
}

/** What a task agent gets: only the checklist tool, which needs no connection to the daemon. */
export const taskMcp = (): McpServerSpec => plexusMcp({ PLEXUS_TOOLS: PLAN_TOOL });

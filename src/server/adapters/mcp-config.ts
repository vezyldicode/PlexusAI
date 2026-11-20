import { writeFileSync } from 'node:fs';
import type { RunSpec } from './types.ts';

/** Claude-style MCP config file (`{ "mcpServers": { name: { command, args, env } } }`) next to the run's log. */
export function writeMcpConfig(spec: RunSpec): string | null {
  if (!spec.mcp) return null;
  const file = `${spec.logPath}.mcp.json`;
  const { name, ...server } = spec.mcp;
  writeFileSync(file, JSON.stringify({ mcpServers: { [name]: server } }, null, 2));
  return file;
}

/** Codex `-c` overrides that register the MCP server (TOML values; JSON strings are valid TOML basic strings). */
export function codexMcpOverrides(spec: RunSpec): string[] {
  if (!spec.mcp) return [];
  const k = `mcp_servers.${spec.mcp.name}`;
  const env = `{ ${Object.entries(spec.mcp.env).map(([a, b]) => `${a} = ${JSON.stringify(b)}`).join(', ')} }`;
  return ['-c', `${k}.command=${JSON.stringify(spec.mcp.command)}`, '-c', `${k}.args=${JSON.stringify(spec.mcp.args)}`, '-c', `${k}.env=${env}`];
}

/** The prompt for a CLI without a system-prompt option: system part first. */
export const withSystem = (spec: RunSpec) => (spec.system && !spec.resumeId ? `${spec.system}\n\n${spec.prompt}` : spec.prompt);

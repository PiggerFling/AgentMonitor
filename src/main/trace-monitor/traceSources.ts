import os from 'node:os';
import path from 'node:path';
import { TRACE_TOOLS, type TraceDirs, type TraceSourceOptions, type TraceTool } from '../../shared/types';

/** Each tool's data directory variable and its default below the home directory. */
export const TRACE_TOOL_HOMES: Record<TraceTool, { env: string; home: string[] }> = {
  claude: { env: 'CLAUDE_CONFIG_DIR', home: ['.claude'] },
  codex: { env: 'CODEX_HOME', home: ['.codex'] },
  pi: { env: 'PI_CODING_AGENT_DIR', home: ['.pi', 'agent'] },
  hermes: { env: 'HERMES_HOME', home: ['.hermes'] },
};

const CONTROL = /[\u0000-\u001f\u007f]/;
/** A data directory usable on this machine: absolute, without control characters. */
export const validLocalDir = (value: string) => path.isAbsolute(value) && !CONTROL.test(value);

export const enabledTools = (options: TraceSourceOptions = {}): TraceTool[] => TRACE_TOOLS.filter(tool => !options.tools || options.tools.includes(tool));

/** A tool's data directory: the option, else its variable, else the default under `home`. */
export function traceDir(tool: TraceTool, options: TraceSourceOptions = {}, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return options.traceDirs?.[tool] || env[TRACE_TOOL_HOMES[tool].env] || path.join(home, ...TRACE_TOOL_HOMES[tool].home);
}

/** A data directory that already names the trace subdirectory is used as is (e.g. CODEX_HOME=/x/sessions). */
const childRoot = (dir: string, child: string) => path.basename(dir) === child ? dir : path.join(dir, child);

/** The trace file roots of the enabled tools. Hermes' state.db is read by HermesMonitor, not from these. */
export function traceRoots(options: TraceSourceOptions = {}, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string[] {
  return [...new Set(enabledTools(options).flatMap(tool => {
    const dir = traceDir(tool, options, env, home);
    if (tool === 'hermes') return [path.join(dir, 'session-exports', 'traces'), path.join(dir, 'sessions')];
    return [childRoot(dir, tool === 'claude' ? 'projects' : 'sessions')];
  }))];
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Validates `tools` and `traceDirs` (from servers.json, settings.json or IPC) and normalizes them: tools deduplicated in
 * TRACE_TOOLS order and dropped when all are listed, empty directories dropped, empty `traceDirs` dropped.
 * `validDir` checks each directory and `rule` describes it in the problem message.
 */
export function parseTraceSourceOptions(value: { tools?: unknown; traceDirs?: unknown }, validDir: (dir: string) => boolean, rule = 'an absolute path'): { options: TraceSourceOptions } | { problem: string } {
  const options: TraceSourceOptions = {};
  const { tools, traceDirs } = value;
  if (tools !== undefined) {
    if (!Array.isArray(tools) || tools.some(tool => !TRACE_TOOLS.includes(tool as TraceTool))) return { problem: `"tools" must be an array of ${TRACE_TOOLS.join(', ')}` };
    if (tools.length < TRACE_TOOLS.length || TRACE_TOOLS.some(tool => !tools.includes(tool))) options.tools = TRACE_TOOLS.filter(tool => tools.includes(tool));
  }
  if (traceDirs !== undefined) {
    if (!isRecord(traceDirs)) return { problem: '"traceDirs" must be an object' };
    const dirs: TraceDirs = {};
    for (const [tool, dir] of Object.entries(traceDirs)) {
      if (!TRACE_TOOLS.includes(tool as TraceTool)) return { problem: `"traceDirs" has an unknown tool "${tool}"` };
      if (dir === undefined || dir === '') continue;
      if (typeof dir !== 'string' || !validDir(dir)) return { problem: `"traceDirs.${tool}" must be ${rule}` };
      dirs[tool as TraceTool] = dir;
    }
    if (Object.keys(dirs).length) options.traceDirs = Object.fromEntries(TRACE_TOOLS.filter(tool => dirs[tool]).map(tool => [tool, dirs[tool]]));
  }
  return { options };
}

/** Agent command line arguments for `options` (see src/agent/index.ts), one `--name=value` word each. */
export function agentTraceArgs(options: TraceSourceOptions): string[] {
  return [
    ...(options.tools ? [`--tools=${options.tools.join(',')}`] : []),
    ...TRACE_TOOLS.flatMap(tool => options.traceDirs?.[tool] ? [`--${tool}-dir=${options.traceDirs[tool]}`] : []),
  ];
}

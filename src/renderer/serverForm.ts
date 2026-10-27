import { TRACE_TOOLS } from '../shared/types';
import type { SshHostInfo, TraceDirs, TraceSourceOptions, TraceTool } from '../shared/types';

export const TOOL_LABELS: Record<TraceTool, string> = { claude: 'Claude Code', codex: 'Codex', pi: 'Pi', hermes: 'Hermes' };
/** The environment variable each tool reads its data directory from. */
export const TOOL_ENV: Record<TraceTool, string> = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME', pi: 'PI_CODING_AGENT_DIR', hermes: 'HERMES_HOME' };
const DEFAULT_SUBDIRS: Record<TraceTool, string> = { claude: '.claude', codex: '.codex', pi: '.pi/agent', hermes: '.hermes' };

/** The directory a tool uses when nothing is configured; `home` turns `~` into a real path when known. */
export function defaultTraceDir(tool: TraceTool, home?: string): string {
  return home ? `${home.replace(/\/+$/, '')}/${DEFAULT_SUBDIRS[tool]}` : `~/${DEFAULT_SUBDIRS[tool]}`;
}

const FORGE_HOST = /(^|\.)(github\.com|gitlab\.com|bitbucket\.org)$/i;

/** ssh config entries that only exist to push to a git forge (github.com and friends, or `User git`). */
export function isGitForgeHost(host: Pick<SshHostInfo, 'alias' | 'hostName' | 'user'>): boolean {
  if (host.user === 'git') return true;
  return [host.alias, host.hostName].some((name) => name !== undefined && FORGE_HOST.test(name));
}

export interface SshHostView {
  hosts: SshHostInfo[];
  /** Git-forge hosts matching the search that are hidden unless `showAll` is set. */
  hiddenForgeHosts: number;
  /** Git-forge hosts matching the search, shown or not. */
  forgeHosts: number;
}

/**
 * Hosts to offer for adding: matching `query` (alias, host name or user), git-forge aliases hidden unless
 * `showAll`, and then sunk to the end. Hosts that are already added are always shown.
 */
export function filterSshHosts(hosts: readonly SshHostInfo[], query: string, showAll: boolean): SshHostView {
  const needle = query.trim().toLowerCase();
  const matches = hosts.filter((host) => !needle || [host.alias, host.hostName, host.user].some((value) => value?.toLowerCase().includes(needle)));
  const forge = matches.filter((host) => !host.serverId && isGitForgeHost(host));
  const others = matches.filter((host) => !forge.includes(host));
  return { hosts: showAll ? [...others, ...forge] : others, hiddenForgeHosts: showAll ? 0 : forge.length, forgeHosts: forge.length };
}

/** Extra ssh arguments typed as one line; quoting is not supported, every whitespace-separated word is one argument. */
export function parseSshArgs(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

export function formatSshArgs(args: readonly string[] | undefined): string {
  return (args ?? []).join(' ');
}

/** Editable state of a machine's tool toggles and data directories (an empty directory means the default). */
export interface TraceSourceForm { tools: Record<TraceTool, boolean>; dirs: Record<TraceTool, string> }

function formFrom(enabled: (tool: TraceTool) => boolean, dirs: TraceDirs = {}): TraceSourceForm {
  return {
    tools: Object.fromEntries(TRACE_TOOLS.map((tool) => [tool, enabled(tool)])) as Record<TraceTool, boolean>,
    dirs: Object.fromEntries(TRACE_TOOLS.map((tool) => [tool, dirs[tool] ?? ''])) as Record<TraceTool, string>,
  };
}

export function traceFormFromOptions(options: TraceSourceOptions = {}): TraceSourceForm {
  return formFrom((tool) => !options.tools || options.tools.includes(tool), options.traceDirs);
}

/**
 * Directories a probe found that differ from the tool's default under `home`, i.e. the ones set in the
 * server's shell. The probe reports every tool, falling back to the default.
 */
export function customProbeDirs(detected: TraceDirs, home: string): TraceDirs {
  return Object.fromEntries(TRACE_TOOLS.flatMap((tool) => {
    const dir = detected[tool]?.trim();
    return dir && dir.replace(/\/+$/, '') !== defaultTraceDir(tool, home) ? [[tool, dir]] : [];
  }));
}

/** Prefill from a probe: directories set in the server's shell, and the tools whose data exists (all when none does yet). */
export function traceFormFromProbe(detected: TraceDirs, present: readonly TraceTool[], home: string): TraceSourceForm {
  return formFrom((tool) => !present.length || present.includes(tool), customProbeDirs(detected, home));
}

export function sameTraceForm(a: TraceSourceForm, b: TraceSourceForm): boolean {
  return TRACE_TOOLS.every((tool) => a.tools[tool] === b.tools[tool] && a.dirs[tool].trim() === b.dirs[tool].trim());
}

/** Absolute POSIX or Windows path. */
export function isAbsoluteDir(path: string): boolean {
  return /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(path);
}

export type TraceFormError = 'noTools' | 'notAbsolute';
export type TraceFormResult = { ok: true; options: TraceSourceOptions } | { ok: false; errors: Partial<Record<TraceTool | 'tools', TraceFormError>> };

/**
 * Validates the form and turns it into options: `tools` is left out when every tool is on (meaning "all,
 * including tools added later") and `traceDirs` only holds the directories that were filled in.
 */
export function traceOptionsFromForm(form: TraceSourceForm): TraceFormResult {
  const errors: Partial<Record<TraceTool | 'tools', TraceFormError>> = {};
  const tools = TRACE_TOOLS.filter((tool) => form.tools[tool]);
  if (!tools.length) errors.tools = 'noTools';
  const traceDirs: TraceDirs = {};
  for (const tool of TRACE_TOOLS) {
    const dir = form.dirs[tool].trim();
    if (!dir) continue;
    if (!isAbsoluteDir(dir)) errors[tool] = 'notAbsolute';
    traceDirs[tool] = dir;
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, options: { ...(tools.length === TRACE_TOOLS.length ? {} : { tools }), traceDirs } };
}

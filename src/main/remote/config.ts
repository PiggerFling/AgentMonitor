import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { AGENT_DEFAULT_PORT } from '../../shared/remoteProtocol';
import type { MonitorSnapshot } from '../../shared/types';

/**
 * One servers.json entry. `managed` is set for servers the app installed the agent on (`"managed": true` with
 * `home` and `nodePath` in the file); the agent then starts per connection and `remotePort` is unused.
 */
export interface ServerConfig { id: string; label: string; ssh: string; remotePort: number; sshArgs: string[]; managed?: { home: string; nodePath: string } }
export interface ServersConfig { servers: ServerConfig[]; errors: string[] }

/** Allowed servers.json ids. */
export const SERVER_ID = /^[A-Za-z0-9._-]{1,64}$/;
const ID = SERVER_ID;
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Why `ssh` cannot be used as a destination, or undefined when it can. Passed after `--`, but option-like and whitespace values are rejected to keep it unambiguous. */
export function sshDestinationProblem(ssh: unknown): string | undefined {
  if (typeof ssh !== 'string' || !ssh || ssh.length > 255) return '"ssh" must be a non-empty host or ~/.ssh/config alias';
  if (ssh.startsWith('-') || /\s/.test(ssh) || CONTROL.test(ssh)) return '"ssh" must not start with "-" or contain whitespace or control characters';
  return undefined;
}

/**
 * Whether a remote path can be interpolated into the managed remote command: absolute, without single quotes,
 * backslashes (fish treats them as escapes inside single quotes) or control characters.
 */
export const validRemotePath = (value: unknown): value is string => typeof value === 'string' && value.startsWith('/') && value.length > 1 && !value.includes("'") && !value.includes('\\') && !CONTROL.test(value);

export function serversConfigPath(userDataDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENT_MONITOR_SERVERS_FILE ? path.resolve(env.AGENT_MONITOR_SERVERS_FILE) : path.join(userDataDir, 'servers.json');
}

/** Reads servers.json. A missing file means no remotes; invalid entries are skipped and reported in `errors`. */
export function loadServersConfig(userDataDir: string, env: NodeJS.ProcessEnv = process.env): ServersConfig {
  return loadServersFile(serversConfigPath(userDataDir, env));
}

/** Reads a servers.json at an explicit path, like loadServersConfig. */
export function loadServersFile(file: string): ServersConfig {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { servers: [], errors: [] };
    return { servers: [], errors: [`Cannot read ${file}: ${(error as Error).message}`] };
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (error) { return { servers: [], errors: [`Invalid JSON in ${file}: ${(error as Error).message}`] }; }
  return parseServersConfig(raw, file);
}

export function parseServersConfig(raw: unknown, source = 'servers.json'): ServersConfig {
  const list = (raw as { servers?: unknown } | null)?.servers;
  if (!raw || typeof raw !== 'object' || !Array.isArray(list)) return { servers: [], errors: [`${source}: expected {"servers": [...]}`] };
  const servers: ServerConfig[] = [];
  const errors: string[] = [];
  const ids = new Set<string>();
  list.forEach((entry, index) => {
    const name = `${source}: server #${index + 1}`;
    const problem = validate(entry, ids);
    const id = (entry as { id?: unknown } | null)?.id;
    if (problem) { errors.push(`${name}${typeof id === 'string' && ID.test(id) ? ` (${id})` : ''} skipped: ${problem}`); return; }
    const value = entry as Record<string, unknown>;
    ids.add(value.id as string);
    servers.push({
      id: value.id as string,
      label: typeof value.label === 'string' && value.label.trim() ? value.label.trim() : value.id as string,
      ssh: value.ssh as string,
      remotePort: value.remotePort === undefined ? AGENT_DEFAULT_PORT : value.remotePort as number,
      sshArgs: [...(value.sshArgs as string[] | undefined ?? [])],
      ...(value.managed === true ? { managed: { home: value.home as string, nodePath: value.nodePath as string } } : {}),
    });
  });
  return { servers, errors };
}

function validate(entry: unknown, ids: Set<string>): string | undefined {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'expected an object';
  const { id, label, ssh, remotePort, sshArgs, managed, home, nodePath } = entry as Record<string, unknown>;
  if (typeof id !== 'string' || !ID.test(id)) return '"id" must be 1-64 characters of A-Z a-z 0-9 . _ -';
  if (ids.has(id)) return `duplicate id "${id}"`;
  if (label !== undefined && (typeof label !== 'string' || CONTROL.test(label))) return '"label" must be a string';
  const sshProblem = sshDestinationProblem(ssh);
  if (sshProblem) return sshProblem;
  if (remotePort !== undefined && (!Number.isInteger(remotePort) || (remotePort as number) < 1 || (remotePort as number) > 65535)) return '"remotePort" must be an integer from 1 to 65535';
  if (sshArgs !== undefined && (!Array.isArray(sshArgs) || sshArgs.some(arg => typeof arg !== 'string' || arg.includes('\0')))) return '"sshArgs" must be an array of strings';
  if (managed !== undefined && typeof managed !== 'boolean') return '"managed" must be true or false';
  for (const [key, value] of [['home', home], ['nodePath', nodePath]] as const) {
    if (value === undefined) { if (managed) return `"${key}" is required when "managed" is true`; continue; }
    // Interpolated into the remote shell command, single-quoted.
    if (!validRemotePath(value)) return `"${key}" must be an absolute POSIX path without quotes, backslashes or control characters`;
  }
  return undefined;
}

/** A source with no runs that only reports servers.json problems, so they show up beside other monitor errors. */
export class ConfigErrorSource extends EventEmitter {
  constructor(private readonly errors: string[]) { super(); }
  async start() {}
  async stop() {}
  snapshot(): MonitorSnapshot { return { runs: [], agents: [], edges: [], errors: [...this.errors], watching: false }; }
  async loadRun(runId: string): Promise<void> { throw new Error(`Unknown trace run: ${runId}`); }
  unloadRun() {}
  async getTrace() { return []; }
}

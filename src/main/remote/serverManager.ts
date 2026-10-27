import { TRACE_TOOLS, type AddServerResult, type ProbeServerResult, type RemoveServerResult, type ServerInfo, type ServerSetupProgress, type SshHostInfo, type TraceDirs, type TraceSourceOptions, type UpdateServerResult } from '../../shared/types';
import type { RemoteEndpoint } from '../../shared/remoteProtocol';
import type { MultiSourceMonitor } from '../trace-monitor/MultiSourceMonitor';
import { RemoteMonitor } from '../trace-monitor/RemoteMonitor';
import type { AgentBundle } from './agentBundle';
import { loadServersFile, parseServerTraceOptions, parseServersConfig, SERVER_ID, sshDestinationProblem, type ServerConfig } from './config';
import { defaultRemoteTraceDir, installAgent, probeServer, removeAgent, ServerSetupError, setupServer, type SshCommandOptions } from './installer';
import type { ServerChanges, ServersStore } from './serversStore';
import type { SshHost } from './sshConfig';
import { SshTunnel } from './sshTunnel';

export interface ServerManagerOptions {
  monitor: MultiSourceMonitor;
  store: ServersStore;
  /** The bundled agent; may throw when it cannot be read. Called lazily and cached on success. */
  bundle: () => AgentBundle;
  sshHosts: () => SshHost[];
  onProgress?: (progress: ServerSetupProgress) => void;
  /**
   * Overrides for tests: the ssh executable used by setup/cleanup, the endpoint factory, the probe's node locations
   * and its time limit for the login shell.
   */
  ssh?: Pick<SshCommandOptions, 'command' | 'commandArgs'>;
  endpoint?: (server: ServerConfig, agentSha256?: string) => RemoteEndpoint;
  nodeCandidates?: string[];
  shellSeconds?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function checkKeys(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Invalid request');
  const keys = Object.keys(value);
  if (keys.some(key => !required.includes(key) && !optional.includes(key)) || required.some(key => !(key in value))) throw new Error('Invalid request');
}
const CONTROL = /[\u0000-\u001f\u007f]/;
/**
 * The optional label, sshArgs, tools and traceDirs of an IPC request, validated and normalized (label trimmed, see
 * parseTraceSourceOptions). Throws on wrong types; returns a problem for values the user can correct.
 */
function requestFields(request: Record<string, unknown>): { problem: string } | { label?: string; sshArgs?: string[]; options: TraceSourceOptions } {
  const { label, sshArgs } = request;
  if (label !== undefined && (typeof label !== 'string' || label.length > 200)) throw new Error('Invalid request');
  if (sshArgs !== undefined && (!Array.isArray(sshArgs) || sshArgs.length > 64 || sshArgs.some(arg => typeof arg !== 'string' || arg.length > 1024))) throw new Error('Invalid request');
  if (typeof label === 'string' && CONTROL.test(label)) return { problem: 'The label must not contain control characters' };
  if ((sshArgs as string[] | undefined)?.some(arg => arg.includes('\0'))) return { problem: 'ssh options must not contain NUL characters' };
  const parsed = parseServerTraceOptions(request);
  if ('problem' in parsed) return parsed;
  return { ...(typeof label === 'string' && label.trim() ? { label: label.trim() } : {}), ...(sshArgs ? { sshArgs: sshArgs as string[] } : {}), options: parsed.options };
}
const failure = (error: unknown): Extract<AddServerResult, { ok: false }> => error instanceof ServerSetupError
  ? { ok: false, code: error.code, message: error.message, ...Object.fromEntries(Object.entries(error.extra).filter(([, value]) => value !== undefined)) }
  : { ok: false, code: 'failed', message: error instanceof Error ? error.message : String(error) };

/**
 * Remote servers at runtime: one RemoteMonitor per servers.json entry inside the MultiSourceMonitor, plus probing,
 * adding (probe, install, save, connect), editing and removing servers from the app. Managed servers reinstall their
 * agent when the tunnel reports it missing or outdated.
 */
export class ServerManager {
  private readonly remotes = new Map<string, RemoteMonitor>();
  private readonly adding = new Set<string>();
  private updates: Promise<unknown> = Promise.resolve();
  private cachedBundle?: AgentBundle;

  constructor(private readonly options: ServerManagerOptions) {}

  private bundle(): AgentBundle { return this.cachedBundle ??= this.options.bundle(); }

  /** Registers the servers read at startup. Managed ones are skipped with an error when the bundled agent is unreadable. */
  async load(servers: ServerConfig[], errors: string[]): Promise<void> {
    if (servers.some(server => server.managed)) {
      try { this.bundle(); } catch (error) {
        errors.push(`Cannot read the bundled agent, managed servers are disabled: ${(error as Error).message}`);
        servers = servers.filter(server => !server.managed);
      }
    }
    for (const server of servers) await this.register(server);
  }

  /** The RemoteMonitor of a server id (tests and diagnostics). */
  remote(id: string): RemoteMonitor | undefined { return this.remotes.get(id); }

  /** A RemoteMonitor for `server`; a managed agent gets the entry's tools and data directories as flags. */
  private remoteFor(server: ServerConfig): RemoteMonitor {
    const sha = server.managed ? this.bundle().sha256 : undefined;
    const traceOptions = { ...(server.tools ? { tools: server.tools } : {}), ...(server.traceDirs ? { traceDirs: server.traceDirs } : {}) };
    const endpoint = this.options.endpoint?.(server, sha) ?? new SshTunnel({ ssh: server.ssh, remotePort: server.remotePort, sshArgs: server.sshArgs,
      ...(server.managed && sha ? { managed: { ...server.managed, agentSha256: sha, traceOptions } } : {}) });
    const managed = server.managed;
    return new RemoteMonitor({ id: server.id, label: server.label, endpoint,
      ...(managed ? { reinstall: (signal: AbortSignal) => installAgent({ ...this.options.ssh, ssh: server.ssh, sshArgs: server.sshArgs, home: managed.home, bundle: this.bundle(), signal }) } : {}) });
  }

  private async register(server: ServerConfig) {
    const remote = this.remoteFor(server);
    this.remotes.set(server.id, remote);
    await this.options.monitor.addSource(remote);
  }

  /** Concrete ~/.ssh/config hosts, marked with the servers.json entry that already uses each alias. */
  listSshHosts(): SshHostInfo[] {
    const servers = loadServersFile(this.options.store.file).servers;
    return this.options.sshHosts().map(host => {
      const server = servers.find(candidate => candidate.ssh === host.alias);
      return { ...host, ...(server ? { serverId: server.id, managed: !!server.managed } : {}) };
    });
  }

  /** Configured servers in servers.json order; entries that fail validation are left out. */
  listServers(): ServerInfo[] {
    return loadServersFile(this.options.store.file).servers.map(server => ({ id: server.id, label: server.label, ssh: server.ssh, managed: !!server.managed, sshArgs: [...server.sshArgs],
      ...(server.tools ? { tools: [...server.tools] } : {}), ...(server.traceDirs ? { traceDirs: { ...server.traceDirs } } : {}) }));
  }

  private checkAlias(alias: unknown, acceptNewHostKey: unknown): asserts alias is string {
    if (typeof alias !== 'string' || (acceptNewHostKey !== undefined && typeof acceptNewHostKey !== 'boolean')) throw new Error('Invalid request');
    if (!this.options.sshHosts().some(host => host.alias === alias) && sshDestinationProblem(alias)) throw new Error('Invalid ssh host');
  }

  /** Validates an IPC request (throws on malformed input), then inspects the host without installing anything. */
  async probeServer(request: unknown): Promise<ProbeServerResult> {
    checkKeys(request, ['alias'], ['sshArgs', 'acceptNewHostKey']);
    const { alias, acceptNewHostKey } = request;
    this.checkAlias(alias, acceptNewHostKey);
    const fields = requestFields({ sshArgs: request.sshArgs });
    if ('problem' in fields) return { ok: false, code: 'failed', message: fields.problem };
    try {
      return { ok: true, ...await probeServer({ ...this.options.ssh, ssh: alias, sshArgs: fields.sshArgs, acceptNewHostKey: acceptNewHostKey === true,
        nodeCandidates: this.options.nodeCandidates, shellSeconds: this.options.shellSeconds }) };
    } catch (error) { return failure(error); }
  }

  /**
   * Validates an IPC request (throws on malformed input), then probes, installs, saves and connects the server.
   * Without `traceDirs`, the detected directories that differ from the defaults are saved (e.g. CODEX_HOME from ~/.zshrc).
   */
  async addServer(request: unknown): Promise<AddServerResult> {
    checkKeys(request, ['alias'], ['label', 'sshArgs', 'tools', 'traceDirs', 'acceptNewHostKey']);
    const { alias, acceptNewHostKey } = request;
    this.checkAlias(alias, acceptNewHostKey);
    const fields = requestFields(request);
    if ('problem' in fields) return { ok: false, code: 'failed', message: fields.problem };
    if (this.adding.has(alias)) return { ok: false, code: 'busy', message: `${alias} is already being added` };
    const existing = loadServersFile(this.options.store.file).servers.find(server => server.ssh === alias);
    if (existing) return { ok: false, code: 'already-added', message: `${alias} is already configured as server "${existing.id}"` };
    this.adding.add(alias);
    const progress = (step: ServerSetupProgress['step'], state: ServerSetupProgress['state']) => this.options.onProgress?.({ alias, step, state });
    try {
      let bundle: AgentBundle;
      try { bundle = this.bundle(); } catch (error) { return { ok: false, code: 'failed', message: `Cannot read the bundled agent: ${(error as Error).message}` }; }
      const { label, sshArgs, options } = fields;
      const probe = await setupServer({ ...this.options.ssh, ssh: alias, sshArgs, acceptNewHostKey: acceptNewHostKey === true, bundle,
        nodeCandidates: this.options.nodeCandidates, shellSeconds: this.options.shellSeconds, onProgress: progress });
      const traceDirs: TraceDirs = request.traceDirs !== undefined ? options.traceDirs ?? {}
        : Object.fromEntries(TRACE_TOOLS.filter(tool => probe.detected[tool] !== defaultRemoteTraceDir(probe.home, tool)).map(tool => [tool, probe.detected[tool]]));
      progress('save', 'running');
      let server: ServerConfig;
      try { server = await this.options.store.addManaged({ alias, label, sshArgs, home: probe.home, nodePath: probe.nodePath, tools: options.tools, traceDirs }); } catch (error) {
        progress('save', 'failed');
        return { ok: false, code: 'save-failed', message: `Cannot save the server: ${(error as Error).message}` };
      }
      progress('save', 'done');
      await this.register(server);
      return { ok: true, serverId: server.id };
    } catch (error) {
      return failure(error);
    } finally { this.adding.delete(alias); }
  }

  /**
   * Validates an IPC request (throws on malformed input), then edits the entry and reconnects the server with it.
   * Fields present in the request replace the entry's (undefined, an empty label or sshArgs, all tools or empty
   * traceDirs restore the defaults); absent fields are kept. Updates are serialized.
   */
  async updateServer(request: unknown): Promise<UpdateServerResult> {
    checkKeys(request, ['id'], ['label', 'sshArgs', 'tools', 'traceDirs']);
    const { id } = request;
    if (typeof id !== 'string' || !SERVER_ID.test(id)) throw new Error('Invalid request');
    const fields = requestFields(request);
    if ('problem' in fields) return { ok: false, code: 'invalid', message: fields.problem };
    const changes: ServerChanges = {};
    if ('label' in request) changes.label = fields.label;
    if ('sshArgs' in request) changes.sshArgs = fields.sshArgs;
    if ('tools' in request) changes.tools = fields.options.tools;
    if ('traceDirs' in request) changes.traceDirs = fields.options.traceDirs;
    const run = async (): Promise<UpdateServerResult> => {
      let server: ServerConfig | undefined;
      try { server = await this.options.store.update(id, changes); } catch (error) { return { ok: false, code: 'failed', message: `Cannot save the server: ${(error as Error).message}` }; }
      if (!server) return { ok: false, code: 'not-found', message: `No server "${id}"` };
      let next: RemoteMonitor;
      try { next = this.remoteFor(server); } catch (error) { return { ok: false, code: 'failed', message: `Saved, but cannot reconnect: ${(error as Error).message}` }; }
      // Takes the old monitor's place, so the server keeps its position and its runs are replaced in one snapshot.
      const old = this.remotes.get(id);
      this.remotes.set(id, next);
      await this.options.monitor.replaceSources(old ? [old] : [], [next]);
      return { ok: true };
    };
    const result = this.updates.then(run, run);
    this.updates = result.catch(() => undefined);
    return result;
  }

  /** Validates an IPC request (throws on malformed input), stops the server, drops its entry and optionally deletes ~/.agent-monitor on it. */
  async removeServer(request: unknown): Promise<RemoveServerResult> {
    checkKeys(request, ['id', 'cleanup']);
    const { id, cleanup } = request;
    if (typeof id !== 'string' || !SERVER_ID.test(id) || typeof cleanup !== 'boolean') throw new Error('Invalid request');
    let entry: Record<string, unknown> | undefined;
    try { entry = await this.options.store.remove(id); } catch (error) { return { ok: false, code: 'failed', message: (error as Error).message }; }
    const remote = this.remotes.get(id);
    if (!entry && !remote) return { ok: false, code: 'not-found', message: `No server "${id}"` };
    this.remotes.delete(id);
    // Stopping first closes the tunnel, so the agent has exited before its directory is deleted.
    if (remote) await this.options.monitor.removeSource(remote);
    const server = entry && parseServersConfig({ servers: [entry] }).servers[0];
    if (!cleanup || !server?.managed) return { ok: true };
    try {
      await removeAgent({ ...this.options.ssh, ssh: server.ssh, sshArgs: server.sshArgs, home: server.managed.home });
      return { ok: true };
    } catch (error) {
      return { ok: true, cleanupError: error instanceof Error ? error.message : String(error) };
    }
  }
}

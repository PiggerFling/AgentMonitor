import type { AddServerResult, RemoveServerResult, ServerSetupProgress, SshHostInfo } from '../../shared/types';
import type { RemoteEndpoint } from '../../shared/remoteProtocol';
import type { MultiSourceMonitor } from '../trace-monitor/MultiSourceMonitor';
import { RemoteMonitor } from '../trace-monitor/RemoteMonitor';
import type { AgentBundle } from './agentBundle';
import { loadServersFile, parseServersConfig, SERVER_ID, sshDestinationProblem, type ServerConfig } from './config';
import { installAgent, removeAgent, ServerSetupError, setupServer, type SshCommandOptions } from './installer';
import type { ServersStore } from './serversStore';
import type { SshHost } from './sshConfig';
import { SshTunnel } from './sshTunnel';

export interface ServerManagerOptions {
  monitor: MultiSourceMonitor;
  store: ServersStore;
  /** The bundled agent; may throw when it cannot be read. Called lazily and cached on success. */
  bundle: () => AgentBundle;
  sshHosts: () => SshHost[];
  onProgress?: (progress: ServerSetupProgress) => void;
  /** Overrides for tests: the ssh executable used by setup/cleanup, the endpoint factory and the probe's node locations. */
  ssh?: Pick<SshCommandOptions, 'command' | 'commandArgs'>;
  endpoint?: (server: ServerConfig, agentSha256?: string) => RemoteEndpoint;
  nodeCandidates?: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function checkKeys(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Invalid request');
  const keys = Object.keys(value);
  if (keys.some(key => !required.includes(key) && !optional.includes(key)) || required.some(key => !(key in value))) throw new Error('Invalid request');
}
const failure = (error: unknown): AddServerResult => error instanceof ServerSetupError
  ? { ok: false, code: error.code, message: error.message, ...Object.fromEntries(Object.entries(error.extra).filter(([, value]) => value !== undefined)) }
  : { ok: false, code: 'failed', message: error instanceof Error ? error.message : String(error) };

/**
 * Remote servers at runtime: one RemoteMonitor per servers.json entry inside the MultiSourceMonitor, plus adding
 * (probe, install, save, connect) and removing servers from the app. Managed servers reinstall their agent when the
 * tunnel reports it missing or outdated.
 */
export class ServerManager {
  private readonly remotes = new Map<string, RemoteMonitor>();
  private readonly adding = new Set<string>();
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

  private async register(server: ServerConfig) {
    const sha = server.managed ? this.bundle().sha256 : undefined;
    const endpoint = this.options.endpoint?.(server, sha) ?? new SshTunnel({ ssh: server.ssh, remotePort: server.remotePort, sshArgs: server.sshArgs,
      ...(server.managed && sha ? { managed: { ...server.managed, agentSha256: sha } } : {}) });
    const managed = server.managed;
    const remote = new RemoteMonitor({ id: server.id, label: server.label, endpoint,
      ...(managed ? { reinstall: (signal: AbortSignal) => installAgent({ ...this.options.ssh, ssh: server.ssh, sshArgs: server.sshArgs, home: managed.home, bundle: this.bundle(), signal }) } : {}) });
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

  /** Validates an IPC request (throws on malformed input), then probes, installs, saves and connects the server. */
  async addServer(request: unknown): Promise<AddServerResult> {
    checkKeys(request, ['alias'], ['acceptNewHostKey']);
    const { alias, acceptNewHostKey } = request;
    if (typeof alias !== 'string' || (acceptNewHostKey !== undefined && typeof acceptNewHostKey !== 'boolean')) throw new Error('Invalid request');
    if (!this.options.sshHosts().some(host => host.alias === alias) && sshDestinationProblem(alias)) throw new Error('Invalid ssh host');
    if (this.adding.has(alias)) return { ok: false, code: 'busy', message: `${alias} is already being added` };
    const existing = loadServersFile(this.options.store.file).servers.find(server => server.ssh === alias);
    if (existing) return { ok: false, code: 'already-added', message: `${alias} is already configured as server "${existing.id}"` };
    this.adding.add(alias);
    const progress = (step: ServerSetupProgress['step'], state: ServerSetupProgress['state']) => this.options.onProgress?.({ alias, step, state });
    try {
      let bundle: AgentBundle;
      try { bundle = this.bundle(); } catch (error) { return { ok: false, code: 'failed', message: `Cannot read the bundled agent: ${(error as Error).message}` }; }
      const probe = await setupServer({ ...this.options.ssh, ssh: alias, acceptNewHostKey: acceptNewHostKey === true, bundle, nodeCandidates: this.options.nodeCandidates, onProgress: progress });
      progress('save', 'running');
      let server: ServerConfig;
      try { server = await this.options.store.addManaged({ alias, home: probe.home, nodePath: probe.nodePath }); } catch (error) {
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

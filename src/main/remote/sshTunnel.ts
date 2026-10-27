import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { AGENT_DEFAULT_PORT, type RemoteEndpoint } from '../../shared/remoteProtocol';
import { StreamMux } from '../../shared/streamMux';

/** A server whose agent the app installed under `<home>/.agent-monitor`; the tunnel starts it per connection. */
export interface ManagedAgent {
  /** Absolute remote home directory and node executable; validated by config.ts. */
  home: string;
  nodePath: string;
  /** Hex sha256 of the bundled agent.cjs; a remote agent.sha256 that differs means the agent must be reinstalled. */
  agentSha256: string;
}

export interface SshTunnelOptions {
  /** Host or ~/.ssh/config alias; validated by config.ts. */
  ssh: string;
  /** Legacy mode: port of a resident agent on the server's loopback. Ignored when `managed` is set. */
  remotePort?: number;
  managed?: ManagedAgent;
  /** Extra options placed before `--`, e.g. ["-J", "bastion"]. */
  sshArgs?: string[];
  /** Executable to run instead of `ssh`, with arguments placed before the ssh options (tests). */
  command?: string;
  commandArgs?: string[];
  timeoutMs?: number;
  killGraceMs?: number;
}

/** The remote command exits with this code when agent.cjs is missing or does not match the expected sha256. */
export const AGENT_OUTDATED_EXIT_CODE = 42;
/** Printed by the agent on its own stdout line once it listens. */
export const AGENT_READY_LINE = 'agent-monitor ready';

/** The managed agent on the server is missing or differs from the bundled one; reinstall it and retry. */
export class AgentOutdatedError extends Error {
  constructor(readonly ssh: string) { super(`The agent on ${ssh} is missing or outdated`); this.name = 'AgentOutdatedError'; }
}

/** Quotes one word for a POSIX shell: wrapped in single quotes, embedded single quotes as '\''. */
export function shellQuote(value: string): string { return `'${value.replaceAll("'", `'\\''`)}'`; }

/**
 * Wraps a POSIX script as `sh -c '<script>'` for the remote login shell. The single-quoted word with `'\''` joins
 * means the same in bash, zsh, fish and csh/tcsh, as long as the script has no backslashes or newlines.
 */
export function remoteSh(script: string): string { return `sh -c ${shellQuote(script)}`; }

/** The command line run by the remote login shell for a managed agent serving on its stdin/stdout. */
export function managedRemoteCommand(managed: ManagedAgent): string {
  return remoteSh(`cd ${shellQuote(`${managed.home}/.agent-monitor`)} && [ "$(cat agent.sha256 2>/dev/null)" = ${shellQuote(managed.agentSha256)} ] || exit ${AGENT_OUTDATED_EXIT_CODE}; `
    + `exec ${shellQuote(managed.nodePath)} agent.cjs --stdio`);
}

/**
 * ssh options for a managed connection. It needs no port forwarding, so forwardings from ~/.ssh/config (e.g. a
 * RemoteForward another tool added for interactive logins) are cleared rather than competing for their ports, and
 * the escape character is off because stdin carries binary frames.
 */
export const MANAGED_SSH_OPTIONS = ['-T', '-e', 'none', '-o', 'BatchMode=yes', '-o', 'ClearAllForwardings=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];

const live = new Set<ChildProcess>();
let exitHookInstalled = false;
function track(child: ChildProcess) {
  live.add(child);
  child.once('exit', () => live.delete(child));
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // Last resort against orphaned ssh processes when the app exits without stopping its monitors.
  process.once('exit', () => { for (const proc of live) proc.kill('SIGKILL'); });
}

const running = (child: ChildProcess) => child.pid !== undefined && child.exitCode === null && child.signalCode === null;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function listenLocal(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve((server.address() as net.AddressInfo).port); });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function accepts(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
  });
}

/**
 * A local loopback URL for an agent on the server. Authentication relies on keys or ssh-agent (BatchMode).
 * Legacy mode is an `ssh -N -L` forward to a resident agent's loopback port. Managed mode runs the installed agent as
 * the ssh command with `--stdio` and serves a local port itself, carrying each local connection as a StreamMux channel
 * over the ssh session's stdin/stdout; the agent exits when that session ends.
 */
export class SshTunnel implements RemoteEndpoint {
  private child?: ChildProcess;
  private local?: net.Server;
  private url?: string;
  private opening?: Promise<string>;
  private generation = 0;

  constructor(private readonly options: SshTunnelOptions) {}

  /** The ssh process id while one is running (tests and diagnostics). */
  get pid(): number | undefined { return this.child && running(this.child) ? this.child.pid : undefined; }

  open(): Promise<string> {
    if (this.opening) return this.opening;
    if (this.url && this.child && running(this.child)) return Promise.resolve(this.url);
    this.opening = this.start().finally(() => { this.opening = undefined; });
    return this.opening;
  }

  async close(): Promise<void> {
    this.generation += 1;
    this.url = undefined;
    this.local?.close();
    this.local = undefined;
    const child = this.child;
    this.child = undefined;
    if (!child || !running(child)) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    const grace = this.options.killGraceMs ?? 3000;
    // Managed: EOF on stdin reaches the remote agent, which exits; ssh then exits by itself.
    if (child.stdin) {
      child.stdin.end();
      await Promise.race([exited, delay(Math.min(grace, 1000))]);
      if (!running(child)) return;
    }
    child.kill('SIGTERM');
    const timer = setTimeout(() => { if (running(child)) child.kill('SIGKILL'); }, grace);
    await exited;
    clearTimeout(timer);
  }

  private async start(): Promise<string> {
    const generation = this.generation;
    const { ssh, remotePort = AGENT_DEFAULT_PORT, managed, sshArgs = [], command = 'ssh', commandArgs = [], timeoutMs = 20_000 } = this.options;
    const localPort = managed ? 0 : await freePort();
    if (generation !== this.generation) throw new Error('SSH tunnel closed');
    const args = managed
      ? [...MANAGED_SSH_OPTIONS, ...sshArgs, '--', ssh, managedRemoteCommand(managed)]
      : ['-N', '-T', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
        '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`, ...sshArgs, '--', ssh];
    const child = spawn(command, [...commandArgs, ...args], { stdio: [managed ? 'pipe' : 'ignore', managed ? 'pipe' : 'ignore', 'pipe'], windowsHide: true });
    this.child = child;
    track(child);
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4096); });
    // ssh may be gone by the time close() ends stdin.
    child.stdin?.on('error', () => {});
    const tail = () => stderr.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(-3).join(' | ');
    child.once('exit', () => { if (this.child === child) { this.child = undefined; this.url = undefined; this.local = undefined; } });

    let settled = false;
    const failed = new Promise<never>((_, reject) => {
      child.once('error', error => reject(new Error(`Cannot run ${command}: ${error.message}`)));
      child.once('close', (code, signal) => {
        if (managed && code === AGENT_OUTDATED_EXIT_CODE) { reject(new AgentOutdatedError(ssh)); return; }
        const detail = tail();
        reject(new Error(`ssh ${ssh} exited${code === null ? ` on ${signal}` : ` with code ${code}`}${detail ? `: ${detail}` : ''}`));
      });
    });
    failed.catch(() => {});
    const timeout = () => new Error(`ssh ${ssh} did not open the tunnel within ${Math.round(timeoutMs / 1000)}s${tail() ? `: ${tail()}` : ''}`);
    const ready = managed ? this.serveManaged(child, timeoutMs, timeout) : (async () => {
      const deadline = Date.now() + timeoutMs;
      while (!settled) {
        if (await accepts(localPort)) return localPort;
        if (Date.now() > deadline) throw timeout();
        await delay(100);
      }
      return localPort;
    })();
    ready.catch(() => {});
    let port: number;
    try {
      port = await Promise.race([ready, failed]);
      if (generation !== this.generation || !running(child)) throw new Error('SSH tunnel closed');
    } catch (error) {
      if (this.child === child) await this.close();
      else if (running(child)) child.kill('SIGKILL');
      throw error;
    } finally { settled = true; }
    this.url = `http://127.0.0.1:${port}`;
    return this.url;
  }

  /**
   * Waits for the agent's ready line (login shells may print banners before it), then serves a local loopback port
   * whose connections become channels over the session. Resolves with that port.
   */
  private serveManaged(child: ChildProcess, timeoutMs: number, timeout: () => Error): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      let buffer: Buffer = Buffer.alloc(0);
      const timer = setTimeout(() => reject(timeout()), timeoutMs);
      child.once('close', () => clearTimeout(timer));
      const stdout = child.stdout!;
      const onData = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        let start = 0;
        for (let end = buffer.indexOf(10); end >= 0; start = end + 1, end = buffer.indexOf(10, start)) {
          if (buffer.subarray(start, end).toString('utf8').trim() !== AGENT_READY_LINE) continue;
          stdout.off('data', onData);
          clearTimeout(timer);
          const mux = new StreamMux(child.stdin!);
          mux.receive(buffer.subarray(end + 1));
          stdout.on('data', (data: Buffer) => mux.receive(data));
          stdout.once('end', () => mux.end());
          const local = net.createServer(socket => {
            let channel: Duplex;
            try { channel = mux.open(); } catch { socket.destroy(); return; }
            socket.on('error', () => channel.destroy());
            channel.on('error', () => socket.destroy());
            socket.pipe(channel).pipe(socket);
            socket.once('close', () => channel.destroy());
            channel.once('close', () => socket.destroy());
          });
          this.local = local;
          // A broken session (bad frames or stdout gone) ends the connection; RemoteMonitor reopens it.
          mux.once('close', () => { local.close(); if (running(child)) child.kill('SIGTERM'); });
          listenLocal(local).then(resolve, reject);
          return;
        }
        // Keep only an unfinished line, bounded so a chatty login shell cannot grow it.
        buffer = buffer.subarray(start).subarray(-4096);
      };
      stdout.on('data', onData);
    });
  }
}

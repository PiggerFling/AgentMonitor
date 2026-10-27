import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { AGENT_DEFAULT_PORT, type RemoteEndpoint } from '../../shared/remoteProtocol';

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

/** The command line run by the remote login shell for a managed agent listening on `socket`. */
export function managedRemoteCommand(managed: ManagedAgent, socket: string): string {
  return remoteSh(`cd ${shellQuote(`${managed.home}/.agent-monitor`)} && [ "$(cat agent.sha256 2>/dev/null)" = ${shellQuote(managed.agentSha256)} ] || exit ${AGENT_OUTDATED_EXIT_CODE}; `
    + `exec ${shellQuote(managed.nodePath)} agent.cjs --socket ${shellQuote(socket)} --exit-on-stdin-close`);
}

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
 * An `ssh -L` local forward to an agent on the server. Authentication relies on keys or ssh-agent (BatchMode).
 * Legacy mode forwards to a resident agent's loopback port (`ssh -N`). Managed mode runs the installed agent as the
 * ssh command on a fresh Unix socket and forwards to that; stdin stays open so the agent exits when ssh goes away.
 */
export class SshTunnel implements RemoteEndpoint {
  private child?: ChildProcess;
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
    const child = this.child;
    this.child = undefined;
    if (!child || !running(child)) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    const grace = this.options.killGraceMs ?? 3000;
    // Managed: EOF on stdin reaches the remote agent, which removes its socket and exits; ssh then exits by itself.
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
    const localPort = await freePort();
    if (generation !== this.generation) throw new Error('SSH tunnel closed');
    const { ssh, remotePort = AGENT_DEFAULT_PORT, managed, sshArgs = [], command = 'ssh', commandArgs = [], timeoutMs = 20_000 } = this.options;
    const options = ['-T', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];
    let args: string[];
    if (managed) {
      const socket = `${managed.home}/.agent-monitor/agent-${randomBytes(8).toString('hex')}.sock`;
      args = [...options, '-L', `127.0.0.1:${localPort}:${socket}`, ...sshArgs, '--', ssh, managedRemoteCommand(managed, socket)];
    } else args = ['-N', ...options, '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`, ...sshArgs, '--', ssh];
    const child = spawn(command, [...commandArgs, ...args], { stdio: [managed ? 'pipe' : 'ignore', managed ? 'pipe' : 'ignore', 'pipe'], windowsHide: true });
    this.child = child;
    track(child);
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4096); });
    // ssh may be gone by the time close() ends stdin.
    child.stdin?.on('error', () => {});
    const tail = () => stderr.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(-3).join(' | ');
    child.once('exit', () => { if (this.child === child) { this.child = undefined; this.url = undefined; } });

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
    // Managed: the local port accepts before the remote socket exists, so wait for the agent's ready line instead.
    const ready = managed ? new Promise<void>((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(timeout()), timeoutMs);
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (chunk: string) => {
        if (settled) return;
        buffer = (buffer + chunk).slice(-4096);
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop()!;
        if (lines.some(line => line.trim() === AGENT_READY_LINE)) { clearTimeout(timer); resolve(); }
      });
      child.once('close', () => clearTimeout(timer));
    }) : (async () => {
      const deadline = Date.now() + timeoutMs;
      while (!settled) {
        if (await accepts(localPort)) return;
        if (Date.now() > deadline) throw timeout();
        await delay(100);
      }
    })();
    ready.catch(() => {});
    try {
      await Promise.race([ready, failed]);
      if (generation !== this.generation || !running(child)) throw new Error('SSH tunnel closed');
    } catch (error) {
      if (this.child === child) await this.close();
      else if (running(child)) child.kill('SIGKILL');
      throw error;
    } finally { settled = true; }
    this.url = `http://127.0.0.1:${localPort}`;
    return this.url;
  }
}

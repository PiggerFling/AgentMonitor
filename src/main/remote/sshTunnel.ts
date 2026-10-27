import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { AGENT_DEFAULT_PORT, type RemoteEndpoint } from '../../shared/remoteProtocol';

export interface SshTunnelOptions {
  /** Host or ~/.ssh/config alias; validated by config.ts. */
  ssh: string;
  remotePort?: number;
  /** Extra options placed before `--`, e.g. ["-J", "bastion"]. */
  sshArgs?: string[];
  /** Executable to run instead of `ssh`, with arguments placed before the ssh options (tests). */
  command?: string;
  commandArgs?: string[];
  timeoutMs?: number;
  killGraceMs?: number;
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

/** An `ssh -L` local forward to an agent bound to the server's loopback. Authentication relies on keys or ssh-agent (BatchMode). */
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
    child.kill('SIGTERM');
    const timer = setTimeout(() => { if (running(child)) child.kill('SIGKILL'); }, this.options.killGraceMs ?? 3000);
    await exited;
    clearTimeout(timer);
  }

  private async start(): Promise<string> {
    const generation = this.generation;
    const localPort = await freePort();
    if (generation !== this.generation) throw new Error('SSH tunnel closed');
    const { ssh, remotePort = AGENT_DEFAULT_PORT, sshArgs = [], command = 'ssh', commandArgs = [], timeoutMs = 20_000 } = this.options;
    const args = ['-N', '-T', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
      '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`, ...sshArgs, '--', ssh];
    const child = spawn(command, [...commandArgs, ...args], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    this.child = child;
    track(child);
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4096); });
    const tail = () => stderr.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(-3).join(' | ');
    child.once('exit', () => { if (this.child === child) { this.child = undefined; this.url = undefined; } });

    let settled = false;
    const failed = new Promise<never>((_, reject) => {
      child.once('error', error => reject(new Error(`Cannot run ${command}: ${error.message}`)));
      child.once('close', (code, signal) => {
        const detail = tail();
        reject(new Error(`ssh ${ssh} exited${code === null ? ` on ${signal}` : ` with code ${code}`}${detail ? `: ${detail}` : ''}`));
      });
    });
    failed.catch(() => {});
    const ready = (async () => {
      const deadline = Date.now() + timeoutMs;
      while (!settled) {
        if (await accepts(localPort)) return;
        if (Date.now() > deadline) throw new Error(`ssh ${ssh} did not open the tunnel within ${Math.round(timeoutMs / 1000)}s${tail() ? `: ${tail()}` : ''}`);
        await delay(100);
      }
    })();
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

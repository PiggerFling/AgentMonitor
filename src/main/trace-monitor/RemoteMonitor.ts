import { EventEmitter } from 'node:events';
import type { MonitorSnapshot, RemoteHostStatus, TraceEntry } from '../../shared/types';
import { AGENT_HEARTBEAT_MS, AGENT_PROTOCOL_VERSION, type AgentVersionInfo, type RemoteEndpoint } from '../../shared/remoteProtocol';
import type { MonitorSource } from './MultiSourceMonitor';
import { AgentOutdatedError } from '../remote/sshTunnel';

export interface RemoteMonitorOptions {
  id: string;
  label: string;
  endpoint: RemoteEndpoint;
  fetch?: typeof fetch;
  retry?: { minMs?: number; maxMs?: number };
  /** Abort the event stream when nothing (data or ping) arrives for this long. Default 2.5x AGENT_HEARTBEAT_MS. */
  staleMs?: number;
  /**
   * Reinstalls a managed server's agent after the endpoint reported it missing or outdated (AgentOutdatedError); the
   * connection is retried right after a successful reinstall. Tried at most once per backoff cycle. `signal` aborts on stop.
   */
  reinstall?: (signal: AbortSignal) => Promise<void>;
}

/** Per-request limit for trace and load-run calls, so a hung tunnel surfaces as an error instead of a spinner. */
const REQUEST_TIMEOUT_MS = 30_000;

const message = (error: unknown) => {
  const cause = (error as { cause?: unknown })?.cause;
  if (cause instanceof Error && cause.message) return cause.message;
  return error instanceof Error ? error.message : String(error);
};

/**
 * One remote agent reached through `endpoint`, exposed as a MonitorSource with every id namespaced
 * `remote:<id>::<originalId>`. The SSE stream is reconnected with exponential backoff; while disconnected
 * the last known runs/agents stay visible and the host status reports `error`.
 *
 * Selection is local: `unloadRun` only drops the local selection (the agent is not told), so agents stop
 * being exposed immediately; the agent keeps its last loaded run until the next `loadRun`.
 */
export class RemoteMonitor extends EventEmitter implements MonitorSource {
  readonly id: string;
  readonly label: string;
  private readonly endpoint: RemoteEndpoint;
  private readonly fetch: typeof fetch;
  private readonly minMs: number;
  private readonly maxMs: number;
  private readonly staleMs: number;
  private readonly prefix: string;
  private readonly reinstall?: (signal: AbortSignal) => Promise<void>;
  private running = false;
  private life?: AbortController;
  private loop?: Promise<void>;
  private base?: string;
  private remote: MonitorSnapshot = { agents:[],runs:[],edges:[],errors:[],watching:false };
  private status: RemoteHostStatus;
  private selectedRunId?: string;

  constructor(options: RemoteMonitorOptions) {
    super();
    this.id = options.id;
    this.label = options.label;
    this.endpoint = options.endpoint;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.minMs = options.retry?.minMs ?? 1_000;
    this.maxMs = options.retry?.maxMs ?? 30_000;
    this.staleMs = options.staleMs ?? AGENT_HEARTBEAT_MS * 2.5;
    this.prefix = `remote:${this.id}::`;
    this.reinstall = options.reinstall;
    this.status = { id:this.id,label:this.label,state:'connecting' };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.life = new AbortController();
    this.setStatus({ state:'connecting',error:undefined });
    this.loop = this.run(this.life.signal);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.life?.abort();
    await this.loop;
    this.loop = undefined;
    this.base = undefined;
    this.selectedRunId = undefined;
    await this.endpoint.close().catch(() => undefined);
  }

  snapshot(): MonitorSnapshot {
    const ns = (id: string) => this.prefix + id;
    const connected = this.status.state === 'connected';
    const agents = this.selectedRunId ? this.remote.agents.filter(agent => agent.runId === this.selectedRunId) : [];
    const ids = new Set(agents.map(agent => agent.id));
    return {
      runs: this.remote.runs.map(run => ({ ...run,id:ns(run.id),host:this.label,...(run.rootAgentId ? { rootAgentId:ns(run.rootAgentId) } : {}) })),
      agents: agents.map(agent => ({ ...agent,id:ns(agent.id),runId:ns(agent.runId),parentId:agent.parentId == null ? null : ns(agent.parentId),stats:{...agent.stats} })),
      edges: this.remote.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)).map(edge => ({ ...edge,id:ns(edge.id),source:ns(edge.source),target:ns(edge.target) })),
      errors: this.remote.errors.map(error => `[${this.label}] ${error}`),
      watching: connected && this.remote.watching,
      ...(this.selectedRunId ? { selectedRunId:ns(this.selectedRunId) } : {}),
      remotes: [{ ...this.status }],
    };
  }

  async loadRun(runId: string): Promise<void> {
    const id = this.strip(runId, 'run');
    this.selectedRunId = id;
    this.emitSnapshot();
    await this.request('/api/load-run', { method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ runId:id }) });
  }

  unloadRun(): void {
    if (!this.selectedRunId) return;
    this.selectedRunId = undefined;
    this.emitSnapshot();
  }

  async getTrace(agentId: string): Promise<TraceEntry[]> {
    const id = this.strip(agentId, 'agent');
    const response = await this.request(`/api/trace?agentId=${encodeURIComponent(id)}`);
    return await response.json() as TraceEntry[];
  }

  private strip(id: string, kind: string): string {
    if (!id.startsWith(this.prefix)) throw new Error(`${kind} ${id} does not belong to remote ${this.label}`);
    return id.slice(this.prefix.length);
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    if (!this.running || !this.base || this.status.state !== 'connected') throw new Error(`[${this.label}] not connected${this.status.error ? `: ${this.status.error}` : ''}`);
    const signal = AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(this.life ? [this.life.signal] : [])]);
    return this.call(this.base, path, { ...init,signal }).catch((error: unknown) => { throw new Error(`[${this.label}] ${message(error)}`); });
  }

  private async call(base: string, path: string, init: RequestInit): Promise<Response> {
    const response = await this.fetch(new URL(path, base), init);
    if (response.ok) return response;
    const body = await response.json().catch(() => undefined) as { error?: string } | undefined;
    throw new Error(`${path.split('?')[0]}: ${body?.error ?? `HTTP ${response.status}`}`);
  }

  private async run(life: AbortSignal): Promise<void> {
    let attempt = 0;
    let reinstalled = false;
    while (!life.aborted) {
      try {
        await this.connect(life, () => { attempt = 0; });
        throw new Error('event stream closed');
      } catch (error) {
        if (life.aborted) return;
        this.base = undefined;
        if (error instanceof AgentOutdatedError && this.reinstall && !reinstalled) {
          reinstalled = true;
          this.setStatus({ state:'connecting',error:undefined });
          const aborted = new Promise<'aborted'>(resolve => life.addEventListener('abort', () => resolve('aborted'), { once:true }));
          const failure = await Promise.race([this.reinstall(life).then(() => undefined, (cause: unknown) => cause ?? new Error('reinstall failed')), aborted]);
          if (life.aborted) return;
          if (!failure) continue;
          this.setStatus({ state:'error',error:`the agent is missing or outdated and reinstalling it failed: ${message(failure)}` });
        } else this.setStatus({ state:'error',error:message(error) });
      }
      await wait(Math.min(this.maxMs, this.minMs * 2 ** attempt++), life);
      reinstalled = false;
    }
  }

  private async connect(life: AbortSignal, connected: () => void): Promise<void> {
    const conn = new AbortController();
    const abort = () => conn.abort();
    life.addEventListener('abort', abort, { once:true });
    let stale: Error | undefined;
    let timer: NodeJS.Timeout | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { stale = new Error(`no data from agent for ${Math.round(this.staleMs / 1000)}s`); conn.abort(); }, this.staleMs);
    };
    try {
      const base = await Promise.race([this.endpoint.open(), new Promise<never>((_, reject) => conn.signal.addEventListener('abort', () => reject(new Error('aborted')), { once:true }))]);
      // Armed before /api/version so a tunnel that accepts but never answers is also abandoned.
      arm();
      const info = await (await this.call(base, '/api/version', { signal:conn.signal })).json() as AgentVersionInfo;
      if (info.protocol !== AGENT_PROTOCOL_VERSION) throw new Error(`protocol mismatch: agent ${info.version ?? '?'} speaks v${info.protocol}, this app needs v${AGENT_PROTOCOL_VERSION}; upgrade the agent or the app`);
      const response = await this.call(base, '/api/events', { headers:{accept:'text/event-stream'},signal:conn.signal });
      if (!response.body) throw new Error('event stream has no body');
      for await (const event of sse(response.body, arm)) {
        if (event.type !== 'snapshot') continue;
        this.remote = JSON.parse(event.data) as MonitorSnapshot;
        if (this.status.state !== 'connected') {
          this.base = base;
          connected();
          this.setStatus({ state:'connected',error:undefined,lastConnectedAt:Date.now() }, false);
          // Reconnected agents may have restarted; re-select so the run's agents come back. Failure just leaves them hidden.
          if (this.selectedRunId) void this.request('/api/load-run', { method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ runId:this.selectedRunId }) }).catch(() => undefined);
        }
        this.emitSnapshot();
      }
    } catch (error) {
      throw stale ?? error;
    } finally {
      clearTimeout(timer);
      life.removeEventListener('abort', abort);
      conn.abort();
    }
  }

  private setStatus(changes: Partial<RemoteHostStatus>, emit = true) {
    this.status = { ...this.status,...changes };
    if (changes.error === undefined) delete this.status.error;
    if (emit) this.emitSnapshot();
  }

  private emitSnapshot() { if (this.running) this.emit('snapshot'); }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once:true });
  });
}

/** Minimal text/event-stream parser; `onData` fires for every chunk, including `: ping` comments. */
async function* sse(body: ReadableStream<Uint8Array>, onData: () => void): AsyncGenerator<{ type: string; data: string }> {
  const decoder = new TextDecoder();
  let buffer = '', type = '', data: string[] = [];
  for await (const chunk of body) {
    onData();
    buffer += decoder.decode(chunk, { stream:true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (!line) {
        if (data.length) yield { type:type || 'message',data:data.join('\n') };
        type = ''; data = [];
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') type = value;
      else if (field === 'data') data.push(value);
    }
  }
}

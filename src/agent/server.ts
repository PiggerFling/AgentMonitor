import http from 'node:http';
import os from 'node:os';
import { version } from '../../package.json';
import { AGENT_HEARTBEAT_MS, AGENT_PROTOCOL_VERSION, type AgentVersionInfo } from '../shared/remoteProtocol';
import type { MultiSourceMonitor } from '../main/trace-monitor/MultiSourceMonitor';

export type AgentMonitor = Pick<MultiSourceMonitor, 'snapshot' | 'getTrace' | 'loadRun'> & {
  on(event: 'snapshot', listener: () => void): unknown;
  off(event: 'snapshot', listener: () => void): unknown;
};
export interface AgentServerOptions { heartbeatMs?: number; coalesceMs?: number; maxBodyBytes?: number }

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }

function send(res: http.ServerResponse, status: number, body?: unknown) {
  if (res.headersSent) { res.destroy(); return; }
  if (body === undefined) { res.writeHead(status, {'Cache-Control': 'no-store'}).end(); return; }
  const json = JSON.stringify(body);
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(json), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}).end(json);
}
function validId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value || value.length > 1024) throw new HttpError(400, `Invalid ${name}`);
  return value;
}
function hostAllowed(host: string | undefined) {
  if (!host) return false;
  try { return LOOPBACK_HOSTS.has(new URL(`http://${host}`).hostname); } catch { return false; }
}
async function readJson(req: http.IncomingMessage, limit: number): Promise<unknown> {
  if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Expected application/json');
  if (Number(req.headers['content-length']) > limit) throw new HttpError(413, 'Request body too large');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON body'); }
}

/** HTTP server for src/shared/remoteProtocol.ts. Returned unlistened; bind it to loopback only. */
export function createAgentServer(monitor: AgentMonitor, options: AgentServerOptions = {}): http.Server {
  const heartbeatMs = options.heartbeatMs ?? AGENT_HEARTBEAT_MS, coalesceMs = options.coalesceMs ?? 100, maxBody = options.maxBodyBytes ?? 16 * 1024;
  const clients = new Set<http.ServerResponse>();
  let pending: NodeJS.Timeout | undefined, heartbeat: NodeJS.Timeout | undefined;
  const frame = () => `event: snapshot\ndata: ${JSON.stringify(monitor.snapshot())}\n\n`;
  const broadcast = () => {
    pending = undefined;
    let data: string;
    try { data = frame(); } catch (error) { console.error('Snapshot failed:', error); return; }
    for (const client of clients) client.write(data);
  };
  // One monitor listener shared by all SSE clients; bursts of changes collapse into one frame.
  const onSnapshot = () => { pending ??= setTimeout(broadcast, coalesceMs); };
  const detach = (res: http.ServerResponse) => {
    if (!clients.delete(res) || clients.size) return;
    monitor.off('snapshot', onSnapshot);
    clearTimeout(pending); clearInterval(heartbeat); pending = heartbeat = undefined;
  };
  const subscribe = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const initial = frame();
    res.writeHead(200, {'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'});
    res.write(initial);
    req.socket.setNoDelay(true);
    if (!clients.size) {
      monitor.on('snapshot', onSnapshot);
      heartbeat = setInterval(() => { for (const client of clients) client.write(': ping\n\n'); }, heartbeatMs);
    }
    clients.add(res);
    res.on('close', () => detach(res));
  };
  const route = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (!hostAllowed(req.headers.host)) throw new HttpError(403, 'Forbidden host');
    // Browsers attach Origin to cross-site requests; the desktop client never does.
    if (req.headers.origin !== undefined) throw new HttpError(403, 'Cross-origin requests are not allowed');
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = (expected: string) => { if (req.method !== expected) { res.setHeader('Allow', expected); throw new HttpError(405, 'Method not allowed'); } };
    switch (url.pathname) {
      case '/api/version': method('GET'); return send(res, 200, {protocol: AGENT_PROTOCOL_VERSION, version, hostname: os.hostname()} satisfies AgentVersionInfo);
      case '/api/snapshot': method('GET'); return send(res, 200, monitor.snapshot());
      case '/api/trace': method('GET'); return send(res, 200, await monitor.getTrace(validId(url.searchParams.get('agentId') ?? undefined, 'agent identifier')));
      case '/api/load-run': {
        method('POST');
        const body = await readJson(req, maxBody);
        await monitor.loadRun(validId(body && typeof body === 'object' ? (body as {runId?: unknown}).runId : undefined, 'run identifier'));
        return send(res, 204);
      }
      case '/api/events': method('GET'); return subscribe(req, res);
      default: throw new HttpError(404, 'Not found');
    }
  };
  const server = http.createServer((req, res) => {
    route(req, res).catch(error => {
      if (error instanceof HttpError) {
        // Unread or oversized bodies would otherwise stall the connection.
        if (!req.complete) res.setHeader('Connection', 'close');
        return send(res, error.status, {error: error.message});
      }
      console.error(`${req.method} ${req.url} failed:`, error);
      send(res, 500, {error: error instanceof Error ? error.message : String(error)});
    });
  });
  const close = server.close.bind(server);
  server.close = (callback?: (error?: Error) => void) => {
    // Detach now rather than on each response's close event, which can arrive after the caller resumes.
    for (const client of [...clients]) { client.destroy(); detach(client); }
    return close(callback);
  };
  return server;
}

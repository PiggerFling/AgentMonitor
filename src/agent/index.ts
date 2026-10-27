import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { AddressInfo } from 'node:net';
import { TraceMonitor } from '../main/trace-monitor/TraceMonitor';
import { HermesMonitor } from '../main/trace-monitor/HermesMonitor';
import { MultiSourceMonitor } from '../main/trace-monitor/MultiSourceMonitor';
import { AGENT_DEFAULT_PORT } from '../shared/remoteProtocol';
import { createAgentServer } from './server';

/** Printed on its own stdout line once the server listens; the desktop app waits for it in managed mode. */
const READY_LINE = 'agent-monitor ready';

const usage = `Usage: agent-monitor-agent [--port <port>] [--host <loopback address>] [--socket <path>] [--exit-on-stdin-close]
Serves local traces to the Agent Monitor desktop app over an SSH tunnel.
  --port                 default $AGENT_MONITOR_PORT or ${AGENT_DEFAULT_PORT}
  --host                 default $AGENT_MONITOR_HOST or 127.0.0.1 (loopback only)
  --socket               listen on this Unix socket (mode 600) instead of TCP
  --exit-on-stdin-close  shut down when stdin ends, e.g. when the ssh session that started the agent goes away
Prints "${READY_LINE}" on stdout once listening.`;
function fail(message: string): never { console.error(`agent-monitor agent: ${message}`); process.exit(2); }
function isLoopback(host: string) {
  if (host === 'localhost') return true;
  if (net.isIPv4(host)) return host.startsWith('127.');
  return net.isIPv6(host) && new URL(`http://[${host}]`).hostname === '[::1]';
}

let args;
try { args = parseArgs({options: {port: {type: 'string'}, host: {type: 'string'}, socket: {type: 'string'}, 'exit-on-stdin-close': {type: 'boolean'}, help: {type: 'boolean', short: 'h'}}}).values; } catch (error) { fail(`${(error as Error).message}\n${usage}`); }
if (args.help) { console.log(usage); process.exit(0); }
const socketPath = args.socket === undefined ? undefined : path.resolve(args.socket);
if (socketPath !== undefined && (args.port !== undefined || args.host !== undefined)) fail('--socket cannot be combined with --port or --host');
let port = 0, host = '';
if (socketPath === undefined) {
  const portText = args.port ?? process.env.AGENT_MONITOR_PORT ?? String(AGENT_DEFAULT_PORT);
  port = Number(portText);
  if (!/^\d+$/.test(portText) || port > 65535) fail(`invalid port: ${portText}`);
  host = (args.host ?? process.env.AGENT_MONITOR_HOST ?? '127.0.0.1').replace(/^\[(.*)\]$/, '$1');
  if (!isLoopback(host)) fail(`refusing to listen on non-loopback host "${host}". The agent has no authentication or encryption of its own;\nkeep it on 127.0.0.1 and reach it through an SSH tunnel (e.g. ssh -L ${port}:127.0.0.1:${port} <server>), which the desktop app sets up for you.`);
}

/** Removes a leftover socket file only when nothing answers on it, so a running agent is never displaced. */
async function clearStaleSocket(file: string) {
  let stat;
  try { stat = lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (!stat.isSocket()) fail(`${file} exists and is not a socket`);
  const live = await new Promise<boolean>(resolve => {
    const probe = net.connect(file);
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('error', () => { probe.destroy(); resolve(false); });
  });
  if (live) fail(`another process is already listening on ${file}`);
  unlinkSync(file);
}

const idle = Number(process.env.AGENT_MONITOR_IDLE_MS);
const fileMonitor = new TraceMonitor({
  ...(process.env.AGENT_MONITOR_TRACE_ROOT ? {roots: [path.resolve(process.env.AGENT_MONITOR_TRACE_ROOT)]} : {}),
  ...(Number.isFinite(idle) && idle > 0 ? {idleMs: idle} : {}),
});
const monitor = new MultiSourceMonitor([
  ...(process.env.AGENT_MONITOR_TRACE_ROOT ? [] : [new HermesMonitor(Number.isFinite(idle) && idle > 0 ? {idleMs:idle} : {})]),
  fileMonitor,
]);
const server = createAgentServer(monitor);
server.on('error', error => { console.error('agent-monitor agent:', error.message); void monitor.stop().finally(() => process.exit(1)); });
void monitor.start().catch(error => { console.error('Trace monitor failed:', error); });
let ownedSocket: string | undefined;
// Sync cleanup also covers process.exit() from error paths.
process.on('exit', () => { if (ownedSocket) try { unlinkSync(ownedSocket); } catch {} });
async function listen() {
  if (socketPath === undefined) {
    server.listen(port, host, () => {
      const address = server.address() as AddressInfo;
      console.log(`agent-monitor agent listening on http://${address.family === 'IPv6' ? `[${address.address}]` : address.address}:${address.port}`);
      console.log(READY_LINE);
    });
    return;
  }
  mkdirSync(path.dirname(socketPath), {recursive: true, mode: 0o700});
  await clearStaleSocket(socketPath);
  // The umask keeps the socket private from the moment it is created; chmod makes the mode explicit.
  const umask = process.umask(0o177);
  server.listen(socketPath, () => {
    process.umask(umask);
    ownedSocket = socketPath;
    chmodSync(socketPath, 0o600);
    console.log(`agent-monitor agent listening on ${socketPath}`);
    console.log(READY_LINE);
  });
  server.once('error', () => process.umask(umask));
}
void listen().catch(error => { console.error('agent-monitor agent:', (error as Error).message); void monitor.stop().finally(() => process.exit(1)); });

let stopping = false;
function shutdown() {
  if (stopping) process.exit(1);
  stopping = true;
  server.close();
  void monitor.stop().catch(error => { console.error('Trace monitor stop failed:', error); }).finally(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
if (args['exit-on-stdin-close']) {
  const gone = () => { if (!stopping) shutdown(); };
  process.stdin.on('end', gone).on('close', gone).on('error', gone).resume();
}

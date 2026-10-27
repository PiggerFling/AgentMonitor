import net from 'node:net';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { AddressInfo } from 'node:net';
import { TraceMonitor } from '../main/trace-monitor/TraceMonitor';
import { HermesMonitor } from '../main/trace-monitor/HermesMonitor';
import { MultiSourceMonitor } from '../main/trace-monitor/MultiSourceMonitor';
import { AGENT_DEFAULT_PORT } from '../shared/remoteProtocol';
import { createAgentServer } from './server';

const usage = `Usage: agent-monitor-agent [--port <port>] [--host <loopback address>]
Serves local traces to the Agent Monitor desktop app over an SSH tunnel.
  --port  default $AGENT_MONITOR_PORT or ${AGENT_DEFAULT_PORT}
  --host  default $AGENT_MONITOR_HOST or 127.0.0.1 (loopback only)`;
function fail(message: string): never { console.error(`agent-monitor agent: ${message}`); process.exit(2); }
function isLoopback(host: string) {
  if (host === 'localhost') return true;
  if (net.isIPv4(host)) return host.startsWith('127.');
  return net.isIPv6(host) && new URL(`http://[${host}]`).hostname === '[::1]';
}

let args;
try { args = parseArgs({options: {port: {type: 'string'}, host: {type: 'string'}, help: {type: 'boolean', short: 'h'}}}).values; } catch (error) { fail(`${(error as Error).message}\n${usage}`); }
if (args.help) { console.log(usage); process.exit(0); }
const portText = args.port ?? process.env.AGENT_MONITOR_PORT ?? String(AGENT_DEFAULT_PORT);
const port = Number(portText);
if (!/^\d+$/.test(portText) || port > 65535) fail(`invalid port: ${portText}`);
const host = (args.host ?? process.env.AGENT_MONITOR_HOST ?? '127.0.0.1').replace(/^\[(.*)\]$/, '$1');
if (!isLoopback(host)) fail(`refusing to listen on non-loopback host "${host}". The agent has no authentication or encryption of its own;\nkeep it on 127.0.0.1 and reach it through an SSH tunnel (e.g. ssh -L ${port}:127.0.0.1:${port} <server>), which the desktop app sets up for you.`);

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
server.listen(port, host, () => {
  const address = server.address() as AddressInfo;
  console.log(`agent-monitor agent listening on http://${address.family === 'IPv6' ? `[${address.address}]` : address.address}:${address.port}`);
});

let stopping = false;
function shutdown() {
  if (stopping) process.exit(1);
  stopping = true;
  server.close();
  void monitor.stop().catch(error => { console.error('Trace monitor stop failed:', error); }).finally(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

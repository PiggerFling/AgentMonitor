import net from 'node:net';
import { parseArgs } from 'node:util';
import type { AddressInfo } from 'node:net';
import { createLocalSources } from '../main/trace-monitor/localSources';
import { MultiSourceMonitor } from '../main/trace-monitor/MultiSourceMonitor';
import { parseTraceSourceOptions, validLocalDir } from '../main/trace-monitor/traceSources';
import { AGENT_DEFAULT_PORT } from '../shared/remoteProtocol';
import { StreamMux } from '../shared/streamMux';
import { TRACE_TOOLS } from '../shared/types';
import { createAgentServer } from './server';

/** Printed on its own stdout line once the server listens; the desktop app waits for it in managed mode. */
const READY_LINE = 'agent-monitor ready';

const usage = `Usage: agent-monitor-agent [--port <port>] [--host <loopback address>] [--stdio] [--tools <list>] [--<tool>-dir <path>]
Serves local traces to the Agent Monitor desktop app over an SSH tunnel.
  --port   default $AGENT_MONITOR_PORT or ${AGENT_DEFAULT_PORT}
  --host   default $AGENT_MONITOR_HOST or 127.0.0.1 (loopback only)
  --stdio  serve multiplexed connections on stdin/stdout instead of TCP (src/shared/streamMux.ts), and shut down
           when stdin ends; the desktop app runs the agent this way as the command of its ssh session
  --tools  comma-separated tools to watch, of ${TRACE_TOOLS.join(', ')}; default all ("" for none)
  --claude-dir, --codex-dir, --pi-dir, --hermes-dir <absolute path>
           a tool's data directory; default $CLAUDE_CONFIG_DIR (~/.claude), $CODEX_HOME (~/.codex),
           $PI_CODING_AGENT_DIR (~/.pi/agent), $HERMES_HOME (~/.hermes)
$AGENT_MONITOR_TRACE_ROOT replaces all of these with one trace directory.
Prints "${READY_LINE}" on stdout once listening.`;
function fail(message: string): never { console.error(`agent-monitor agent: ${message}`); process.exit(2); }
function isLoopback(host: string) {
  if (host === 'localhost') return true;
  if (net.isIPv4(host)) return host.startsWith('127.');
  return net.isIPv6(host) && new URL(`http://[${host}]`).hostname === '[::1]';
}

let args;
try { args = parseArgs({options: {port: {type: 'string'}, host: {type: 'string'}, stdio: {type: 'boolean'}, tools: {type: 'string'},
  'claude-dir': {type: 'string'}, 'codex-dir': {type: 'string'}, 'pi-dir': {type: 'string'}, 'hermes-dir': {type: 'string'}, help: {type: 'boolean', short: 'h'}}}).values; } catch (error) { fail(`${(error as Error).message}\n${usage}`); }
if (args.help) { console.log(usage); process.exit(0); }
const stdio = args.stdio === true;
if (stdio && (args.port !== undefined || args.host !== undefined)) fail('--stdio cannot be combined with --port or --host');
// stdout carries the multiplexed connections after the ready line; anything else logged goes to stderr.
if (stdio) console.log = console.info = console.debug = console.error;
let port = 0, host = '';
if (!stdio) {
  const portText = args.port ?? process.env.AGENT_MONITOR_PORT ?? String(AGENT_DEFAULT_PORT);
  port = Number(portText);
  if (!/^\d+$/.test(portText) || port > 65535) fail(`invalid port: ${portText}`);
  host = (args.host ?? process.env.AGENT_MONITOR_HOST ?? '127.0.0.1').replace(/^\[(.*)\]$/, '$1');
  if (!isLoopback(host)) fail(`refusing to listen on non-loopback host "${host}". The agent has no authentication or encryption of its own;\nkeep it on 127.0.0.1 and reach it through an SSH tunnel (e.g. ssh -L ${port}:127.0.0.1:${port} <server>), which the desktop app sets up for you.`);
}

const tools = typeof args.tools === 'string' ? args.tools.split(',').map(tool => tool.trim()).filter(Boolean) : undefined;
const traceDirs = Object.fromEntries(TRACE_TOOLS.flatMap(tool => { const dir = args[`${tool}-dir`]; return dir === undefined ? [] : [[tool, dir]]; }));
const unknownTool = tools?.find(tool => !(TRACE_TOOLS as readonly string[]).includes(tool));
if (unknownTool) fail(`unknown tool in --tools: ${unknownTool} (expected ${TRACE_TOOLS.join(', ')})`);
for (const [tool, dir] of Object.entries(traceDirs)) if (!dir || !validLocalDir(dir)) fail(`--${tool}-dir must be an absolute path: ${dir}`);
const sourceOptions = parseTraceSourceOptions({tools, traceDirs}, validLocalDir);
if ('problem' in sourceOptions) fail(sourceOptions.problem);
const monitor = new MultiSourceMonitor(createLocalSources(sourceOptions.options));
const server = createAgentServer(monitor);
server.on('error', error => { console.error('agent-monitor agent:', error.message); void monitor.stop().finally(() => process.exit(1)); });
void monitor.start().catch(error => { console.error('Trace monitor failed:', error); });
let stopping = false;
function shutdown() {
  if (stopping) process.exit(1);
  stopping = true;
  server.close();
  void monitor.stop().catch(error => { console.error('Trace monitor stop failed:', error); }).finally(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
if (!stdio) {
  server.listen(port, host, () => {
    const address = server.address() as AddressInfo;
    console.log(`agent-monitor agent listening on http://${address.family === 'IPv6' ? `[${address.address}]` : address.address}:${address.port}`);
    console.log(READY_LINE);
  });
} else {
  // Each channel is one connection to the HTTP server; the session ends with stdin, i.e. with the ssh session.
  const mux = new StreamMux(process.stdout);
  mux.on('channel', channel => server.emit('connection', channel));
  mux.once('close', () => { if (!stopping) shutdown(); });
  process.stdin.on('data', (chunk: Buffer) => mux.receive(chunk)).on('end', () => mux.end()).on('close', () => mux.end()).on('error', () => mux.end());
  process.stdout.write(`${READY_LINE}\n`);
}

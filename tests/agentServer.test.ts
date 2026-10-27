import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createAgentServer } from '../src/agent/server';
import { AGENT_PROTOCOL_VERSION } from '../src/shared/remoteProtocol';
import type { MonitorSnapshot, TraceEntry } from '../src/shared/types';

class FakeMonitor extends EventEmitter {
  loaded: string[] = [];
  revision = 0;
  snapshot(): MonitorSnapshot { return { runs: [{id:'run-1',harness:'claude'}], agents: [], edges: [], errors: [`rev ${this.revision}`], watching: true }; }
  async getTrace(id: string): Promise<TraceEntry[]> {
    if (id === 'boom') throw new Error('trace exploded');
    return [{id:'e1',kind:'assistant',text:id}];
  }
  async loadRun(id: string) { if (id === 'missing') throw new Error(`Unknown trace run: ${id}`); this.loaded.push(id); }
}

async function start(options = {}) {
  const monitor = new FakeMonitor();
  const server = createAgentServer(monitor, options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  const request = (path: string, init: { method?: string; headers?: Record<string,string>; body?: string } = {}) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers: init.headers }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => body += chunk); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on('error', reject); req.end(init.body);
  });
  const post = (body: string, type = 'application/json') => request('/api/load-run', { method: 'POST', headers: {'Content-Type': type}, body });
  return { monitor, server, port, request, post, close: () => new Promise(resolve => server.close(resolve)) };
}

/** Reads SSE frames from /api/events until `count` frames (events or comments) have arrived. */
function events(port: number) {
  const frames: string[] = [];
  let buffer = '', waiter: (() => void) | undefined;
  const req = http.get({ host: '127.0.0.1', port, path: '/api/events' });
  const ready = new Promise<http.IncomingMessage>(resolve => req.on('response', res => {
    res.setEncoding('utf8'); res.on('error', () => {});
    res.on('data', chunk => { buffer += chunk; let i; while ((i = buffer.indexOf('\n\n')) >= 0) { frames.push(buffer.slice(0, i)); buffer = buffer.slice(i + 2); } waiter?.(); });
    resolve(res);
  }));
  req.on('error', () => {});
  const until = async (count: number) => { while (frames.length < count) await new Promise<void>(resolve => waiter = resolve); return frames; };
  return { frames, ready, until, close: () => req.destroy() };
}
const snapshotOf = (frame: string) => { assert.match(frame, /^event: snapshot\ndata: /); return JSON.parse(frame.slice(frame.indexOf('data: ') + 6)) as MonitorSnapshot; };
const waitFor = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(check()); };

test('version, snapshot, trace and load-run routes', async () => {
  const agent = await start();
  try {
    const version = await agent.request('/api/version');
    assert.equal(version.status, 200);
    assert.match(String(version.headers['content-type']), /application\/json/);
    assert.equal(version.headers['access-control-allow-origin'], undefined);
    const info = JSON.parse(version.body);
    assert.equal(info.protocol, AGENT_PROTOCOL_VERSION);
    assert.equal(typeof info.version, 'string');
    assert.ok(info.hostname);
    assert.deepEqual(JSON.parse((await agent.request('/api/snapshot')).body), agent.monitor.snapshot());
    assert.deepEqual(JSON.parse((await agent.request('/api/trace?agentId=a%2Fb')).body), [{id:'e1',kind:'assistant',text:'a/b'}]);
    const loaded = await agent.post(JSON.stringify({runId:'run-1'}));
    assert.equal(loaded.status, 204);
    assert.equal(loaded.body, '');
    assert.deepEqual(agent.monitor.loaded, ['run-1']);
  } finally { await agent.close(); }
});

test('rejects bad input, unknown routes, wrong methods and surfaces monitor errors', async () => {
  const agent = await start();
  const error = async (response: Promise<{ status: number; body: string }>, status: number) => {
    const { status: actual, body } = await response;
    assert.equal(actual, status, body);
    assert.equal(typeof JSON.parse(body).error, 'string');
  };
  try {
    await error(agent.request('/api/trace'), 400);
    await error(agent.request('/api/trace?agentId='), 400);
    await error(agent.request(`/api/trace?agentId=${'x'.repeat(1025)}`), 400);
    await error(agent.post(JSON.stringify({})), 400);
    await error(agent.post(JSON.stringify({runId:''})), 400);
    await error(agent.post(JSON.stringify({runId:7})), 400);
    await error(agent.post(JSON.stringify({runId:'r'.repeat(1025)})), 400);
    await error(agent.post('null'), 400);
    await error(agent.post('{not json'), 400);
    await error(agent.post(JSON.stringify({runId:'run-1'}), 'text/plain'), 415);
    await error(agent.post(JSON.stringify({runId:'x'.repeat(20_000)})), 413);
    await error(agent.request('/api/nope'), 404);
    await error(agent.request('/'), 404);
    await error(agent.request('/api/snapshot', {method:'POST'}), 405);
    await error(agent.request('/api/load-run'), 405);
    await error(agent.request('/api/trace?agentId=boom'), 500);
    await error(agent.post(JSON.stringify({runId:'missing'})), 500);
    assert.deepEqual(agent.monitor.loaded, []);
    assert.equal((await agent.request('/api/version')).status, 200);
  } finally { await agent.close(); }
});

test('rejects non-loopback Host headers and cross-origin requests', async () => {
  const agent = await start();
  try {
    for (const host of ['evil.example', 'evil.example:8787', '127.0.0.1.evil.example', '127.0.0.2', '[::2]']) assert.equal((await agent.request('/api/snapshot', {headers:{Host:host}})).status, 403, host);
    for (const host of [`127.0.0.1:${agent.port}`, 'localhost', `localhost:${agent.port}`, '[::1]', `[::1]:${agent.port}`]) assert.equal((await agent.request('/api/version', {headers:{Host:host}})).status, 200, host);
    assert.equal((await agent.request('/api/snapshot', {headers:{Origin:'https://evil.example'}})).status, 403);
    assert.equal((await agent.post(JSON.stringify({runId:'run-1'}))).status, 204);
  } finally { await agent.close(); }
});

test('events stream sends initial snapshot, coalesced pushes and heartbeats, then cleans up', async () => {
  const agent = await start({heartbeatMs: 40, coalesceMs: 10});
  try {
    const stream = events(agent.port);
    const res = await stream.ready;
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /^text\/event-stream/);
    assert.equal(snapshotOf((await stream.until(1))[0]).errors[0], 'rev 0');
    agent.monitor.revision = 1;
    agent.monitor.emit('snapshot'); agent.monitor.emit('snapshot'); agent.monitor.emit('snapshot');
    const frames = await stream.until(3);
    const snapshots = frames.filter(frame => frame.startsWith('event:'));
    assert.equal(snapshots.length, 2, 'burst coalesced into one frame');
    assert.equal(snapshotOf(snapshots[1]).errors[0], 'rev 1');
    assert.ok(frames.includes(': ping'));
    assert.equal(agent.monitor.listenerCount('snapshot'), 1);
    stream.close();
    await waitFor(() => agent.monitor.listenerCount('snapshot') === 0);
    // A fresh client re-subscribes after the last one left.
    const again = events(agent.port);
    await again.until(1);
    assert.equal(agent.monitor.listenerCount('snapshot'), 1);
    again.close();
    await waitFor(() => agent.monitor.listenerCount('snapshot') === 0);
  } finally { await agent.close(); }
});

test('closing the server ends open event streams and releases the monitor', async () => {
  const agent = await start({heartbeatMs: 20});
  const stream = events(agent.port);
  await stream.until(1);
  assert.equal(agent.monitor.listenerCount('snapshot'), 1);
  const res = await stream.ready;
  const ended = new Promise(resolve => res.on('close', resolve));
  await agent.close();
  await ended;
  assert.equal(agent.monitor.listenerCount('snapshot'), 0);
});

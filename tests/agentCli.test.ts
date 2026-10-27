import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { StreamMux } from '../src/shared/streamMux';

const AGENT = fileURLToPath(new URL('../src/agent/index.ts', import.meta.url));

/** A temporary HOME with an empty trace root. */
async function home(t: test.TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'am-agent-'));
  await mkdir(path.join(dir, 'traces'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Runs the agent from source; `ready` resolves on its ready line and rejects if it exits first. `env` adds variables;
 * undefined values remove them (AGENT_MONITOR_TRACE_ROOT is set to `<dir>/traces` by default).
 */
function agent(t: test.TestContext, dir: string, args: string[], env: Record<string, string | undefined> = {}) {
  const merged = { ...process.env, HOME: dir, USERPROFILE: dir, AGENT_MONITOR_TRACE_ROOT: path.join(dir, 'traces'), ...env };
  const child = spawn(process.execPath, ['--import', 'tsx', AGENT, ...args], {
    env: Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined)), stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } });
  const ready = (async () => {
    const deadline = Date.now() + 15_000;
    while (!stdout.split(/\r?\n/).includes('agent-monitor ready')) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(`agent not ready: ${stdout}${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  })();
  ready.catch(() => {});
  return { child, ready, exited, stdout: () => stdout, stderr: () => stderr };
}

function getVersion(options: http.RequestOptions): Promise<{ status: number; protocol: number }> {
  return new Promise((resolve, reject) => {
    http.get({ ...options, path: '/api/version' }, res => {
      let body = ''; res.setEncoding('utf8').on('data', chunk => body += chunk).on('end', () => resolve({ status: res.statusCode!, protocol: JSON.parse(body).protocol }));
    }).on('error', reject);
  });
}

test('--stdio serves HTTP over multiplexed stdin/stdout and exits when stdin ends', async t => {
  const dir = await home(t);
  const run = agent(t, dir, ['--stdio']);
  await run.ready;
  // Nothing but the ready line precedes the frames.
  assert.equal(run.stdout(), 'agent-monitor ready\n');
  run.child.stdout.removeAllListeners('data');
  const mux = new StreamMux(run.child.stdin);
  run.child.stdout.on('data', (chunk: Buffer) => mux.receive(chunk));
  const versions = await Promise.all([1, 2, 3].map(() => getVersion({ host: 'localhost', createConnection: () => mux.open() as net.Socket })));
  assert.deepEqual(versions, Array(3).fill({ status: 200, protocol: 1 }));
  // stdin is open: the agent keeps serving.
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(run.child.exitCode, null);
  run.child.stdin.end();
  assert.equal(await run.exited, 0);
});

test('TCP mode still prints the ready line and refuses non-loopback hosts', async t => {
  const dir = await home(t);
  const run = agent(t, dir, ['--port', '0']);
  await run.ready;
  const port = Number(/listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(run.stdout())?.[1]);
  assert.deepEqual(await getVersion({ host: '127.0.0.1', port }), { status: 200, protocol: 1 });
  const refused = agent(t, dir, ['--host', '0.0.0.0']);
  assert.equal(await refused.exited, 2);
  assert.match(refused.stderr(), /refusing to listen on non-loopback host "0\.0\.0\.0"/);
  const mixed = agent(t, dir, ['--stdio', '--port', '1']);
  assert.equal(await mixed.exited, 2);
});

test('--tools and --<tool>-dir restrict and redirect the watched directories', async t => {
  const dir = await home(t);
  const write = async (file: string, record: unknown) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, `${JSON.stringify(record)}\n`); };
  const codex = (id: string) => ({ type: 'session_meta', payload: { session_id: id, id, thread_source: 'user', cwd: '/tmp/x', model_provider: 'openai', model: 'gpt' } });
  await write(path.join(dir, '.claude', 'projects', 'p', 'c.jsonl'), { type: 'user', sessionId: 'c1', uuid: 'c1:user', cwd: '/tmp/x', message: { role: 'user', content: 'hi' } });
  await write(path.join(dir, '.codex', 'sessions', 'default.jsonl'), codex('codex-default'));
  await write(path.join(dir, 'custom codex', 'sessions', 'custom.jsonl'), codex('codex-custom'));
  await write(path.join(dir, '.pi', 'agent', 'sessions', 'p.jsonl'), { type: 'session', version: 3, id: 'p1', cwd: '/tmp/x', provider: 'openai', modelId: 'pi' });
  const clean = { AGENT_MONITOR_TRACE_ROOT: undefined, CODEX_HOME: undefined, CLAUDE_CONFIG_DIR: undefined, PI_CODING_AGENT_DIR: undefined, HERMES_HOME: undefined };
  const run = agent(t, dir, ['--port', '0', '--tools', 'claude,codex', '--codex-dir', path.join(dir, 'custom codex')], clean);
  await run.ready;
  const port = Number(/listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(run.stdout())?.[1]);
  const runs = async () => ((await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json()) as { runs: { id: string }[] }).runs.map(r => r.id).sort();
  const deadline = Date.now() + 10_000;
  while ((await runs()).length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(await runs(), ['claude:c1', 'codex-custom']);
  for (const [args, message] of [[['--tools', 'claude,cursor'], /unknown tool in --tools: cursor/], [['--codex-dir', 'relative'], /--codex-dir must be an absolute path/], [['--pi-dir='], /--pi-dir must be an absolute path/]] as const) {
    const bad = agent(t, dir, ['--port', '0', ...args], clean);
    assert.equal(await bad.exited, 2);
    assert.match(bad.stderr(), message);
  }
});

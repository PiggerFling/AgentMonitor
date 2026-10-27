import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const AGENT = fileURLToPath(new URL('../src/agent/index.ts', import.meta.url));
const posixOnly = { skip: process.platform === 'win32' && 'Unix sockets are for POSIX servers' };

/** A temporary HOME with an empty trace root; /tmp keeps socket paths under the sun_path limit on macOS. */
async function home(t: test.TestContext) {
  const dir = await mkdtemp(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'am-agent-'));
  await mkdir(path.join(dir, 'traces'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Runs the agent from source; `ready` resolves on its ready line and rejects if it exits first. */
function agent(t: test.TestContext, dir: string, args: string[]) {
  const child = spawn(process.execPath, ['--import', 'tsx', AGENT, ...args], {
    env: { ...process.env, HOME: dir, USERPROFILE: dir, AGENT_MONITOR_TRACE_ROOT: path.join(dir, 'traces') }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
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

test('--socket serves on a private Unix socket and exits on stdin close, removing it', posixOnly, async t => {
  const dir = await home(t);
  const socket = path.join(dir, '.agent-monitor', 'agent-test.sock');
  const run = agent(t, dir, ['--socket', socket, '--exit-on-stdin-close']);
  await run.ready;
  assert.equal(statSync(socket).mode & 0o777, 0o600);
  assert.equal(statSync(path.dirname(socket)).mode & 0o777, 0o700);
  assert.deepEqual(await getVersion({ socketPath: socket }), { status: 200, protocol: 1 });
  // stdin is open: the agent keeps serving.
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(run.child.exitCode, null);
  run.child.stdin.end();
  assert.equal(await run.exited, 0);
  assert.equal(existsSync(socket), false);
});

test('--socket replaces a stale socket but refuses one in use', posixOnly, async t => {
  const dir = await home(t);
  const socket = path.join(dir, 'agent.sock');
  const crashed = agent(t, dir, ['--socket', socket]);
  await crashed.ready;
  crashed.child.kill('SIGKILL');
  await crashed.exited;
  assert.ok(existsSync(socket), 'SIGKILL leaves the socket behind');
  const live = agent(t, dir, ['--socket', socket]);
  await live.ready;
  const second = agent(t, dir, ['--socket', socket]);
  assert.equal(await second.exited, 2);
  assert.match(second.stderr(), /already listening/);
  assert.deepEqual(await getVersion({ socketPath: socket }), { status: 200, protocol: 1 });
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
  const mixed = agent(t, dir, ['--socket', path.join(dir, 's.sock'), '--port', '1']);
  assert.equal(await mixed.exited, 2);
});

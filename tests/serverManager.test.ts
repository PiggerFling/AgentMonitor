import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ServerManager } from '../src/main/remote/serverManager';
import { ServersStore } from '../src/main/remote/serversStore';
import type { ServerConfig } from '../src/main/remote/config';
import { MultiSourceMonitor } from '../src/main/trace-monitor/MultiSourceMonitor';
import type { ServerSetupProgress } from '../src/shared/types';
import { fixture } from './fakeServer';

const posixOnly = { skip: process.platform === 'win32' && 'managed servers are POSIX only' };

async function manager(t: test.TestContext) {
  const f = await fixture(t);
  const real = path.join(f.home, '.nvm', 'versions', 'node', 'v99', 'bin', 'node');
  await mkdir(path.dirname(real), { recursive: true });
  await symlink(process.execPath, real);
  const monitor = new MultiSourceMonitor([]);
  const file = path.join(f.dir, 'servers.json');
  const progress: string[] = [];
  const endpoints: [ServerConfig, string | undefined][] = [];
  const { command, commandArgs } = f.options('ok');
  const servers = new ServerManager({
    monitor, store: new ServersStore(file), bundle: () => f.bundle, nodeCandidates: f.candidates, ssh: { command, commandArgs },
    sshHosts: () => [{ alias: 'ok', hostName: 'ok.example' }, { alias: 'auth' }, { alias: 'manual' }],
    onProgress: (p: ServerSetupProgress) => progress.push(`${p.alias}:${p.step}:${p.state}`),
    // Never connects: these tests only follow registration.
    endpoint: (server, sha) => { endpoints.push([server, sha]); return { open: () => new Promise(() => {}), close: async () => {} }; },
  });
  await monitor.start();
  t.after(() => monitor.stop());
  return { f, monitor, servers, file, progress, endpoints, real };
}

test('add and remove requests are validated strictly', posixOnly, async t => {
  const { servers } = await manager(t);
  for (const bad of [null, 'ok', [], {}, { alias: 1 }, { alias: '-oProxyCommand=x' }, { alias: 'a b' }, { alias: 'ok', acceptNewHostKey: 'yes' }, { alias: 'ok', extra: 1 }]) {
    await assert.rejects(servers.addServer(bad), /Invalid/, JSON.stringify(bad));
  }
  for (const bad of [null, { id: 'x' }, { id: 'x', cleanup: 'no' }, { id: '../x', cleanup: false }, { id: 'x', cleanup: true, more: 1 }]) {
    await assert.rejects(servers.removeServer(bad), /Invalid/, JSON.stringify(bad));
  }
});

test('adding probes, installs, saves and connects; removing stops the server and cleans up', posixOnly, async t => {
  const { f, monitor, servers, file, progress, endpoints, real } = await manager(t);
  await writeFile(file, JSON.stringify({ servers: [{ id: 'manual', ssh: 'manual' }] }));
  assert.deepEqual(servers.listSshHosts(), [{ alias: 'ok', hostName: 'ok.example' }, { alias: 'auth' }, { alias: 'manual', serverId: 'manual', managed: false }]);
  assert.deepEqual(await servers.addServer({ alias: 'ok', acceptNewHostKey: true }), { ok: true, serverId: 'ok' });
  assert.deepEqual(progress, ['ok:probe:running', 'ok:probe:done', 'ok:install:running', 'ok:install:done', 'ok:save:running', 'ok:save:done']);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).servers[1], { id: 'ok', ssh: 'ok', managed: true, home: f.home, nodePath: real });
  assert.equal(await readFile(path.join(f.home, '.agent-monitor', 'agent.sha256'), 'utf8'), f.bundle.sha256);
  assert.deepEqual(endpoints.map(([server, sha]) => [server.id, server.managed, sha]), [['ok', { home: f.home, nodePath: real }, f.bundle.sha256]]);
  assert.deepEqual(monitor.snapshot().remotes?.map(remote => [remote.id, remote.state]), [['ok', 'connecting']]);
  assert.equal(servers.listSshHosts()[0].serverId, 'ok');
  assert.deepEqual(await servers.addServer({ alias: 'ok' }), { ok: false, code: 'already-added', message: 'ok is already configured as server "ok"' });
  // The monitor's reinstall hook (used when the tunnel exits with 42) uploads the agent again.
  await writeFile(path.join(f.home, '.agent-monitor', 'agent.sha256'), 'old');
  await servers.remote('ok')!['reinstall']!(new AbortController().signal);
  assert.equal(await readFile(path.join(f.home, '.agent-monitor', 'agent.sha256'), 'utf8'), f.bundle.sha256);

  assert.deepEqual(await servers.removeServer({ id: 'ok', cleanup: true }), { ok: true });
  assert.equal(existsSync(path.join(f.home, '.agent-monitor')), false);
  assert.equal(monitor.snapshot().remotes, undefined);
  assert.equal(servers.remote('ok'), undefined);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).servers, [{ id: 'manual', ssh: 'manual' }]);
  assert.deepEqual(await servers.removeServer({ id: 'ok', cleanup: false }), { ok: false, code: 'not-found', message: 'No server "ok"' });
  // Manual entries are removed without touching the server.
  assert.deepEqual(await servers.removeServer({ id: 'manual', cleanup: true }), { ok: true });
});

test('setup failures come back as result codes with progress marked failed', posixOnly, async t => {
  const { servers, progress, file } = await manager(t);
  const result = await servers.addServer({ alias: 'auth' });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.code, 'auth');
  assert.deepEqual(progress, ['auth:probe:running', 'auth:probe:failed']);
  assert.equal(existsSync(file), false);
  // Saving into a broken servers.json fails without registering the server.
  await writeFile(file, '{');
  const saved = await servers.addServer({ alias: 'ok' });
  assert.equal(!saved.ok && saved.code, 'save-failed');
  assert.equal(servers.remote('ok'), undefined);
});

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ServerManager } from '../src/main/remote/serverManager';
import { ServersStore } from '../src/main/remote/serversStore';
import { loadServersFile, type ServerConfig } from '../src/main/remote/config';
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

test('probe and update requests are validated strictly', posixOnly, async t => {
  const { servers } = await manager(t);
  for (const bad of [null, {}, { alias: 1 }, { alias: '-x' }, { alias: 'ok', sshArgs: 'x' }, { alias: 'ok', sshArgs: [1] }, { alias: 'ok', tools: [] }]) {
    await assert.rejects(servers.probeServer(bad), /Invalid/, JSON.stringify(bad));
  }
  for (const bad of [null, {}, { id: '../x' }, { id: 'x', label: 1 }, { id: 'x', sshArgs: [null] }, { id: 'x', ssh: 'y' }]) {
    await assert.rejects(servers.updateServer(bad), /Invalid/, JSON.stringify(bad));
  }
  for (const bad of [{ alias: 'ok', label: 2 }, { alias: 'ok', sshArgs: 'x' }, { alias: 'ok', home: '/x' }]) {
    await assert.rejects(servers.addServer(bad), /Invalid/, JSON.stringify(bad));
  }
  // Values the user can fix come back as results.
  assert.deepEqual(await servers.updateServer({ id: 'x', tools: ['cursor'] }), { ok: false, code: 'invalid', message: '"tools" must be an array of claude, codex, pi, hermes' });
  assert.equal((await servers.updateServer({ id: 'x', traceDirs: { codex: "/it's" } })).ok, false);
  assert.deepEqual(await servers.addServer({ alias: 'ok', traceDirs: { codex: 'rel' } }), { ok: false, code: 'failed', message: '"traceDirs.codex" must be an absolute POSIX path without quotes, backslashes or control characters' });
  assert.deepEqual(await servers.updateServer({ id: 'x', label: 'X' }), { ok: false, code: 'not-found', message: 'No server "x"' });
});

test('probing reports detected directories; adding saves them with the requested options', posixOnly, async t => {
  const { f, servers, file, endpoints, real } = await manager(t);
  // CODEX_HOME is exported only for interactive shells, as in ~/.zshrc.
  await f.loginShell('case "$1" in -i*) export CODEX_HOME="$HOME/.config/codex";; esac\nexec /bin/sh -c "$2"\n');
  await mkdir(path.join(f.home, '.config', 'codex'), { recursive: true });
  const probe = await servers.probeServer({ alias: 'ok', sshArgs: ['-p', '2222'] });
  assert.deepEqual(probe, { ok: true, home: f.home, os: process.platform === 'darwin' ? 'Darwin' : 'Linux', arch: (await import('node:os')).machine(), nodePath: real, nodeVersion: process.versions.node,
    detected: { claude: `${f.home}/.claude`, codex: `${f.home}/.config/codex`, pi: `${f.home}/.pi/agent`, hermes: `${f.home}/.hermes` }, present: ['codex'] });
  assert.deepEqual((await f.calls()).at(-1)!.slice(-5), ['-p', '2222', '--', 'ok', 'sh -s']);
  assert.equal(existsSync(path.join(f.home, '.agent-monitor')), false);
  const probeFailure = await servers.probeServer({ alias: 'auth' });
  assert.equal(!probeFailure.ok && probeFailure.code, 'auth');

  assert.deepEqual(await servers.addServer({ alias: 'ok', label: ' Dev ', sshArgs: ['-p', '2222'], tools: ['codex', 'claude'] }), { ok: true, serverId: 'ok' });
  const entry = { id: 'ok', label: 'Dev', ssh: 'ok', sshArgs: ['-p', '2222'], managed: true, home: f.home, nodePath: real, tools: ['claude', 'codex'], traceDirs: { codex: `${f.home}/.config/codex` } };
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).servers, [entry]);
  assert.deepEqual(endpoints.map(([server]) => [server.tools, server.traceDirs]), [[['claude', 'codex'], { codex: `${f.home}/.config/codex` }]]);
  assert.deepEqual(servers.listServers(), [{ id: 'ok', label: 'Dev', ssh: 'ok', managed: true, sshArgs: ['-p', '2222'], tools: ['claude', 'codex'], traceDirs: { codex: `${f.home}/.config/codex` } }]);
  // Explicit traceDirs win over detection.
  await servers.removeServer({ id: 'ok', cleanup: false });
  await servers.addServer({ alias: 'ok', traceDirs: {} });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).servers, [{ id: 'ok', ssh: 'ok', managed: true, home: f.home, nodePath: real }]);
});

test('updating saves the entry and reconnects the server in place with the new options', posixOnly, async t => {
  const { f, monitor, servers, file, endpoints, real } = await manager(t);
  await writeFile(file, JSON.stringify({ servers: [{ id: 'manual', ssh: 'manual', note: 'keep' }] }));
  await servers.load(loadServersFile(file).servers, []);
  await servers.addServer({ alias: 'ok' });
  const old = servers.remote('ok')!;
  assert.deepEqual(await servers.updateServer({ id: 'ok', label: 'GPU', tools: ['codex'], traceDirs: { codex: '/data/codex' } }), { ok: true });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).servers[1], { id: 'ok', label: 'GPU', ssh: 'ok', managed: true, home: f.home, nodePath: real, tools: ['codex'], traceDirs: { codex: '/data/codex' } });
  assert.notEqual(servers.remote('ok'), old);
  assert.equal(old['running'], false);
  assert.deepEqual(endpoints.at(-1)![0], { id: 'ok', label: 'GPU', ssh: 'ok', remotePort: 8787, sshArgs: [], managed: { home: f.home, nodePath: real }, tools: ['codex'], traceDirs: { codex: '/data/codex' } });
  assert.deepEqual(monitor.snapshot().remotes?.map(remote => [remote.id, remote.label]), [['manual', 'manual'], ['ok', 'GPU']]);
  // Absent fields are kept; present ones that are empty or complete restore the defaults.
  await servers.updateServer({ id: 'ok', label: '', tools: ['claude', 'codex', 'pi', 'hermes'] });
  assert.deepEqual(servers.listServers()[1], { id: 'ok', label: 'ok', ssh: 'ok', managed: true, sshArgs: [], traceDirs: { codex: '/data/codex' } });
  // Manual servers store the options (their agent takes its own flags) and keep unknown fields.
  assert.deepEqual(await servers.updateServer({ id: 'manual', tools: ['pi'] }), { ok: true });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).servers[0], { id: 'manual', ssh: 'manual', note: 'keep', tools: ['pi'] });
  assert.deepEqual(monitor.snapshot().remotes?.map(remote => remote.id), ['manual', 'ok']);
});

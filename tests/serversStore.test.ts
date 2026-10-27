import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadServersConfig, serversConfigPath } from '../src/main/remote/config';
import { serverIdFor, ServersStore } from '../src/main/remote/serversStore';

test('ids come from the alias, sanitized and unique', () => {
  assert.equal(serverIdFor('dev-1', []), 'dev-1');
  assert.equal(serverIdFor('alice@gpu box:22', []), 'alice-gpu-box-22');
  assert.equal(serverIdFor('@@@', []), 'server');
  assert.equal(serverIdFor('dev', ['dev', 'dev-2']), 'dev-3');
  const long = 'x'.repeat(80);
  assert.equal(serverIdFor(long, ['x'.repeat(64)]), `${'x'.repeat(62)}-2`);
});

async function store(t: test.TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'servers-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { AGENT_MONITOR_SERVERS_FILE: path.join(dir, 'nested', 'servers.json') };
  return { dir, env, file: env.AGENT_MONITOR_SERVERS_FILE, store: new ServersStore(serversConfigPath('/unused', env)) };
}

test('adding creates the file, keeps other entries and fields, and removing drops only that entry', async t => {
  const { dir, env, file, store: servers } = await store(t);
  const first = await servers.addManaged({ alias: 'dev', home: '/home/u', nodePath: '/usr/bin/node' });
  assert.deepEqual(first, { id: 'dev', label: 'dev', ssh: 'dev', remotePort: 8787, sshArgs: [], managed: { home: '/home/u', nodePath: '/usr/bin/node' } });
  const manual = { id: 'dev-2', ssh: 'other', remotePort: 9000, comment: 'mine' };
  const invalid = { id: 'bad id', ssh: '-x' };
  const raw = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...raw, servers: [...raw.servers, manual, invalid], extra: { keep: true } }));
  // Concurrent adds get distinct ids.
  const [a, b] = await Promise.all([servers.addManaged({ alias: 'dev', home: '/h', nodePath: '/n' }), servers.addManaged({ alias: 'dev', label: 'Dev', home: '/h', nodePath: '/n' })]);
  assert.deepEqual([a.id, b.id, b.label], ['dev-3', 'dev-4', 'Dev']);
  assert.deepEqual(loadServersConfig('/unused', env).servers.map(server => server.id), ['dev', 'dev-2', 'dev-3', 'dev-4']);
  assert.deepEqual(await servers.remove('dev'), { id: 'dev', ssh: 'dev', managed: true, home: '/home/u', nodePath: '/usr/bin/node' });
  assert.equal(await servers.remove('dev'), undefined);
  const after = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(after.extra, { keep: true });
  assert.deepEqual(after.servers.slice(0, 2), [manual, invalid]);
  assert.deepEqual(await readdir(path.join(dir, 'nested')), ['servers.json']);
});

test('a broken servers.json is never overwritten', async t => {
  const { file, store: servers } = await store(t);
  await servers.addManaged({ alias: 'dev', home: '/home/u', nodePath: '/usr/bin/node' });
  await writeFile(file, '{"servers": [');
  await assert.rejects(servers.addManaged({ alias: 'x', home: '/h', nodePath: '/n' }), /not valid JSON/);
  await writeFile(file, '{"hosts": []}');
  await assert.rejects(servers.remove('dev'), /expected \{"servers"/);
  assert.equal(await readFile(file, 'utf8'), '{"hosts": []}');
  // Values the config would reject are not written.
  await writeFile(file, '{"servers": []}');
  await assert.rejects(servers.addManaged({ alias: 'x', home: "/it's", nodePath: '/n' }), /"home" must be/);
  assert.equal(await readFile(file, 'utf8'), '{"servers": []}');
});

test('updates replace given fields, drop defaults, keep unknown fields and leave the file alone for unknown ids', async t => {
  const { file, store: servers } = await store(t);
  await mkdir(path.dirname(file));
  await writeFile(file, JSON.stringify({ servers: [{ id: 'dev', label: 'Dev', ssh: 'dev', managed: true, home: '/h', nodePath: '/n', note: 'mine', tools: ['pi'] }], extra: 1 }));
  const updated = await servers.update('dev', { sshArgs: ['-J', 'b'], tools: ['claude', 'codex'], traceDirs: { codex: '/h/.config/codex' } });
  assert.deepEqual(updated, { id: 'dev', label: 'Dev', ssh: 'dev', remotePort: 8787, sshArgs: ['-J', 'b'], managed: { home: '/h', nodePath: '/n' }, tools: ['claude', 'codex'], traceDirs: { codex: '/h/.config/codex' } });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { servers: [{ id: 'dev', label: 'Dev', ssh: 'dev', managed: true, home: '/h', nodePath: '/n', note: 'mine', tools: ['claude', 'codex'], sshArgs: ['-J', 'b'], traceDirs: { codex: '/h/.config/codex' } }], extra: 1 });
  // Undefined and empty values restore the defaults.
  await servers.update('dev', { label: '', sshArgs: [], tools: undefined, traceDirs: undefined });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).servers, [{ id: 'dev', ssh: 'dev', managed: true, home: '/h', nodePath: '/n', note: 'mine' }]);
  await assert.rejects(servers.update('dev', { traceDirs: { codex: 'relative' } }), /"traceDirs\.codex" must be an absolute POSIX path/);
  const before = await readFile(file, 'utf8');
  assert.equal(await servers.update('nope', { label: 'x' }), undefined);
  assert.equal(await readFile(file, 'utf8'), before);
  // New managed entries carry the options too.
  const added = await servers.addManaged({ alias: 'gpu', label: 'GPU', sshArgs: ['-p', '2222'], home: '/g', nodePath: '/n', tools: ['codex'], traceDirs: { codex: '/g/.config/codex' } });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).servers[1], { id: 'gpu', label: 'GPU', ssh: 'gpu', sshArgs: ['-p', '2222'], managed: true, home: '/g', nodePath: '/n', tools: ['codex'], traceDirs: { codex: '/g/.config/codex' } });
  assert.deepEqual([added.tools, added.traceDirs], [['codex'], { codex: '/g/.config/codex' }]);
});

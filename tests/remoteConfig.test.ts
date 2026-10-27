import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadAgentBundle } from '../src/main/remote/agentBundle';
import { ConfigErrorSource, loadServersConfig, parseServersConfig } from '../src/main/remote/config';
import { AGENT_DEFAULT_PORT } from '../src/shared/remoteProtocol';

test('servers.json applies defaults and keeps valid entries', () => {
  const { servers, errors } = parseServersConfig({ servers: [
    { id: 'dev-1', label: 'Dev box', ssh: 'dev-1', remotePort: 9000, sshArgs: ['-J', 'bastion'] },
    { id: 'gpu.2', ssh: 'alice@gpu.example.com' },
  ] });
  assert.deepEqual(errors, []);
  assert.deepEqual(servers, [
    { id: 'dev-1', label: 'Dev box', ssh: 'dev-1', remotePort: 9000, sshArgs: ['-J', 'bastion'] },
    { id: 'gpu.2', label: 'gpu.2', ssh: 'alice@gpu.example.com', remotePort: AGENT_DEFAULT_PORT, sshArgs: [] },
  ]);
});

test('invalid entries are skipped with a readable error each', () => {
  const { servers, errors } = parseServersConfig({ servers: [
    { id: 'ok', ssh: 'ok' },
    { id: 'ok', ssh: 'other' },
    { id: 'bad id', ssh: 'x' },
    { id: 'x'.repeat(65), ssh: 'x' },
    { id: 'opt', ssh: '-oProxyCommand=touch /tmp/pwned' },
    { id: 'space', ssh: 'host extra' },
    { id: 'ctl', ssh: 'host\n' },
    { id: 'empty', ssh: '' },
    { id: 'port0', ssh: 'h', remotePort: 0 },
    { id: 'portbig', ssh: 'h', remotePort: 65536 },
    { id: 'portstr', ssh: 'h', remotePort: '8787' },
    { id: 'portfloat', ssh: 'h', remotePort: 80.5 },
    { id: 'args', ssh: 'h', sshArgs: '-J bastion' },
    { id: 'args2', ssh: 'h', sshArgs: ['-J', 1] },
    'nope',
  ] }, 'servers.json');
  assert.deepEqual(servers.map(server => server.id), ['ok']);
  assert.equal(errors.length, 14);
  assert.match(errors[0], /server #2 \(ok\) skipped: duplicate id "ok"/);
  assert.match(errors[1], /server #3 skipped: "id"/);
  assert.match(errors[3], /\(opt\) skipped: "ssh" must not start with "-"/);
  assert.match(errors[7], /\(port0\) skipped: "remotePort"/);
  assert.match(errors[11], /\(args\) skipped: "sshArgs"/);
  assert.match(parseServersConfig([]).errors[0], /expected \{"servers"/);
});

test('loading: missing file is empty, env override wins, bad JSON is reported', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'servers-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.deepEqual(loadServersConfig(dir, {}), { servers: [], errors: [] });
  await writeFile(path.join(dir, 'servers.json'), JSON.stringify({ servers: [{ id: 'a', ssh: 'a' }] }));
  assert.deepEqual(loadServersConfig(dir, {}).servers.map(server => server.id), ['a']);
  const other = path.join(dir, 'other.json');
  await writeFile(other, '{ nope');
  const result = loadServersConfig(dir, { AGENT_MONITOR_SERVERS_FILE: other });
  assert.equal(result.servers.length, 0);
  assert.match(result.errors[0], /Invalid JSON in .*other\.json/);
});

test('config errors surface as monitor errors without runs', async () => {
  const source = new ConfigErrorSource(['bad entry']);
  assert.deepEqual(source.snapshot(), { runs: [], agents: [], edges: [], errors: ['bad entry'], watching: false });
  await assert.rejects(source.loadRun('x'));
});

test('managed entries carry home and nodePath; legacy entries have no managed field', () => {
  const { servers, errors } = parseServersConfig({ servers: [
    { id: 'm', ssh: 'm', managed: true, home: '/home/u', nodePath: '/home/u/.nvm/versions/node/v22.12.0/bin/node' },
    { id: 'off', ssh: 'off', managed: false },
  ] });
  assert.deepEqual(errors, []);
  assert.deepEqual(servers[0], { id: 'm', label: 'm', ssh: 'm', remotePort: AGENT_DEFAULT_PORT, sshArgs: [],
    managed: { home: '/home/u', nodePath: '/home/u/.nvm/versions/node/v22.12.0/bin/node' } });
  assert.equal('managed' in servers[1], false);
});

test('managed entries need absolute, quote-free remote paths', () => {
  const ok = { ssh: 'h', managed: true, home: '/home/u', nodePath: '/usr/bin/node' };
  const { servers, errors } = parseServersConfig({ servers: [
    { ...ok, id: 'flag', managed: 'yes' },
    { ...ok, id: 'nohome', home: undefined },
    { ...ok, id: 'nonode', nodePath: undefined },
    { ...ok, id: 'relative', home: 'home/u' },
    { ...ok, id: 'quote', nodePath: "/opt/o'node/bin/node" },
    { ...ok, id: 'ctl', home: '/home/u\n' },
    { ...ok, id: 'type', nodePath: 7 },
    { ...ok, id: 'backslash', nodePath: '/opt/a\\b/node' },
    { ...ok, id: 'spaces', home: '/home/my user', nodePath: '/opt/node 22/bin/node' },
    { ...ok, id: 'colon', home: '/home/a:b' },
  ] });
  assert.deepEqual(servers.map(server => server.id), ['spaces', 'colon']);
  assert.equal(errors.length, 8);
  assert.match(errors[0], /\(flag\) skipped: "managed" must be true or false/);
  assert.match(errors[1], /\(nohome\) skipped: "home" is required/);
  assert.match(errors[2], /\(nonode\) skipped: "nodePath" is required/);
  for (const error of errors.slice(3)) assert.match(error, /"(home|nodePath)" must be an absolute POSIX path/);
});

test('the bundled agent is found in resources when packaged and in dist-agent in development', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-bundle-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'dist-agent'));
  await mkdir(path.join(dir, 'resources'));
  await writeFile(path.join(dir, 'dist-agent', 'agent.cjs'), 'dev');
  await writeFile(path.join(dir, 'resources', 'agent.cjs'), 'packaged');
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  const options = { resourcesPath: path.join(dir, 'resources'), mainDir: path.join(dir, 'dist-electron') };
  assert.deepEqual(loadAgentBundle({ ...options, packaged: false }), { path: path.join(dir, 'dist-agent', 'agent.cjs'), sha256: sha('dev') });
  assert.deepEqual(loadAgentBundle({ ...options, packaged: true }), { path: path.join(dir, 'resources', 'agent.cjs'), sha256: sha('packaged') });
  assert.throws(() => loadAgentBundle({ ...options, mainDir: dir, packaged: false }), /ENOENT/);
});

test('tools and traceDirs are validated and normalized', () => {
  const { servers, errors } = parseServersConfig({ servers: [
    { id: 'a', ssh: 'a', tools: ['codex', 'claude', 'codex'], traceDirs: { codex: '/home/u/.config/codex', pi: '' } },
    { id: 'all', ssh: 'all', tools: ['hermes', 'pi', 'codex', 'claude'], traceDirs: {} },
    { id: 'none', ssh: 'none', tools: [] },
    { id: 'tool', ssh: 'x', tools: ['cursor'] },
    { id: 'tools', ssh: 'x', tools: 'claude' },
    { id: 'dirs', ssh: 'x', traceDirs: [] },
    { id: 'key', ssh: 'x', traceDirs: { cursor: '/x' } },
    { id: 'rel', ssh: 'x', traceDirs: { codex: 'codex' } },
    { id: 'quote', ssh: 'x', traceDirs: { claude: "/it's" } },
    { id: 'slash', ssh: 'x', traceDirs: { claude: '/a\\b' } },
    { id: 'ctl', ssh: 'x', traceDirs: { claude: '/a\nb' } },
  ] });
  assert.deepEqual(servers.map(({ id, tools, traceDirs }) => ({ id, tools, traceDirs })), [
    { id: 'a', tools: ['claude', 'codex'], traceDirs: { codex: '/home/u/.config/codex' } },
    { id: 'all', tools: undefined, traceDirs: undefined },
    { id: 'none', tools: [], traceDirs: undefined },
  ]);
  assert.equal(errors.length, 8);
  assert.match(errors[0], /\(tool\) skipped: "tools" must be an array of claude, codex, pi, hermes/);
  assert.match(errors[3], /\(key\) skipped: "traceDirs" has an unknown tool "cursor"/);
  for (const error of errors.slice(4)) assert.match(error, /"traceDirs\.(codex|claude)" must be an absolute POSIX path without quotes, backslashes or control characters/);
});

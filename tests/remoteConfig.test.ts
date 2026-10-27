import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
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

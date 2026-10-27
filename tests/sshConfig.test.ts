import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadSshHosts, parseSshConfig } from '../src/main/remote/sshConfig';

test('lists concrete Host aliases with their HostName, User and Port', () => {
  const hosts = parseSshConfig(`
# comment
User globaluser
Host dev-1 dev-2  "quoted alias" gpu
  HostName %h.internal   # trailing comment
  Port 2222
HOST=gpu
  user = alice
  HostName gpu.example.com
Host *.corp !skip? web-*
  User corp
Host dev-1
  Port 2200
Host bad -oProxyCommand=x
`);
  assert.deepEqual(hosts, [
    { alias: 'dev-1', hostName: 'dev-1.internal', user: 'globaluser', port: 2222 },
    { alias: 'dev-2', hostName: 'dev-2.internal', user: 'globaluser', port: 2222 },
    { alias: 'gpu', hostName: 'gpu.internal', user: 'globaluser', port: 2222 },
    { alias: 'bad', user: 'globaluser' },
  ]);
});

test('first value wins across matching blocks, including wildcard blocks and negations', () => {
  const hosts = parseSshConfig(`
Host a
  HostName a.example
Host * !b
  User star
  Port 99999
Host b
  User bee
Host a b
  User late
`);
  assert.deepEqual(hosts, [{ alias: 'a', hostName: 'a.example', user: 'star' }, { alias: 'b', user: 'bee' }]);
});

test('Match blocks are ignored until the next Host', () => {
  const hosts = parseSshConfig(`
Match host x exec "true"
  User matched
  Host-like-option y
Host after
  hostname after.example
`);
  assert.deepEqual(hosts, [{ alias: 'after', hostName: 'after.example' }]);
});

test('Include contents are parsed in place and keep the enclosing block afterwards', () => {
  const files: Record<string, string> = { 'conf.d/*': 'Host inc-1\n  User inc\nHost inc-2', other: 'Port 2022' };
  const hosts = parseSshConfig('Include conf.d/*\nHost main\n  Include other\n  User m\nHost inc-1\n  Port 1', pattern => files[pattern] === undefined ? [] : [files[pattern]]);
  assert.deepEqual(hosts, [{ alias: 'inc-1', user: 'inc', port: 1 }, { alias: 'inc-2' }, { alias: 'main', user: 'm', port: 2022 }]);
  // Self-includes stop at ssh's depth limit instead of recursing forever.
  assert.deepEqual(parseSshConfig('Host loop\nInclude self', () => ['Include self']), [{ alias: 'loop' }]);
});

test('loadSshHosts reads ~/.ssh/config with globbed Includes relative to ~/.ssh and ~/', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'ssh-config-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.deepEqual(loadSshHosts(home), []);
  await mkdir(path.join(home, '.ssh', 'config.d'), { recursive: true });
  await writeFile(path.join(home, '.ssh', 'config'), 'Include config.d/*.conf ~/extra/ssh missing/*\nHost top\n');
  await writeFile(path.join(home, '.ssh', 'config.d', 'b.conf'), 'Host b\n');
  await writeFile(path.join(home, '.ssh', 'config.d', 'a.conf'), 'Host a\n  HostName 10.0.0.1\n');
  await writeFile(path.join(home, '.ssh', 'config.d', 'c.txt'), 'Host ignored\n');
  await mkdir(path.join(home, 'extra'));
  await writeFile(path.join(home, 'extra', 'ssh'), 'Host extra\n');
  assert.deepEqual(loadSshHosts(home).map(host => host.alias), ['a', 'b', 'extra', 'top']);
});

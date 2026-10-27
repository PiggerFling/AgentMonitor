import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installAgent, probeServer, removeAgent, ServerSetupError, setupServer } from '../src/main/remote/installer';
import { fixture } from './fakeServer';

const posixOnly = { skip: process.platform === 'win32' && 'managed servers are POSIX only' };
const rejectsWith = (code: string, check: (error: ServerSetupError) => void = () => {}) => (error: unknown) => {
  assert.ok(error instanceof ServerSetupError, String(error));
  assert.equal(error.code, code, error.message);
  check(error);
  return true;
};

test('setup picks the newest node >= 22.12, uploads the agent and writes its bare sha256', posixOnly, async t => {
  const f = await fixture(t);
  await f.fakeNode('20.18.0'); await f.fakeNode('22.13.0');
  const real = path.join(f.home, '.nvm', 'versions', 'node', 'v99', 'bin', 'node');
  await mkdir(path.dirname(real), { recursive: true });
  await symlink(process.execPath, real);
  const progress: string[] = [];
  const result = await setupServer({ ...f.options('ok', { sshArgs: ['-J', 'bastion'], acceptNewHostKey: true }), bundle: f.bundle, nodeCandidates: f.candidates, onProgress: (step, state) => progress.push(`${step}:${state}`) });
  assert.deepEqual(result, { home: f.home, os: os.platform() === 'darwin' ? 'Darwin' : 'Linux', arch: os.machine(), nodePath: real, nodeVersion: process.versions.node });
  assert.deepEqual(progress, ['probe:running', 'probe:done', 'install:running', 'install:done']);
  const dir = path.join(f.home, '.agent-monitor');
  assert.equal(await readFile(path.join(dir, 'agent.cjs'), 'utf8'), "console.log('agent');\n");
  assert.equal(await readFile(path.join(dir, 'agent.sha256'), 'utf8'), f.bundle.sha256);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  const [probe, install] = await f.calls();
  assert.deepEqual(probe, ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=accept-new', '-J', 'bastion', '--', 'ok', 'sh -s']);
  assert.ok(!install.includes('StrictHostKeyChecking=accept-new'));
  assert.match(install.at(-1)!, /^sh -c '/);
  // Reinstalling over an existing copy works and removing deletes the directory.
  await writeFile(path.join(dir, 'agent.sha256'), 'old');
  await installAgent({ ...f.options('ok'), home: f.home, bundle: f.bundle });
  assert.equal(await readFile(path.join(dir, 'agent.sha256'), 'utf8'), f.bundle.sha256);
  await removeAgent({ ...f.options('ok'), home: f.home });
  assert.equal(existsSync(dir), false);
});

test('a checksum mismatch fails the install without writing agent.sha256', posixOnly, async t => {
  const f = await fixture(t);
  await assert.rejects(installAgent({ ...f.options('ok'), home: f.home, bundle: { ...f.bundle, sha256: 'f'.repeat(64) } }),
    rejectsWith('install-failed', error => assert.match(error.message, new RegExp(`sha256 ${f.bundle.sha256}`))));
  assert.equal(existsSync(path.join(f.home, '.agent-monitor', 'agent.sha256')), false);
});

test('node missing or too old is reported with the best version found', posixOnly, async t => {
  const f = await fixture(t);
  const progress: string[] = [];
  await assert.rejects(setupServer({ ...f.options('ok'), bundle: f.bundle, nodeCandidates: f.candidates, onProgress: (step, state) => progress.push(`${step}:${state}`) }), rejectsWith('node-missing'));
  assert.deepEqual(progress, ['probe:running', 'probe:failed']);
  await f.fakeNode('18.20.4'); await f.fakeNode('22.11.0');
  await assert.rejects(probeServer({ ...f.options('ok'), nodeCandidates: f.candidates }), rejectsWith('node-too-old', error => assert.equal(error.extra.nodeVersion, '22.11.0')));
  // node on PATH counts too.
  await symlink(process.execPath, path.join(f.bin, 'node'));
  assert.equal((await probeServer({ ...f.options('ok'), nodeCandidates: f.candidates })).nodePath, path.join(f.bin, 'node'));
});

test('ssh failures are classified', posixOnly, async t => {
  const f = await fixture(t);
  await assert.rejects(probeServer(f.options('auth')), rejectsWith('auth', error => assert.match(error.extra.detail!, /Permission denied/)));
  await assert.rejects(probeServer(f.options('hostkey')), rejectsWith('host-key', error => assert.equal(error.extra.fingerprint, 'ssh-ed25519 SHA256:abcDEF123')));
  await assert.rejects(probeServer(f.options('changed')), rejectsWith('host-key-changed'));
  await assert.rejects(probeServer(f.options('down')), rejectsWith('unreachable'));
  await assert.rejects(probeServer({ ...f.options('ok'), command: path.join(f.dir, 'no-such-ssh') }), rejectsWith('failed', error => assert.match(error.message, /ENOENT/)));
});

test('only Linux and macOS servers are supported', posixOnly, async t => {
  const f = await fixture(t);
  await rm(path.join(f.bin, 'uname'));
  await writeFile(path.join(f.bin, 'uname'), '#!/bin/sh\necho FreeBSD\n', { mode: 0o755 });
  await assert.rejects(probeServer({ ...f.options('ok'), nodeCandidates: f.candidates }), rejectsWith('unsupported-os', error => assert.match(error.message, /FreeBSD/)));
});

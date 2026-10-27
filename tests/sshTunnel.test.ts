import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SshTunnel, type SshTunnelOptions } from '../src/main/remote/sshTunnel';

// Stands in for ssh: "ok" serves its argv on the -L local port, "auth" fails like a rejected key, "hang" never forwards.
// The tunnel's readiness probe resets its connection on Windows; ignore that socket error like ssh would.
const FAKE_SSH = `
const net = require('node:net');
const args = process.argv.slice(2);
const host = args[args.indexOf('--') + 1];
if (host === 'auth') { process.stderr.write('Warning: something\\nuser@auth: Permission denied (publickey).\\n'); process.exit(255); }
if (host === 'hang') setInterval(() => {}, 1000);
else {
  const port = Number(args[args.indexOf('-L') + 1].split(':')[1]);
  setTimeout(() => net.createServer(socket => socket.on('error', () => {}).end(JSON.stringify(args))).listen(port, '127.0.0.1'), 150);
}
`;

async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fake-ssh-'));
  const script = path.join(dir, 'ssh.cjs');
  await writeFile(script, FAKE_SSH);
  const tunnels: SshTunnel[] = [];
  t.after(async () => { await Promise.all(tunnels.map(tunnel => tunnel.close())); await rm(dir, { recursive: true, force: true }); });
  return (options: Partial<SshTunnelOptions> & { ssh: string }) => {
    const tunnel = new SshTunnel({ command: process.execPath, commandArgs: [script], killGraceMs: 500, ...options });
    tunnels.push(tunnel);
    return tunnel;
  };
}

function fetchArgs(url: string): Promise<string[]> {
  const { port } = new URL(url);
  return new Promise((resolve, reject) => {
    let data = '';
    net.connect({ host: '127.0.0.1', port: Number(port) }).setEncoding('utf8').on('data', chunk => { data += chunk; }).on('end', () => resolve(JSON.parse(data))).on('error', reject);
  });
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitFor(check: () => boolean, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!check()) { if (Date.now() > deadline) throw new Error('timed out'); await new Promise(resolve => setTimeout(resolve, 20)); }
}

test('open forwards a free loopback port with fixed ssh options before the destination', async t => {
  const make = await fixture(t);
  const tunnel = make({ ssh: 'ok', remotePort: 9999, sshArgs: ['-J', 'bastion'] });
  const url = await tunnel.open();
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const port = new URL(url).port;
  assert.deepEqual(await fetchArgs(url), ['-N', '-T', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '-L', `127.0.0.1:${port}:127.0.0.1:9999`, '-J', 'bastion', '--', 'ok']);
});

test('open rejects with the ssh stderr tail when ssh exits first', async t => {
  const make = await fixture(t);
  const tunnel = make({ ssh: 'auth' });
  await assert.rejects(tunnel.open(), /ssh auth exited with code 255: Warning: something \| user@auth: Permission denied \(publickey\)\./);
  assert.equal(tunnel.pid, undefined);
});

test('open rejects and kills ssh after the timeout', async t => {
  const make = await fixture(t);
  const tunnel = make({ ssh: 'hang', timeoutMs: 400 });
  const opening = tunnel.open();
  await new Promise(resolve => setTimeout(resolve, 100));
  const pid = tunnel.pid!;
  await assert.rejects(opening, /did not open the tunnel within/);
  await waitFor(() => !alive(pid));
});

test('concurrent and repeated opens share one ssh process', async t => {
  const make = await fixture(t);
  const tunnel = make({ ssh: 'ok' });
  const [a, b] = await Promise.all([tunnel.open(), tunnel.open()]);
  assert.equal(a, b);
  const pid = tunnel.pid;
  assert.equal(await tunnel.open(), a);
  assert.equal(tunnel.pid, pid);
});

test('open starts a new ssh process after the previous one died', async t => {
  const make = await fixture(t);
  const tunnel = make({ ssh: 'ok' });
  await tunnel.open();
  const pid = tunnel.pid!;
  process.kill(pid, 'SIGKILL');
  await waitFor(() => tunnel.pid === undefined);
  const url = await tunnel.open();
  assert.notEqual(tunnel.pid, pid);
  assert.equal((await fetchArgs(url)).at(-1), 'ok');
});

test('close kills ssh, is repeatable, and allows reopening', async t => {
  const make = await fixture(t);
  const tunnel = make({ ssh: 'ok' });
  await tunnel.open();
  const pid = tunnel.pid!;
  await tunnel.close();
  assert.equal(alive(pid), false);
  await tunnel.close();
  await tunnel.open();
  assert.ok(tunnel.pid);
});

test('close during open aborts the attempt', async t => {
  const make = await fixture(t);
  const tunnel = make({ ssh: 'hang' });
  const opening = tunnel.open();
  await new Promise(resolve => setTimeout(resolve, 100));
  const pid = tunnel.pid!;
  await tunnel.close();
  await assert.rejects(opening);
  assert.equal(alive(pid), false);
});

test('a missing ssh executable rejects without hanging', async () => {
  const tunnel = new SshTunnel({ ssh: 'ok', command: path.join(os.tmpdir(), 'no-such-ssh-binary') });
  await assert.rejects(tunnel.open(), /Cannot run .*ENOENT/);
  await tunnel.close();
});

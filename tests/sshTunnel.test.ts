import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AgentOutdatedError, MANAGED_SSH_OPTIONS, managedRemoteCommand, shellQuote, SshTunnel, type SshTunnelOptions } from '../src/main/remote/sshTunnel';

// Stands in for ssh: "ok" serves its argv on the -L local port, "auth" fails like a rejected key, "hang" never forwards.
// The tunnel's readiness probe resets its connection on Windows; ignore that socket error like ssh would.
// Managed mode (no -N) behaves like real ssh running a command: it records its argv in ssh-args.json, prints a login
// shell banner, and runs the remote command with sh, sharing its stdio.
const FAKE_SSH = `
const net = require('node:net');
const args = process.argv.slice(2);
const host = args[args.indexOf('--') + 1];
if (host === 'auth') { process.stderr.write('Warning: something\\nuser@auth: Permission denied (publickey).\\n'); process.exit(255); }
if (!args.includes('-N')) {
  require('node:fs').writeFileSync(require('node:path').join(__dirname, 'ssh-args.json'), JSON.stringify(args));
  process.stdout.write('Welcome to the fake server!\\n', () => {
    require('node:child_process').spawn('sh', ['-c', args.at(-1)], { stdio: 'inherit' }).on('exit', code => process.exit(code ?? 1));
  });
}
else if (host === 'hang') setInterval(() => {}, 1000);
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

test('shellQuote produces single words for a POSIX shell', { skip: process.platform === 'win32' && 'needs sh' }, () => {
  assert.equal(shellQuote("it's"), String.raw`'it'\''s'`);
  assert.equal(shellQuote(''), "''");
  for (const value of ["it's", "a b\tc", '$(touch /tmp/x) `id` "q" \\ ; | & * ? ~ !', "''", '-n']) {
    assert.equal(execFileSync('sh', ['-c', `printf %s ${shellQuote(value)}`], { encoding: 'utf8' }), value);
  }
});

test('the managed remote command checks the sha before starting the agent, wrapped in sh -c for any login shell', () => {
  const inner = String.raw`cd '/home/u x/.agent-monitor' && [ "$(cat agent.sha256 2>/dev/null)" = 'abc' ] || exit 42; exec '/opt/node 22/bin/node' agent.cjs --stdio`;
  const command = managedRemoteCommand({ home: '/home/u x', nodePath: '/opt/node 22/bin/node', agentSha256: 'abc' });
  assert.equal(command, `sh -c ${shellQuote(inner)}`);
  assert.doesNotMatch(inner, /[\\\n]/);
});

test('the managed remote command means the same to every installed login shell', { skip: process.platform === 'win32' && 'needs sh' }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'am-shells-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'it is', '.agent-monitor');
  await mkdir(dir, { recursive: true });
  const sha = 'c'.repeat(64);
  await writeFile(path.join(dir, 'agent.sha256'), sha);
  const node = path.join(root, 'node');
  await writeFile(node, '#!/bin/sh\nprintf "%s|" "$@"\n', { mode: 0o755 });
  const command = managedRemoteCommand({ home: path.join(root, 'it is'), nodePath: node, agentSha256: sha });
  const shells = ['sh', 'bash', 'zsh', 'fish', 'csh', 'tcsh'].filter(shell => { try { execFileSync('sh', ['-c', `command -v ${shell}`], { stdio: 'ignore' }); return true; } catch { return false; } });
  assert.ok(shells.includes('sh'));
  for (const shell of shells) assert.equal(execFileSync(shell, ['-c', command], { encoding: 'utf8' }), 'agent.cjs|--stdio|', shell);
  await writeFile(path.join(dir, 'agent.sha256'), 'b'.repeat(64));
  for (const shell of shells) assert.throws(() => execFileSync(shell, ['-c', command], { stdio: 'ignore' }), (error: { status?: number }) => error.status === 42, shell);
});

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SHA = 'a'.repeat(64);

/**
 * A server home with an installed agent whose "node" is a wrapper running the real agent from source (agent.cjs is
 * a placeholder) on an empty trace root. The wrapper records its pid, which the agent keeps through exec.
 */
async function managedFixture(t: test.TestContext, sha = SHA) {
  const make = await fixture(t);
  const root = await mkdtemp(path.join(os.tmpdir(), 'am-ssh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home dir'), dir = path.join(home, '.agent-monitor'), traces = path.join(root, 'traces');
  await mkdir(dir, { recursive: true });
  await mkdir(traces);
  await writeFile(path.join(dir, 'agent.cjs'), '');
  await writeFile(path.join(dir, 'agent.sha256'), `${sha}\n`);
  const node = path.join(root, 'node'), pidFile = path.join(root, 'agent.pid');
  await writeFile(node, `#!/bin/sh\nshift\necho $$ > ${shellQuote(pidFile)}\ncd ${shellQuote(REPO)} && AGENT_MONITOR_TRACE_ROOT=${shellQuote(traces)} exec ${shellQuote(process.execPath)} --import tsx src/agent/index.ts "$@"\n`, { mode: 0o755 });
  const managed = { home, nodePath: node, agentSha256: SHA };
  const tunnel = make({ ssh: 'managed', sshArgs: ['-J', 'bastion'], managed, timeoutMs: 15_000 });
  const sshArgs = async () => JSON.parse(await readFile(path.join(path.dirname(tunnel['options'].commandArgs![0]), 'ssh-args.json'), 'utf8')) as string[];
  const agentPid = async () => Number(await readFile(pidFile, 'utf8'));
  return { tunnel, make, managed, dir, sshArgs, agentPid };
}

const posixOnly = { skip: process.platform === 'win32' && 'managed servers are POSIX only' };

test('managed open runs the agent over the ssh session and serves it on a local port', posixOnly, async t => {
  const { tunnel, managed, sshArgs, agentPid } = await managedFixture(t);
  const url = await tunnel.open();
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.deepEqual(await sshArgs(), [...MANAGED_SSH_OPTIONS, '-J', 'bastion', '--', 'managed', managedRemoteCommand(managed)]);
  assert.ok(MANAGED_SSH_OPTIONS.includes('ClearAllForwardings=yes'));
  // An open event stream and other requests share the session.
  const events = await fetch(new URL('/api/events', url));
  const reader = events.body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /^event: snapshot\n/);
  const [version, snapshot] = await Promise.all([fetch(new URL('/api/version', url)), fetch(new URL('/api/snapshot', url))]);
  assert.equal((await version.json()).protocol, 1);
  assert.deepEqual((await snapshot.json()).runs, []);
  await reader.cancel();
  const pid = tunnel.pid!, agent = await agentPid();
  assert.ok(alive(agent));
  await tunnel.close();
  assert.equal(alive(pid), false);
  await waitFor(() => !alive(agent));
  await assert.rejects(fetch(new URL('/api/version', url)));
  // Reopening starts a new session.
  const again = await tunnel.open();
  assert.equal((await (await fetch(new URL('/api/version', again))).json()).protocol, 1);
  assert.notEqual(await agentPid(), agent);
});

test('managed open rejects with AgentOutdatedError when agent.sha256 differs or is missing', posixOnly, async t => {
  const outdated = await managedFixture(t, 'b'.repeat(64));
  await assert.rejects(outdated.tunnel.open(), (error: unknown) => error instanceof AgentOutdatedError && /missing or outdated/.test(error.message));
  assert.equal(outdated.tunnel.pid, undefined);
  const missing = await managedFixture(t);
  await rm(missing.dir, { recursive: true });
  await assert.rejects(missing.tunnel.open(), AgentOutdatedError);
});

test('managed open times out when the agent never reports ready', posixOnly, async t => {
  const { make, managed, dir } = await managedFixture(t);
  await writeFile(path.join(dir, 'agent.cjs'), 'process.stdin.resume();');
  const quick = make({ ssh: 'managed', managed: { ...managed, nodePath: process.execPath }, timeoutMs: 400 });
  await assert.rejects(quick.open(), /did not open the tunnel within/);
  assert.equal(quick.pid, undefined);
});

test('a managed session that dies closes the local port and can be reopened', posixOnly, async t => {
  const { tunnel, agentPid } = await managedFixture(t);
  const url = await tunnel.open();
  process.kill(await agentPid(), 'SIGKILL');
  await waitFor(() => tunnel.pid === undefined);
  await assert.rejects(fetch(new URL('/api/version', url)));
  const again = await tunnel.open();
  assert.equal((await fetch(new URL('/api/version', again))).status, 200);
});

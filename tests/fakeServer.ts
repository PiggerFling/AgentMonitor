import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type test from 'node:test';
import type { SshCommandOptions } from '../src/main/remote/installer';

// Stands in for ssh: special hosts fail like ssh does; any other host runs the remote command through `sh -c` (like the
// remote login shell) with HOME, PATH, SHELL and extra variables from fake.json, after printing a banner to stdout. Calls are logged to calls.jsonl.
const FAKE_SSH = `
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify(args) + '\\n');
const host = args[args.indexOf('--') + 1];
const fail = text => { process.stderr.write(text); process.exit(255); };
if (host === 'auth') fail('Warning: Permanently added x\\nalice@auth: Permission denied (publickey,password).\\n');
if (host === 'hostkey') fail((args.includes('-v') ? 'debug1: Server host key: ssh-ed25519 SHA256:abcDEF123\\n' : '') + 'No ED25519 host key is known for hostkey and you have requested strict checking.\\nHost key verification failed.\\n');
if (host === 'changed') fail('@@@@@@@@\\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\\nHost key verification failed.\\n');
if (host === 'down') fail('ssh: Could not resolve hostname down: Name or service not known\\n');
const { home, bin, shell = '', env = {} } = JSON.parse(fs.readFileSync(path.join(__dirname, 'fake.json'), 'utf8'));
process.stdout.write('Welcome to the fake server!\\nagent-monitor-probe-0000 node=99.0.0 /evil\\n');
require('node:child_process').spawn('/bin/sh', ['-c', args.slice(args.indexOf('--') + 2).join(' ')], { stdio: 'inherit', env: { HOME: home, PATH: bin, SHELL: shell, ...env } })
  .on('exit', code => process.exit(code ?? 1));
`;
const TOOLS = ['sh', 'uname', 'cat', 'mkdir', 'chmod', 'mv', 'rm', 'tail', 'sha256sum', 'shasum', 'openssl', 'mktemp', 'sed', 'sleep', 'env'];

/** A fake ssh plus a temp HOME and minimal PATH standing in for a server (installer and server manager tests). */
export async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fake-install-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home dir'), bin = path.join(dir, 'bin');
  await mkdir(home); await mkdir(bin);
  // A PATH with just the tools the scripts use, so the machine's own node is not found.
  for (const tool of TOOLS) {
    const found = execFileSync('sh', ['-c', `command -v ${tool} || true`], { encoding: 'utf8' }).trim();
    if (found) await symlink(found, path.join(bin, tool));
  }
  await writeFile(path.join(dir, 'ssh.cjs'), FAKE_SSH);
  await writeFile(path.join(dir, 'fake.json'), JSON.stringify({ home, bin }));
  const agent = path.join(dir, 'agent.cjs');
  await writeFile(agent, "console.log('agent');\n");
  const bundle = { path: agent, sha256: createHash('sha256').update("console.log('agent');\n").digest('hex') };
  const options = (ssh: string, extra: Partial<SshCommandOptions> = {}) => ({ ssh, command: process.execPath, commandArgs: [path.join(dir, 'ssh.cjs')], timeoutMs: 20_000, ...extra });
  const calls = async () => (await readFile(path.join(dir, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
  const fakeNode = async (version: string) => {
    const file = path.join(home, '.nvm', 'versions', 'node', `v${version}`, 'bin', 'node');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
    return file;
  };
  /** Makes `script` (a /bin/sh script body) the server's login shell and adds `env` to the session's environment. */
  const loginShell = async (script: string, env: Record<string, string> = {}) => {
    const shell = path.join(dir, 'login-shell');
    await writeFile(shell, `#!/bin/sh\n${script}`, { mode: 0o755 });
    await writeFile(path.join(dir, 'fake.json'), JSON.stringify({ home, bin, shell, env }));
  };
  return { dir, home, bin, bundle, options, calls, fakeNode, loginShell, candidates: ['"$HOME"/.nvm/versions/node/*/bin/node'] };
}


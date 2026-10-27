import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ServerSetupErrorCode, ServerSetupStep } from '../../shared/types';
import type { AgentBundle } from './agentBundle';
import { validRemotePath } from './config';
import { remoteSh, shellQuote } from './sshTunnel';

export interface SshCommandOptions {
  /** Host or ~/.ssh/config alias; validated by config.ts. */
  ssh: string;
  sshArgs?: string[];
  /** Adds `-o StrictHostKeyChecking=accept-new`; only after the user confirmed the host key. */
  acceptNewHostKey?: boolean;
  /** Executable to run instead of `ssh`, with arguments placed before the ssh options (tests). */
  command?: string;
  commandArgs?: string[];
  timeoutMs?: number;
  /** Kills ssh and rejects when aborted. */
  signal?: AbortSignal;
}

/** A setup failure the UI can explain; `code` is the stable part. */
export class ServerSetupError extends Error {
  constructor(readonly code: ServerSetupErrorCode, message: string, readonly extra: { detail?: string; nodeVersion?: string; fingerprint?: string } = {}) {
    super(message);
    this.name = 'ServerSetupError';
  }
}

/** Oldest Node.js the agent runs on (package.json engines). */
export const MIN_NODE_VERSION = '22.12.0';

/** Where the probe looks for node besides PATH and the login shell, as shell words ("$HOME" expands remotely). */
export const NODE_CANDIDATES = [
  '"$HOME"/.nvm/versions/node/*/bin/node', '"$HOME"/.local/share/fnm/node-versions/*/installation/bin/node', '"$HOME"/.volta/bin/node',
  '"$HOME"/.asdf/shims/node', '/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node',
];

interface SshResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }

const OUTPUT_LIMIT = 1 << 20;
const tail = (text: string) => text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(-3).join(' | ');

function runSsh(options: SshCommandOptions, remoteCommand: string, input: string | Buffer = '', extra: string[] = []): Promise<SshResult> {
  const { ssh, sshArgs = [], acceptNewHostKey, command = 'ssh', commandArgs = [], timeoutMs = 60_000, signal } = options;
  if (signal?.aborted) return Promise.reject(new ServerSetupError('failed', 'cancelled'));
  const args = [...commandArgs, ...extra, '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', ...(acceptNewHostKey ? ['-o', 'StrictHostKeyChecking=accept-new'] : []), ...sshArgs, '--', ssh, remoteCommand];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { if (stdout.length < OUTPUT_LIMIT) stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });
    // ssh may exit (e.g. auth failure) before reading all of stdin.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    const abort = () => { child.kill('SIGKILL'); reject(new ServerSetupError('failed', 'cancelled')); };
    signal?.addEventListener('abort', abort, { once: true });
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.once('error', error => { done(); reject(new ServerSetupError('failed', `Cannot run ${command}: ${error.message}`)); });
    child.once('close', code => { done(); resolve({ code, stdout, stderr, timedOut }); });
  });
}

/** Turns an ssh-level failure (exit 255 or timeout) into a ServerSetupError; undefined when ssh itself worked. */
function sshFailure(ssh: string, result: SshResult): ServerSetupError | undefined {
  const detail = tail(result.stderr) || undefined;
  if (result.timedOut) return new ServerSetupError('unreachable', `${ssh} did not answer in time`, { detail });
  if (result.code !== 255) return undefined;
  const text = result.stderr;
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for .* has changed/i.test(text)) return new ServerSetupError('host-key-changed', `The host key of ${ssh} does not match the one in known_hosts`, { detail });
  if (/Host key verification failed|No .*host key is known/i.test(text)) return new ServerSetupError('host-key', `The host key of ${ssh} is not trusted yet`, { detail });
  if (/Permission denied|Too many authentication failures|no supported authentication methods/i.test(text)) {
    return new ServerSetupError('auth', `${ssh} rejected the login; the app cannot prompt, so use a key loaded in ssh-agent or one without a passphrase`, { detail });
  }
  if (/Could not resolve hostname|Connection refused|timed out|No route to host|Network is unreachable|Connection closed|Connection reset|kex_exchange_identification|Name or service not known/i.test(text)) {
    return new ServerSetupError('unreachable', `Cannot reach ${ssh}`, { detail });
  }
  return new ServerSetupError('failed', `ssh ${ssh} failed${detail ? `: ${detail}` : ''}`, { detail });
}

/** Best effort: the server's host key fingerprint from `ssh -v`, for the user to confirm before accept-new. */
async function hostKeyFingerprint(options: SshCommandOptions): Promise<string | undefined> {
  const result = await runSsh({ ...options, acceptNewHostKey: false, timeoutMs: 20_000 }, 'exit', '', ['-v']).catch(() => undefined);
  const match = result && /Server host key: (\S+) (\S+)/.exec(result.stderr);
  return match ? `${match[1]} ${match[2]}` : undefined;
}

async function run(options: SshCommandOptions, remoteCommand: string, input?: string | Buffer): Promise<SshResult> {
  const result = await runSsh(options, remoteCommand, input);
  const failure = sshFailure(options.ssh, result);
  if (failure?.code === 'host-key') failure.extra.fingerprint = await hostKeyFingerprint(options);
  if (failure) throw failure;
  return result;
}

/** Reads `<marker> key=value` lines, ignoring anything else the login shell printed (banners, rc output). */
function markedLines(stdout: string, marker: string): [string, string][] {
  return stdout.split(/\r?\n/).filter(line => line.startsWith(`${marker} `)).map(line => {
    const body = line.slice(marker.length + 1), eq = body.indexOf('=');
    return [body.slice(0, eq), body.slice(eq + 1)] as [string, string];
  });
}

const parseVersion = (text: string) => { const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim()); return match ? match.slice(1, 4).map(Number) : undefined; };
const compare = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** The probe script for `sh -s`. Braces make sh read all of it before running anything that could consume stdin. */
export function probeScript(marker: string, candidates = NODE_CANDIDATES): string {
  return `{
exec </dev/null
m=${shellQuote(marker)}
echo "$m home=$HOME"
echo "$m os=$(uname -s 2>/dev/null)"
echo "$m arch=$(uname -m 2>/dev/null)"
check() { case "$1" in /*) [ -f "$1" ] && [ -x "$1" ] || return 0; v=$("$1" -p 'process.versions.node' 2>/dev/null) || return 0; echo "$m node=$v $1";; esac; }
check "$(command -v node 2>/dev/null)"
case "$SHELL" in /*) [ -x "$SHELL" ] && check "$("$SHELL" -lc 'command -v node' 2>/dev/null | tail -n 1)";; esac
for n in ${candidates.join(' ')}; do check "$n"; done
echo "$m done=1"
}
`;
}

export interface ProbeResult { home: string; os: string; arch: string; nodePath: string; nodeVersion: string }

/**
 * Inspects the server: home directory, OS, and the newest node >= MIN_NODE_VERSION among PATH, the login shell's PATH
 * and the usual version-manager and system locations. `nodeCandidates` replaces the fixed locations (tests).
 */
export async function probeServer(options: SshCommandOptions & { nodeCandidates?: string[] }): Promise<ProbeResult> {
  const marker = `agent-monitor-probe-${randomBytes(8).toString('hex')}`;
  const result = await run(options, 'sh -s', probeScript(marker, options.nodeCandidates));
  const lines = markedLines(result.stdout, marker);
  const value = (key: string) => lines.find(([name]) => name === key)?.[1] ?? '';
  if (!value('done')) throw new ServerSetupError('failed', `Could not inspect ${options.ssh}; is /bin/sh available?`, { detail: tail(result.stderr) || `exit code ${result.code}` });
  const os = value('os'), home = value('home');
  if (os !== 'Linux' && os !== 'Darwin') throw new ServerSetupError('unsupported-os', `${options.ssh} runs ${os || 'an unknown OS'}; only Linux and macOS servers are supported`, { detail: os });
  if (!validRemotePath(home) || home.includes(':')) throw new ServerSetupError('failed', `The home directory of ${options.ssh} (${JSON.stringify(home)}) is not supported: it must be an absolute path without quotes, backslashes, colons or control characters`);
  const found = lines.filter(([name]) => name === 'node').flatMap(([, text]) => {
    const space = text.indexOf(' '), version = parseVersion(text.slice(0, space)), path = text.slice(space + 1);
    return space > 0 && version && validRemotePath(path) ? [{ path, version, text: text.slice(0, space).replace(/^v/, '') }] : [];
  }).sort((a, b) => compare(b.version, a.version));
  const best = found[0];
  if (!best) throw new ServerSetupError('node-missing', `Node.js ${MIN_NODE_VERSION} or newer was not found on ${options.ssh}`);
  if (compare(best.version, parseVersion(MIN_NODE_VERSION)!) < 0) {
    throw new ServerSetupError('node-too-old', `${options.ssh} has Node.js ${best.text} at ${best.path}; the agent needs ${MIN_NODE_VERSION} or newer`, { nodeVersion: best.text });
  }
  return { home, os, arch: value('arch'), nodePath: best.path, nodeVersion: best.text };
}

/**
 * Uploads the bundled agent to `<home>/.agent-monitor` over ssh stdin (no scp/sftp), checks its sha256 on the server
 * and only then writes agent.sha256 (just the hex hash), so a partial upload never looks current.
 */
export async function installAgent(options: SshCommandOptions & { home: string; bundle: AgentBundle }): Promise<void> {
  const content = await readFile(options.bundle.path);
  const marker = `agent-monitor-install-${randomBytes(8).toString('hex')}`;
  const sha = shellQuote(options.bundle.sha256);
  const script = `set -e; umask 077; m=${shellQuote(marker)}; d=${shellQuote(`${options.home}/.agent-monitor`)}; mkdir -p "$d"; chmod 700 "$d"; rm -f "$d/agent.sha256"; `
    + 'cat > "$d/agent.cjs.tmp"; mv -f "$d/agent.cjs.tmp" "$d/agent.cjs"; '
    + 'if command -v sha256sum >/dev/null 2>&1; then s=$(sha256sum < "$d/agent.cjs"); elif command -v shasum >/dev/null 2>&1; then s=$(shasum -a 256 < "$d/agent.cjs"); '
    + 'else s=$(openssl dgst -sha256 < "$d/agent.cjs"); s=${s##* }; fi; s=${s%% *}; echo "$m sha=$s"; '
    + `[ "$s" = ${sha} ]; printf %s ${sha} > "$d/agent.sha256.tmp"; mv -f "$d/agent.sha256.tmp" "$d/agent.sha256"; echo "$m done=1"`;
  const result = await run({ timeoutMs: 120_000, ...options }, remoteSh(script), content);
  const lines = markedLines(result.stdout, marker);
  const remoteSha = lines.find(([name]) => name === 'sha')?.[1];
  if (remoteSha !== undefined && remoteSha !== options.bundle.sha256) throw new ServerSetupError('install-failed', `The agent uploaded to ${options.ssh} is corrupt (sha256 ${remoteSha || 'unavailable'})`, { detail: tail(result.stderr) || undefined });
  if (!lines.some(([name]) => name === 'done')) throw new ServerSetupError('install-failed', `Could not install the agent on ${options.ssh}`, { detail: tail(result.stderr) || `exit code ${result.code}` });
}

/** Deletes `<home>/.agent-monitor` on the server. */
export async function removeAgent(options: SshCommandOptions & { home: string }): Promise<void> {
  const result = await run({ timeoutMs: 30_000, ...options }, remoteSh(`rm -rf ${shellQuote(`${options.home}/.agent-monitor`)}`));
  if (result.code !== 0) throw new ServerSetupError('failed', `Could not remove the agent from ${options.ssh}`, { detail: tail(result.stderr) || `exit code ${result.code}` });
}

export type SetupProgress = (step: Exclude<ServerSetupStep, 'save'>, state: 'running' | 'done' | 'failed') => void;

/** Probes the server and installs the agent, reporting each step. Rejects with ServerSetupError. */
export async function setupServer(options: SshCommandOptions & { bundle: AgentBundle; nodeCandidates?: string[]; onProgress?: SetupProgress }): Promise<ProbeResult> {
  const step = async <T>(id: Exclude<ServerSetupStep, 'save'>, work: () => Promise<T>): Promise<T> => {
    options.onProgress?.(id, 'running');
    try { const value = await work(); options.onProgress?.(id, 'done'); return value; } catch (error) { options.onProgress?.(id, 'failed'); throw error; }
  };
  const probe = await step('probe', () => probeServer(options));
  // Host key is in known_hosts after a successful probe; accept-new is not needed again.
  await step('install', () => installAgent({ ...options, acceptNewHostKey: false, home: probe.home }));
  return probe;
}

import assert from 'node:assert/strict';
import test from 'node:test';
import type { SshHostInfo } from '../src/shared/types';
import {
  customProbeDirs,
  defaultTraceDir,
  filterSshHosts,
  formatSshArgs,
  isAbsoluteDir,
  isGitForgeHost,
  parseSshArgs,
  sameTraceForm,
  traceFormFromOptions,
  traceFormFromProbe,
  traceOptionsFromForm,
} from '../src/renderer/serverForm';

const host = (alias: string, extra: Partial<SshHostInfo> = {}): SshHostInfo => ({ alias, ...extra });

test('git forge hosts are recognised by host name, alias or the git user', () => {
  assert.equal(isGitForgeHost(host('github.com')), true);
  assert.equal(isGitForgeHost(host('gh-work', { hostName: 'github.com' })), true);
  assert.equal(isGitForgeHost(host('gl', { hostName: 'ssh.gitlab.com' })), true);
  assert.equal(isGitForgeHost(host('bb', { hostName: 'BITBUCKET.ORG' })), true);
  assert.equal(isGitForgeHost(host('forge', { hostName: 'git.example.com', user: 'git' })), true);
  assert.equal(isGitForgeHost(host('build', { hostName: 'build.example.com', user: 'deploy' })), false);
  assert.equal(isGitForgeHost(host('notgithub.com.example.org')), false);
  assert.equal(isGitForgeHost(host('mygithub.com')), false);
});

test('host filtering searches alias, host name and user, and hides forge hosts unless asked', () => {
  const hosts = [host('github.com'), host('build', { hostName: '10.0.0.5', user: 'ci' }), host('gpu', { hostName: 'gpu.lab' }), host('gl', { hostName: 'gitlab.com' })];
  const view = filterSshHosts(hosts, '', false);
  assert.deepEqual(view.hosts.map((item) => item.alias), ['build', 'gpu']);
  assert.equal(view.hiddenForgeHosts, 2);
  assert.equal(view.forgeHosts, 2);
  const all = filterSshHosts(hosts, '', true);
  assert.deepEqual(all.hosts.map((item) => item.alias), ['build', 'gpu', 'github.com', 'gl']);
  assert.equal(all.hiddenForgeHosts, 0);
  assert.deepEqual(filterSshHosts(hosts, ' CI ', false).hosts.map((item) => item.alias), ['build']);
  assert.deepEqual(filterSshHosts(hosts, 'lab', false).hosts.map((item) => item.alias), ['gpu']);
  assert.deepEqual(filterSshHosts(hosts, 'git', false), { hosts: [], hiddenForgeHosts: 2, forgeHosts: 2 });
});

test('a forge-looking host that is already added is never hidden', () => {
  const view = filterSshHosts([host('github.com', { serverId: 's1' })], '', false);
  assert.deepEqual(view.hosts.map((item) => item.alias), ['github.com']);
  assert.equal(view.forgeHosts, 0);
});

test('extra ssh arguments split on whitespace and join back', () => {
  assert.deepEqual(parseSshArgs('  -J bastion\t-p  2222 \n'), ['-J', 'bastion', '-p', '2222']);
  assert.deepEqual(parseSshArgs('   '), []);
  assert.equal(formatSshArgs(['-J', 'bastion']), '-J bastion');
  assert.equal(formatSshArgs(undefined), '');
});

test('default data directories follow each tool, with the home directory when known', () => {
  assert.equal(defaultTraceDir('pi'), '~/.pi/agent');
  assert.equal(defaultTraceDir('claude', '/home/me/'), '/home/me/.claude');
  assert.equal(defaultTraceDir('hermes', '/Users/me'), '/Users/me/.hermes');
});

test('forms prefill from saved options and from a probe', () => {
  const all = traceFormFromOptions();
  assert.deepEqual(all.tools, { claude: true, codex: true, pi: true, hermes: true });
  assert.deepEqual(all.dirs, { claude: '', codex: '', pi: '', hermes: '' });
  const saved = traceFormFromOptions({ tools: ['codex'], traceDirs: { codex: '/data/codex' } });
  assert.deepEqual(saved.tools, { claude: false, codex: true, pi: false, hermes: false });
  assert.equal(saved.dirs.codex, '/data/codex');
  // The probe reports every tool; only directories that differ from the default under the home directory are prefilled.
  const detected = { claude: '/home/me/.claude', codex: '/srv/codex', pi: '/home/me/.pi/agent/', hermes: '/home/me/.hermes' };
  assert.deepEqual(customProbeDirs(detected, '/home/me'), { codex: '/srv/codex' });
  const probed = traceFormFromProbe(detected, ['claude', 'codex'], '/home/me');
  assert.deepEqual(probed.tools, { claude: true, codex: true, pi: false, hermes: false });
  assert.deepEqual(probed.dirs, { claude: '', codex: '/srv/codex', pi: '', hermes: '' });
  assert.deepEqual(traceFormFromProbe({}, [], '/home/me').tools, all.tools, 'nothing found yet: every tool stays on');
  assert.equal(sameTraceForm(all, { ...all, dirs: { ...all.dirs, pi: '  ' } }), true);
  assert.equal(sameTraceForm(all, saved), false);
});

test('form validation requires a tool and absolute directories, and omits defaults', () => {
  const all = traceFormFromOptions();
  assert.deepEqual(traceOptionsFromForm(all), { ok: true, options: { traceDirs: {} } });
  const some = { tools: { ...all.tools, pi: false, hermes: false }, dirs: { ...all.dirs, codex: '  /data/codex ', pi: '/x' } };
  assert.deepEqual(traceOptionsFromForm(some), { ok: true, options: { tools: ['claude', 'codex'], traceDirs: { codex: '/data/codex', pi: '/x' } } });
  assert.deepEqual(traceOptionsFromForm({ tools: { claude: false, codex: false, pi: false, hermes: false }, dirs: { ...all.dirs, codex: '~/codex' } }), { ok: false, errors: { tools: 'noTools', codex: 'notAbsolute' } });
  assert.equal(isAbsoluteDir('C:\\Users\\me\\.codex'), true);
  assert.equal(isAbsoluteDir('relative/dir'), false);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentRun, RemoteHostStatus } from '../src/shared/types';
import {
  assessMonitorHealth,
  groupRunsBySource,
  LOCAL_GROUP_ID,
  readCollapsedGroups,
  remoteIndicatorState,
  remoteStatusTitle,
  saveCollapsedGroups,
  toggleGroup,
} from '../src/renderer/remoteUi';

const remote = (id: string, label: string, state: RemoteHostStatus['state'] = 'connected', error?: string): RemoteHostStatus => ({ id, label, state, ...(error ? { error } : {}) });
const run = (id: string, host?: string): AgentRun => ({ id, harness: 'codex', ...(host ? { host } : {}) });

const runs = [run('local-1'), run('remote:a::r1', 'alpha'), run('remote:b::r2', 'beta'), run('local-2')];

test('without remotes all runs form the local group', () => {
  const groups = groupRunsBySource([run('1'), run('2')]);
  assert.deepEqual(groups.map((group) => [group.id, group.kind, group.runs.map((item) => item.id)]), [[LOCAL_GROUP_ID, 'local', ['1', '2']]]);
  assert.deepEqual(groupRunsBySource([]).map((group) => group.runs.length), [0]);
});

test('runs are grouped local first, then one group per remote in config order, keeping run order', () => {
  const groups = groupRunsBySource(runs, [remote('b', 'beta'), remote('a', 'alpha', 'error', 'down')]);
  assert.deepEqual(groups.map((group) => group.id), ['local', 'remote:b', 'remote:a']);
  assert.deepEqual(groups.map((group) => group.runs.map((item) => item.id)), [['local-1', 'local-2'], ['remote:b::r2'], ['remote:a::r1']]);
  assert.equal(groups[2].remote?.error, 'down');
  assert.equal(groups[1].label, 'beta');
});

test('a remote without runs still gets a group, and runs of an unknown host get their own', () => {
  const groups = groupRunsBySource([run('x', 'gamma'), run('y', 'gamma')], [remote('a', 'alpha', 'connecting')]);
  assert.deepEqual(groups.map((group) => [group.id, group.runs.length, Boolean(group.remote)]), [['local', 0, false], ['remote:a', 0, true], ['host:gamma', 2, false]]);
});

test('a remote labelled "local" does not merge with the local group', () => {
  const groups = groupRunsBySource([run('1'), run('2', 'local')], [remote('l', 'local')]);
  assert.deepEqual(groups.map((group) => [group.id, group.runs.map((item) => item.id)]), [['local', ['1']], ['remote:l', ['2']]]);
});

test('collapsed groups toggle and survive a round trip through storage', () => {
  const store = new Map<string, string>();
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } };
  assert.deepEqual([...readCollapsedGroups(storage)], []);
  const collapsed = toggleGroup(toggleGroup(new Set(), 'remote:a'), 'local');
  saveCollapsedGroups(collapsed, storage);
  assert.deepEqual([...readCollapsedGroups(storage)].sort(), ['local', 'remote:a']);
  assert.deepEqual([...toggleGroup(collapsed, 'local')], ['remote:a']);
  store.set([...store.keys()][0], '{not json');
  assert.deepEqual([...readCollapsedGroups(storage)], []);
});

test('without remotes every error is a local error, as before', () => {
  const health = assessMonitorHealth({ errors: ['boom'], watching: true });
  assert.deepEqual(health.localErrors, ['boom']);
  assert.deepEqual(health.visibleErrors, ['boom']);
  assert.equal(health.warning, true);
  assert.equal(assessMonitorHealth({ errors: [], watching: true }).warning, false);
});

test('a remote that is down does not raise a global warning while another source is healthy', () => {
  const remotes = [remote('a', 'alpha', 'error', 'ssh: connection refused'), remote('b', 'beta')];
  const health = assessMonitorHealth({ errors: ['[alpha] ssh: connection refused'], remotes, watching: true });
  assert.equal(health.warning, false);
  assert.deepEqual(health.visibleErrors, []);
  assert.deepEqual(health.remoteErrors, { a: ['[alpha] ssh: connection refused'], b: [] });
  assert.equal(health.connectedRemotes, 1);

  const localOnly = assessMonitorHealth({ errors: [], remotes: [remote('a', 'alpha', 'error', 'down')], watching: true });
  assert.equal(localOnly.warning, false);
});

test('remote errors escalate only when no source is healthy', () => {
  const remotes = [remote('a', 'alpha', 'error', 'down'), remote('b', 'beta', 'error')];
  const health = assessMonitorHealth({ errors: ['[alpha] down'], remotes, watching: false });
  assert.equal(health.warning, true);
  assert.deepEqual(health.visibleErrors, ['[alpha] down', '[beta] connection error']);
});

test('local errors still warn when remotes are healthy', () => {
  const health = assessMonitorHealth({ errors: ['local failure', '[alpha] trace unreadable'], remotes: [remote('a', 'alpha')], watching: true });
  assert.equal(health.warning, true);
  assert.deepEqual(health.visibleErrors, ['local failure']);
  assert.deepEqual(health.remoteErrors.a, ['[alpha] trace unreadable']);
});

test('remote indicator state and tooltip describe the connection', () => {
  assert.equal(remoteIndicatorState(remote('a', 'alpha'), []), 'connected');
  assert.equal(remoteIndicatorState(remote('a', 'alpha'), ['[alpha] x']), 'warning');
  assert.equal(remoteIndicatorState(remote('a', 'alpha', 'connecting'), []), 'connecting');
  assert.equal(remoteIndicatorState(remote('a', 'alpha', 'error'), []), 'error');
  assert.equal(remoteStatusTitle(remote('a', 'alpha'), []), 'alpha: connected');
  assert.equal(remoteStatusTitle(remote('a', 'alpha', 'connecting'), []), 'alpha: connecting…');
  assert.equal(remoteStatusTitle(remote('a', 'alpha', 'error', 'ssh: timeout'), ['[alpha] ssh: timeout']), 'alpha: ssh: timeout');
  assert.equal(remoteStatusTitle(remote('a', 'alpha', 'error'), ['[alpha] tunnel closed']), 'alpha: tunnel closed');
  assert.equal(remoteStatusTitle(remote('a', 'alpha', 'error'), []), 'alpha: connection error');
});

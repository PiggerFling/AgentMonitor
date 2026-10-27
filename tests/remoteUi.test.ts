import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentRun, RemoteHostStatus } from '../src/shared/types';
import {
  assessMonitorHealth,
  buildHostOptions,
  filterAgentsByHost,
  filterRunsByHost,
  HOST_ALL,
  HOST_LOCAL,
  remoteHostFilter,
  remoteIndicatorState,
  remoteStatusTitle,
  resolveHostFilter,
  runHostLabel,
} from '../src/renderer/remoteUi';

const remote = (id: string, label: string, state: RemoteHostStatus['state'] = 'connected', error?: string): RemoteHostStatus => ({ id, label, state, ...(error ? { error } : {}) });
const run = (id: string, host?: string): AgentRun => ({ id, harness: 'codex', ...(host ? { host } : {}) });

const runs = [run('local-1'), run('remote:a::r1', 'alpha'), run('remote:b::r2', 'beta'), run('local-2')];

test('host options are empty without remotes and list all, local, then each remote label', () => {
  assert.deepEqual(buildHostOptions(undefined), []);
  assert.deepEqual(buildHostOptions([]), []);
  assert.deepEqual(buildHostOptions([remote('a', 'alpha'), remote('b', 'beta')]).map((option) => option.label), ['All hosts', 'Local', 'alpha', 'beta']);
});

test('remote labels cannot collide with the built-in host options', () => {
  const options = buildHostOptions([remote('x', 'all'), remote('y', 'local')]);
  assert.equal(new Set(options.map((option) => option.value)).size, 4);
  assert.deepEqual(filterRunsByHost([run('1'), run('2', 'local')], remoteHostFilter('local')).map((item) => item.id), ['2']);
  assert.deepEqual(filterRunsByHost([run('1'), run('2', 'local')], HOST_LOCAL).map((item) => item.id), ['1']);
});

test('a filter for a host that is no longer configured falls back to all hosts', () => {
  const remotes = [remote('a', 'alpha')];
  assert.equal(resolveHostFilter(remoteHostFilter('alpha'), remotes), remoteHostFilter('alpha'));
  assert.equal(resolveHostFilter(remoteHostFilter('beta'), remotes), HOST_ALL);
  assert.equal(resolveHostFilter(HOST_LOCAL, remotes), HOST_LOCAL);
  assert.equal(resolveHostFilter(HOST_LOCAL, []), HOST_ALL);
});

test('runs and their agents are filtered by host', () => {
  assert.equal(filterRunsByHost(runs, HOST_ALL).length, 4);
  assert.deepEqual(filterRunsByHost(runs, HOST_LOCAL).map((item) => item.id), ['local-1', 'local-2']);
  assert.deepEqual(filterRunsByHost(runs, remoteHostFilter('beta')).map((item) => item.id), ['remote:b::r2']);
  const agents = [{ id: 'a1', runId: 'local-1' }, { id: 'a2', runId: 'remote:a::r1' }, { id: 'a3', runId: 'unknown-run' }];
  assert.deepEqual(filterAgentsByHost(agents, runs, HOST_ALL).map((agent) => agent.id), ['a1', 'a2', 'a3']);
  assert.deepEqual(filterAgentsByHost(agents, runs, HOST_LOCAL).map((agent) => agent.id), ['a1']);
  assert.deepEqual(filterAgentsByHost(agents, runs, remoteHostFilter('alpha')).map((agent) => agent.id), ['a2']);
});

test('host labels only appear once remotes are configured', () => {
  assert.equal(runHostLabel(run('1'), false), undefined);
  assert.equal(runHostLabel(run('1'), true), 'local');
  assert.equal(runHostLabel(run('2', 'alpha'), true), 'alpha');
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

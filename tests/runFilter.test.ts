import assert from 'node:assert/strict';
import test from 'node:test';
import type { Agent, AgentRun } from '../src/shared/types';
import { activeRunIds, filterRunsByTime, readRunTimeRange, saveRunTimeRange } from '../src/renderer/runFilter';

const HOUR = 60 * 60 * 1000;
const now = 1_000 * 24 * HOUR;
const run = (id: string, hoursAgo: number | undefined, startedHoursAgo?: number): AgentRun => ({
  id,
  harness: 'codex',
  ...(hoursAgo === undefined ? {} : { lastActivityAt: now - hoursAgo * HOUR }),
  ...(startedHoursAgo === undefined ? {} : { startedAt: now - startedHoursAgo * HOUR }),
});
const runs = [run('fresh', 2), run('yesterday', 23), run('old', 30), run('week', 24 * 6), run('month', 24 * 29), run('ancient', 24 * 90), run('started', undefined, 5), run('unknown', undefined)];
const ids = (list: AgentRun[]) => list.map((item) => item.id);

test('filters runs by last activity, falling back to the start time', () => {
  assert.deepEqual(ids(filterRunsByTime(runs, 'day', { now })), ['fresh', 'yesterday', 'started']);
  assert.deepEqual(ids(filterRunsByTime(runs, 'week', { now })), ['fresh', 'yesterday', 'old', 'week', 'started']);
  assert.deepEqual(ids(filterRunsByTime(runs, 'month', { now })), ['fresh', 'yesterday', 'old', 'week', 'month', 'started']);
  assert.deepEqual(ids(filterRunsByTime(runs, 'all', { now })), ids(runs));
});

test('active runs and the selected run stay visible whatever their age', () => {
  const active = activeRunIds([
    { runId: 'ancient', status: 'active' },
    { runId: 'month', status: 'finished' },
    { runId: 'old', status: 'starting' },
  ] as Pick<Agent, 'runId' | 'status'>[]);
  assert.deepEqual([...active].sort(), ['ancient', 'old']);
  assert.deepEqual(ids(filterRunsByTime(runs, 'day', { now, activeRunIds: active, selectedRunId: 'unknown' })), ['fresh', 'yesterday', 'old', 'ancient', 'started', 'unknown']);
});

test('the time range is remembered and defaults to one day', () => {
  const store = new Map<string, string>();
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } };
  assert.equal(readRunTimeRange(storage), 'day');
  saveRunTimeRange('month', storage);
  assert.equal(readRunTimeRange(storage), 'month');
  store.set([...store.keys()][0], 'forever');
  assert.equal(readRunTimeRange(storage), 'day');
  assert.equal(readRunTimeRange({ getItem: () => { throw new Error('denied'); } }), 'day');
});

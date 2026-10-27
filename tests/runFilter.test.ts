import assert from 'node:assert/strict';
import test from 'node:test';
import type { Agent, AgentRun } from '../src/shared/types';
import { activeRunIds, filterRunsByRange, rangeBounds, rangeFollowsNow, readRunRange, saveRunRange, startOfDay, type RunRange } from '../src/renderer/runFilter';

const HOUR = 60 * 60 * 1000;
// 2026-10-28 15:00 local time.
const now = new Date(2026, 9, 28, 15).getTime();
const run = (id: string, lastHoursAgo: number | undefined, startedHoursAgo?: number): AgentRun => ({
  id,
  harness: 'codex',
  ...(lastHoursAgo === undefined ? {} : { lastActivityAt: now - lastHoursAgo * HOUR }),
  ...(startedHoursAgo === undefined ? {} : { startedAt: now - startedHoursAgo * HOUR }),
});
const runs = [
  run('fresh', 2, 3),
  run('morning', 10, 11), // 05:00 today
  run('yesterday', 20, 22),
  run('old', 30, 31),
  run('long', 1, 24 * 40), // started 40 days ago, still active an hour ago
  run('ancient', 24 * 90),
  run('started', undefined, 5),
  run('unknown', undefined),
];
const ids = (list: AgentRun[]) => list.map((item) => item.id);

test('presets filter by overlap with the rolling window', () => {
  assert.deepEqual(ids(filterRunsByRange(runs, { kind: 'today' }, { now })), ['fresh', 'morning', 'long', 'started']);
  assert.deepEqual(ids(filterRunsByRange(runs, { kind: 'day' }, { now })), ['fresh', 'morning', 'yesterday', 'long', 'started']);
  assert.deepEqual(ids(filterRunsByRange(runs, { kind: 'all' }, { now })), ids(runs));
  assert.deepEqual(rangeBounds({ kind: 'today' }, now), { start: new Date(2026, 9, 28).getTime(), end: now });
  assert.equal(rangeBounds({ kind: 'all' }, now), undefined);
});

test('custom ranges match runs whose activity interval overlaps them', () => {
  // 35 to 25 hours ago: only 'old' (31-30h ago) and 'long' (spans it) overlap; 'yesterday' starts 22h ago.
  const fixed: RunRange = { kind: 'custom', start: now - 35 * HOUR, end: now - 25 * HOUR };
  assert.deepEqual(ids(filterRunsByRange(runs, fixed, { now })), ['old', 'long']);
  const rolling: RunRange = { kind: 'custom', start: now - 4 * HOUR, end: 'now' };
  assert.deepEqual(ids(filterRunsByRange(runs, rolling, { now })), ['fresh', 'long']); // 'started' only has a start time, 5h ago.
  assert.equal(rangeFollowsNow(rolling), true);
  assert.equal(rangeFollowsNow(fixed), false);
  assert.equal(rangeFollowsNow({ kind: 'day' }), true);
});

test('active runs stay while the range follows now; the selected run always stays', () => {
  const active = activeRunIds([
    { runId: 'ancient', status: 'active' },
    { runId: 'old', status: 'finished' },
    { runId: 'yesterday', status: 'starting' },
  ] as Pick<Agent, 'runId' | 'status'>[]);
  assert.deepEqual([...active].sort(), ['ancient', 'yesterday']);
  assert.deepEqual(ids(filterRunsByRange(runs, { kind: 'today' }, { now, activeRunIds: active, selectedRunId: 'unknown' })), ['fresh', 'morning', 'yesterday', 'long', 'ancient', 'started', 'unknown']);
  const fixed: RunRange = { kind: 'custom', start: now - 35 * HOUR, end: now - 25 * HOUR };
  assert.deepEqual(ids(filterRunsByRange(runs, fixed, { now, activeRunIds: active, selectedRunId: 'fresh' })), ['fresh', 'old', 'long']);
});

test('only presets are remembered, old stored values migrate, the default is the last 24 hours', () => {
  const store = new Map<string, string>();
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } };
  assert.deepEqual(readRunRange(storage), { kind: 'day' });
  saveRunRange({ kind: 'today' }, storage);
  assert.deepEqual(readRunRange(storage), { kind: 'today' });
  saveRunRange({ kind: 'custom', start: 0, end: 'now' }, storage);
  assert.deepEqual(readRunRange(storage), { kind: 'today' });
  const key = [...store.keys()][0];
  for (const [stored, kind] of [['1d', 'day'], ['7d', 'day'], ['30d', 'day'], ['week', 'day'], ['month', 'day'], ['all', 'all'], ['forever', 'day'], ['constructor', 'day']]) {
    store.set(key, stored);
    assert.deepEqual(readRunRange(storage), { kind }, stored);
  }
  assert.deepEqual(readRunRange({ getItem: () => { throw new Error('denied'); } }), { kind: 'day' });
  assert.equal(startOfDay(now), new Date(2026, 9, 28).getTime());
});

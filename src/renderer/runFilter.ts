import type { Agent, AgentRun } from '../shared/types';

/**
 * The period the sidebar lists runs for. `today` starts at local midnight, `day` is the last 24 hours,
 * and a custom range either ends at a fixed time or follows the current time (`'now'`).
 */
export type RunRange =
  | { kind: 'today' }
  | { kind: 'day' }
  | { kind: 'all' }
  | { kind: 'custom'; start: number; end: number | 'now' };

export type RunRangePreset = Exclude<RunRange['kind'], 'custom'>;

export const RUN_RANGE_PRESETS: readonly RunRangePreset[] = ['today', 'day', 'all'];
export const DEFAULT_RUN_RANGE: RunRange = { kind: 'day' };

const DAY = 24 * 60 * 60 * 1000;
const STORAGE_KEY = 'agent-monitor.sidebar.timeRange';

/** Ids of runs with at least one agent that is working right now (active or starting). */
export function activeRunIds(agents: readonly Pick<Agent, 'runId' | 'status'>[]): Set<string> {
  return new Set(agents.filter((agent) => agent.status === 'active' || agent.status === 'starting').map((agent) => agent.runId));
}

/** Local midnight of the day containing `time`. */
export function startOfDay(time: number): number {
  const date = new Date(time);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Whether the range moves with the clock (every preset, and custom ranges ending "now"). */
export function rangeFollowsNow(range: RunRange): boolean {
  return range.kind !== 'custom' || range.end === 'now';
}

/** Inclusive `[start, end]` bounds of the range at `now`, or `undefined` for "all". */
export function rangeBounds(range: RunRange, now: number): { start: number; end: number } | undefined {
  switch (range.kind) {
    case 'all': return undefined;
    case 'today': return { start: startOfDay(now), end: now };
    case 'day': return { start: now - DAY, end: now };
    case 'custom': return { start: range.start, end: range.end === 'now' ? now : range.end };
  }
}

/**
 * Keeps the runs whose activity interval (start to last activity) overlaps the range. The selected run
 * always stays; runs with a working agent also stay while the range follows the current time. Order is kept.
 */
export function filterRunsByRange<T extends Pick<AgentRun, 'id' | 'lastActivityAt' | 'startedAt'>>(
  runs: readonly T[],
  range: RunRange,
  { now, activeRunIds: active = new Set(), selectedRunId }: { now: number; activeRunIds?: ReadonlySet<string>; selectedRunId?: string },
): T[] {
  const bounds = rangeBounds(range, now);
  if (!bounds) return [...runs];
  const keepActive = rangeFollowsNow(range);
  return runs.filter((run) => {
    if (run.id === selectedRunId || (keepActive && active.has(run.id))) return true;
    const first = run.startedAt ?? run.lastActivityAt;
    const last = run.lastActivityAt ?? run.startedAt;
    if (first === undefined || last === undefined) return false;
    return Math.min(first, last) <= bounds.end && Math.max(first, last) >= bounds.start;
  });
}

/** Stored values from earlier versions ('1d' / '7d' / '30d' and 'week' / 'month') map to the 24-hour preset. */
const STORED_PRESETS: Record<string, RunRangePreset> = { today: 'today', day: 'day', all: 'all', '1d': 'day', '7d': 'day', '30d': 'day', week: 'day', month: 'day' };

/** The remembered preset; custom ranges are never stored, so a restart returns to a preset. */
export function readRunRange(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): RunRange {
  try {
    const stored = storage?.getItem(STORAGE_KEY);
    const kind = stored && Object.hasOwn(STORED_PRESETS, stored) ? STORED_PRESETS[stored] : undefined;
    return kind ? { kind } : DEFAULT_RUN_RANGE;
  } catch {
    return DEFAULT_RUN_RANGE;
  }
}

/** Remembers a preset; custom ranges are only kept for the session. */
export function saveRunRange(range: RunRange, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  if (range.kind === 'custom') return;
  try { storage?.setItem(STORAGE_KEY, range.kind); } catch { /* Still usable without storage. */ }
}

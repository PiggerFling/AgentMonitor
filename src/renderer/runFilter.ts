import type { Agent, AgentRun } from '../shared/types';

/** How far back the sidebar lists runs, by last activity. */
export type RunTimeRange = 'day' | 'week' | 'month' | 'all';

export const RUN_TIME_RANGES: readonly RunTimeRange[] = ['day', 'week', 'month', 'all'];

const DAY = 24 * 60 * 60 * 1000;
const RANGE_MS: Record<RunTimeRange, number> = { day: DAY, week: 7 * DAY, month: 30 * DAY, all: Infinity };
const STORAGE_KEY = 'agent-monitor.sidebar.timeRange';

/** Ids of runs with at least one agent that is working right now (active or starting). */
export function activeRunIds(agents: readonly Pick<Agent, 'runId' | 'status'>[]): Set<string> {
  return new Set(agents.filter((agent) => agent.status === 'active' || agent.status === 'starting').map((agent) => agent.runId));
}

/**
 * Keeps the runs whose last activity (or start, when no activity is recorded) falls within the range.
 * Runs that are active right now and the selected run always stay, whatever their age. Order is kept.
 */
export function filterRunsByTime<T extends Pick<AgentRun, 'id' | 'lastActivityAt' | 'startedAt'>>(
  runs: readonly T[],
  range: RunTimeRange,
  { now, activeRunIds: active = new Set(), selectedRunId }: { now: number; activeRunIds?: ReadonlySet<string>; selectedRunId?: string },
): T[] {
  if (range === 'all') return [...runs];
  const since = now - RANGE_MS[range];
  return runs.filter((run) => run.id === selectedRunId || active.has(run.id) || (run.lastActivityAt ?? run.startedAt ?? 0) >= since);
}

function isRunTimeRange(value: unknown): value is RunTimeRange {
  return RUN_TIME_RANGES.includes(value as RunTimeRange);
}

export function readRunTimeRange(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): RunTimeRange {
  try {
    const stored = storage?.getItem(STORAGE_KEY);
    return isRunTimeRange(stored) ? stored : 'day';
  } catch {
    return 'day';
  }
}

export function saveRunTimeRange(range: RunTimeRange, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  try { storage?.setItem(STORAGE_KEY, range); } catch { /* Still usable without storage. */ }
}

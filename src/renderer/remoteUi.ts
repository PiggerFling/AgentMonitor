import { t } from './i18n';
import type { AgentRun, RemoteHostStatus } from '../shared/types';

/** A sidebar group of runs: this machine's own runs, or the runs of one remote server. */
export interface RunGroup<T> {
  /** Stable id used to remember the collapsed state: `local`, `remote:<server id>` or `host:<label>`. */
  id: string;
  kind: 'local' | 'remote';
  /** Server label; empty for the local group. */
  label: string;
  /** Connection state, when the group belongs to a server the monitor reports on. */
  remote?: RemoteHostStatus;
  runs: T[];
}

export const LOCAL_GROUP_ID = 'local';

/**
 * Groups runs by where they come from: the local group first, then one group per configured remote (in
 * config order, also while it has no runs), then any host that runs name but no remote reports.
 * Runs keep their order within a group.
 */
export function groupRunsBySource<T extends Pick<AgentRun, 'host'>>(runs: readonly T[], remotes: readonly RemoteHostStatus[] = []): RunGroup<T>[] {
  const local: RunGroup<T> = { id: LOCAL_GROUP_ID, kind: 'local', label: '', runs: [] };
  const groups = [local];
  const byLabel = new Map<string, RunGroup<T>>();
  for (const remote of remotes) {
    if (byLabel.has(remote.label)) continue;
    const group: RunGroup<T> = { id: `remote:${remote.id}`, kind: 'remote', label: remote.label, remote, runs: [] };
    byLabel.set(remote.label, group);
    groups.push(group);
  }
  for (const run of runs) {
    if (!run.host) { local.runs.push(run); continue; }
    let group = byLabel.get(run.host);
    if (!group) {
      group = { id: `host:${run.host}`, kind: 'remote', label: run.host, runs: [] };
      byLabel.set(run.host, group);
      groups.push(group);
    }
    group.runs.push(run);
  }
  return groups;
}

const COLLAPSED_KEY = 'agent-monitor.sidebar.collapsedGroups';

export function readCollapsedGroups(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): Set<string> {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(COLLAPSED_KEY) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []);
  } catch {
    return new Set();
  }
}

export function saveCollapsedGroups(groups: ReadonlySet<string>, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  try { storage?.setItem(COLLAPSED_KEY, JSON.stringify([...groups])); } catch { /* Still usable without storage. */ }
}

export function toggleGroup(groups: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(groups);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}

export interface MonitorHealth {
  /** Errors from the local monitor (no remote label prefix). */
  localErrors: string[];
  /** Errors reported for each remote, keyed by remote id. */
  remoteErrors: Record<string, string[]>;
  /** Errors to surface in the global error strip and issue counters. */
  visibleErrors: string[];
  /** Whether the global live badge should show its warning state. */
  warning: boolean;
  connectedRemotes: number;
  totalRemotes: number;
}

/**
 * Splits monitor errors into local and per-remote buckets. A remote being down is reported on its
 * own status chip, not as a global warning: the global badge only warns for local monitor errors,
 * or for remote errors when no source at all (local watcher or any remote) is healthy.
 */
export function assessMonitorHealth({ errors, remotes, watching }: { errors: readonly string[]; remotes?: readonly RemoteHostStatus[]; watching: boolean }): MonitorHealth {
  const list = remotes ?? [];
  const remoteErrors: Record<string, string[]> = Object.fromEntries(list.map((remote) => [remote.id, []]));
  const localErrors: string[] = [];
  const remoteErrorList: string[] = [];
  for (const error of errors) {
    const remote = list.find((candidate) => error.startsWith(`[${candidate.label}] `));
    if (remote) {
      remoteErrors[remote.id].push(error);
      remoteErrorList.push(error);
    } else localErrors.push(error);
  }
  const connectedRemotes = list.filter((remote) => remote.state === 'connected').length;
  const localHealthy = watching && localErrors.length === 0;
  const anyHealthy = localHealthy || connectedRemotes > 0;
  const remoteTrouble = remoteErrorList.length > 0 || list.some((remote) => remote.state === 'error');
  const escalate = !anyHealthy && remoteTrouble;
  return {
    localErrors,
    remoteErrors,
    visibleErrors: escalate
      ? [
        ...localErrors,
        ...remoteErrorList,
        ...list.filter((remote) => remote.state === 'error' && !remoteErrors[remote.id].length)
          .map((remote) => `[${remote.label}] ${remote.error ?? t('remote.connectionError')}`),
      ]
      : localErrors,
    warning: localErrors.length > 0 || escalate,
    connectedRemotes,
    totalRemotes: list.length,
  };
}

export type RemoteIndicatorState = 'connected' | 'connecting' | 'warning' | 'error';

/** Chip state: a connected remote that still reports errors (e.g. unreadable traces) shows as a warning. */
export function remoteIndicatorState(remote: RemoteHostStatus, errors: readonly string[]): RemoteIndicatorState {
  if (remote.state === 'error') return 'error';
  if (remote.state === 'connecting') return 'connecting';
  return errors.length ? 'warning' : 'connected';
}

/** Tooltip text for a remote status chip. */
export function remoteStatusTitle(remote: RemoteHostStatus, errors: readonly string[]): string {
  const stripped = errors.map((error) => error.slice(remote.label.length + 3));
  const detail = remote.error ?? stripped[0];
  const extra = stripped.filter((error) => error !== detail);
  const lines: string[] = [];
  if (remote.state === 'connected') lines.push(t('remote.connected', { label: remote.label }));
  else if (remote.state === 'connecting') lines.push(t('remote.connecting', { label: remote.label }));
  else lines.push(`${remote.label}: ${detail ?? t('remote.connectionError')}`);
  if (remote.state !== 'error' && detail) lines.push(detail);
  lines.push(...extra);
  return lines.join('\n');
}

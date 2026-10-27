import type { Agent, AgentRun, RemoteHostStatus } from '../shared/types';

/**
 * Host filter values. Remote hosts are keyed by label (that is what `AgentRun.host` carries) and
 * prefixed so a server labelled "all" or "local" cannot collide with the built-in options.
 */
export type HostFilter = string;
export const HOST_ALL: HostFilter = 'all';
export const HOST_LOCAL: HostFilter = 'local';
const REMOTE_PREFIX = 'host:';

export function remoteHostFilter(label: string): HostFilter {
  return `${REMOTE_PREFIX}${label}`;
}

export interface HostOption { value: HostFilter; label: string }

/** Options for the Host dropdown; empty when no remotes are configured (the dropdown is then hidden). */
export function buildHostOptions(remotes: readonly RemoteHostStatus[] | undefined): HostOption[] {
  if (!remotes?.length) return [];
  const seen = new Set<string>();
  const options: HostOption[] = [{ value: HOST_ALL, label: 'All hosts' }, { value: HOST_LOCAL, label: 'Local' }];
  for (const remote of remotes) {
    if (seen.has(remote.label)) continue;
    seen.add(remote.label);
    options.push({ value: remoteHostFilter(remote.label), label: remote.label });
  }
  return options;
}

/** The filter actually applied: falls back to all hosts when the chosen host is no longer configured. */
export function resolveHostFilter(filter: HostFilter, remotes: readonly RemoteHostStatus[] | undefined): HostFilter {
  return buildHostOptions(remotes).some((option) => option.value === filter) ? filter : HOST_ALL;
}

export function runMatchesHost(run: Pick<AgentRun, 'host'>, filter: HostFilter): boolean {
  if (filter === HOST_ALL) return true;
  if (filter === HOST_LOCAL) return !run.host;
  return run.host !== undefined && remoteHostFilter(run.host) === filter;
}

export function filterRunsByHost<T extends Pick<AgentRun, 'host'>>(runs: readonly T[], filter: HostFilter): T[] {
  return filter === HOST_ALL ? [...runs] : runs.filter((run) => runMatchesHost(run, filter));
}

/**
 * Agents carry no host of their own, so they follow the run they belong to. Agents whose run is not
 * in `runs` can't be attributed to a host and are only kept when every host is shown.
 */
export function filterAgentsByHost<T extends Pick<Agent, 'runId'>>(agents: readonly T[], runs: readonly AgentRun[], filter: HostFilter): T[] {
  if (filter === HOST_ALL) return [...agents];
  const matchingRunIds = new Set(runs.filter((run) => runMatchesHost(run, filter)).map((run) => run.id));
  return agents.filter((agent) => matchingRunIds.has(agent.runId));
}

/** Host tag text for a run: nothing when only the local machine is monitored, otherwise the host or "local". */
export function runHostLabel(run: Pick<AgentRun, 'host'>, remotesConfigured: boolean): string | undefined {
  if (run.host) return run.host;
  return remotesConfigured ? 'local' : undefined;
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
          .map((remote) => `[${remote.label}] ${remote.error ?? 'connection error'}`),
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
  if (remote.state === 'connected') lines.push(`${remote.label}: connected`);
  else if (remote.state === 'connecting') lines.push(`${remote.label}: connecting…`);
  else lines.push(`${remote.label}: ${detail ?? 'connection error'}`);
  if (remote.state !== 'error' && detail) lines.push(detail);
  lines.push(...extra);
  return lines.join('\n');
}

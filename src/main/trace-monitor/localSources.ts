import path from 'node:path';
import type { TraceSourceOptions } from '../../shared/types';
import { HermesMonitor } from './HermesMonitor';
import type { MonitorSource } from './MultiSourceMonitor';
import { TraceMonitor } from './TraceMonitor';
import { enabledTools, traceDir, traceRoots } from './traceSources';

/**
 * This machine's trace sources (desktop app and agent): HermesMonitor for Hermes' state.db and one TraceMonitor for the
 * enabled tools' trace roots. AGENT_MONITOR_TRACE_ROOT replaces all of them with a single TraceMonitor on that
 * directory (options are ignored); AGENT_MONITOR_IDLE_MS sets the idle timeout.
 */
export function createLocalSources(options: TraceSourceOptions = {}, env: NodeJS.ProcessEnv = process.env): MonitorSource[] {
  const idle = Number(env.AGENT_MONITOR_IDLE_MS);
  const idleMs = Number.isFinite(idle) && idle > 0 ? { idleMs: idle } : {};
  if (env.AGENT_MONITOR_TRACE_ROOT) return [new TraceMonitor({ roots: [path.resolve(env.AGENT_MONITOR_TRACE_ROOT)], ...idleMs })];
  const roots = traceRoots(options, env);
  return [
    ...(enabledTools(options).includes('hermes') ? [new HermesMonitor({ dbPath: path.join(traceDir('hermes', options, env), 'state.db'), ...idleMs })] : []),
    ...(roots.length ? [new TraceMonitor({ roots, ...idleMs })] : []),
  ];
}

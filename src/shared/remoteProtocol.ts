/**
 * Wire protocol between the headless agent (src/agent, one per server) and the desktop RemoteMonitor.
 *
 * The agent binds loopback only and is reached through an SSH local forward, or (managed servers) runs as the
 * command of an SSH session and serves over its stdin/stdout, so SSH provides encryption and authentication. All bodies are JSON; errors are `{ "error": string }` with a 4xx/5xx status.
 *
 *   GET  /api/version               -> AgentVersionInfo
 *   GET  /api/snapshot              -> MonitorSnapshot
 *   GET  /api/trace?agentId=<id>    -> TraceEntry[]
 *   POST /api/load-run  {"runId"}   -> 204
 *   GET  /api/events                -> text/event-stream; sends `event: snapshot` with a MonitorSnapshot
 *                                      immediately and on every change, and a `: ping` comment every
 *                                      AGENT_HEARTBEAT_MS so dead tunnels are noticed.
 *
 * IDs on the wire are the agent's own (unprefixed); the desktop side namespaces them per server.
 */
export const AGENT_PROTOCOL_VERSION = 1;
export const AGENT_DEFAULT_PORT = 8787;
export const AGENT_HEARTBEAT_MS = 15_000;
export interface AgentVersionInfo { protocol: number; version: string; hostname: string }

/** Where a RemoteMonitor reaches its agent. `open` is idempotent: it returns the live base URL, reopening the transport if it died. */
export interface RemoteEndpoint {
  open(): Promise<string>;
  close(): Promise<void>;
}

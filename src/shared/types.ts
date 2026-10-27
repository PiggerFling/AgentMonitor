export type AgentHarness = 'codex' | 'claude' | 'pi' | 'hermes' | 'unknown';
export type AgentStatus = 'starting' | 'active' | 'idle' | 'finished' | 'error';
export type AgentType = 'main' | 'subagent' | 'child-session' | 'unknown';
/** Input includes cache reads/writes; output already includes reasoning tokens. */
export interface ModelTokenUsage {
  model: string;
  provider?: string;
  serviceTier?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
  requestInputTokens?: number;
}
export interface Agent {
  id: string; runId: string; parentId: string | null; harness: AgentHarness;
  type: AgentType; status: AgentStatus;
  sessionId?: string; threadId?: string; parentThreadId?: string;
  model?: string; provider?: string; reasoningEffort?: string; role?: string; nickname?: string; agentPath?: string;
  cwd?: string; tracePath?: string; createdAt?: number; lastActivityAt?: number; activity?: string;
  tokenUsage?: ModelTokenUsage[];
  tokenTimeline?: { timestamp: number; inputTokens: number; outputTokens: number }[];
  stats: { inputTokens: number; outputTokens: number; toolCalls: number; errors: number };
}
/** `host` is set on runs from a remote agent-monitor agent and names the server they came from. */
export interface AgentRun { title?: string; id: string; harness: AgentHarness; host?: string; rootAgentId?: string; cwd?: string; startedAt?: number; lastActivityAt?: number; agentCount?: number }
export interface AgentEdge { id: string; source: string; target: string; type: 'spawn'; status: 'starting' | 'active' | 'finished' }
/** Connection state of one configured remote server, as reported by its RemoteMonitor. */
export interface RemoteHostStatus { id: string; label: string; state: 'connecting' | 'connected' | 'error'; error?: string; lastConnectedAt?: number }
export interface MonitorSnapshot { agents: Agent[]; runs: AgentRun[]; edges: AgentEdge[]; watching: boolean; errors: string[]; selectedRunId?: string; remotes?: RemoteHostStatus[] }
/** `usage` holds the token counts of the single request a usage entry reports. */
export interface TraceEntry { usage?: { input: number; output: number }; callId?: string; toolName?: string; model?: string; reasoningEffort?: string; turnId?: string; id: string; timestamp?: number; kind: 'user' | 'assistant' | 'thinking' | 'tool-call' | 'tool-result' | 'usage' | 'error' | 'event'; text: string }
export type AgentEvent = { type: 'agent.discovered'; agent: Agent } | { type: 'agent.spawned'; agent: Agent } | {type:'agent.updated';agentId:string;changes:Partial<Agent>} | {type:'agent.finished';agentId:string} | {type:'agent.error';agentId:string;error?:string} | {type:'agent.activity';agentId:string;timestamp:number} | {type:'run.discovered';run:AgentRun};
/** A concrete host from ~/.ssh/config; `serverId` (and `managed`) are set when servers.json already has an entry with this `ssh` alias. */
export interface SshHostInfo { alias: string; hostName?: string; user?: string; port?: number; serverId?: string; managed?: boolean }
/** Steps of adding a server, in order: inspect the server over ssh, upload and verify the agent, write servers.json. */
export type ServerSetupStep = 'probe' | 'install' | 'save';
export interface ServerSetupProgress { alias: string; step: ServerSetupStep; state: 'running' | 'done' | 'failed' }
/**
 * Why adding a server failed. `auth`: key rejected; `host-key`: host key unknown (retry with acceptNewHostKey after the user
 * confirms `fingerprint`); `host-key-changed`: known_hosts has a different key; `unreachable`: DNS/network/timeout;
 * `unsupported-os`: not Linux/macOS; `node-missing` / `node-too-old` (`nodeVersion` = best found): needs Node.js 22.12+;
 * `install-failed`: upload or checksum failed; `already-added`: servers.json has this alias; `busy`: already being added;
 * `save-failed`: servers.json could not be written; `failed`: anything else (see `detail`).
 */
export type ServerSetupErrorCode = 'auth' | 'host-key' | 'host-key-changed' | 'unreachable' | 'unsupported-os' | 'node-missing' | 'node-too-old' | 'install-failed' | 'already-added' | 'busy' | 'save-failed' | 'failed';
export type AddServerResult = { ok: true; serverId: string } | { ok: false; code: ServerSetupErrorCode; message: string; detail?: string; nodeVersion?: string; fingerprint?: string };
/** `cleanupError` is set when removing ~/.agent-monitor on the server failed; the entry is removed regardless. */
export type RemoveServerResult = { ok: true; cleanupError?: string } | { ok: false; code: 'not-found' | 'failed'; message: string };
export interface MonitorBridge {
  platform?: string; getSnapshot(): Promise<MonitorSnapshot>; onSnapshot(callback: (snapshot: MonitorSnapshot) => void): () => void; getTrace(agentId: string): Promise<TraceEntry[]>; loadRun(runId: string): Promise<void>;
  listSshHosts(): Promise<SshHostInfo[]>;
  /** Probes the host, installs the agent and saves the server; it starts connecting right away. Progress arrives through onServerSetupProgress. */
  addServer(request: { alias: string; acceptNewHostKey?: boolean }): Promise<AddServerResult>;
  /** Stops and forgets a server; `cleanup` also deletes ~/.agent-monitor on it (managed servers only, best effort). */
  removeServer(request: { id: string; cleanup: boolean }): Promise<RemoveServerResult>;
  onServerSetupProgress(callback: (progress: ServerSetupProgress) => void): () => void;
}
declare global { interface Window { agentMonitor?: MonitorBridge } }

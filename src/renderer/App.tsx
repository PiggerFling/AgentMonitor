import {
  Activity,
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  Filter,
  LoaderCircle,
  Maximize2,
  Network,
  PanelRightClose,
  PauseCircle,
  Play,
  Radio,
  RefreshCw,
  Search,
  SquareArrowOutUpRight,
  Target,
  TriangleAlert,
  Zap,
  X,
} from 'lucide-react';
import {
  Background,
  BaseEdge,
  Controls,
  Edge,
  EdgeProps,
  getBezierPath,
  Handle,
  MiniMap,
  Node,
  NodeProps,
  Panel,
  Position,
  ReactFlow,
  useReactFlow,
} from '@xyflow/react';
import type { NodeChange } from '@xyflow/react';
import dagre from '@dagrejs/dagre';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { CSSProperties } from 'react';
import type {
  Agent,
  AgentEdge,
  AgentHarness,
  AgentRun,
  MonitorBridge,
  MonitorSnapshot,
  RemoteHostStatus,
  TraceEntry,
} from '../shared/types';
import { useDashboardStore } from './store';
import { ThemeSelector } from './ThemeSelector';
import { Dropdown } from './Dropdown';
import { TraceWorkspace } from './TraceWorkspace';
import { RollingNumber } from './RollingNumber';
import { RunTokenDetails } from './RunTokenDetails';
import { formatNumber, formatRelativeTime, t, useI18n, type MessageKey } from './i18n';
import { LanguageSelector } from './LanguageSelector';
import { ServersControl } from './ServersPanel';
import { assessMonitorHealth, buildHostOptions, filterAgentsByHost, filterRunsByHost, remoteIndicatorState, remoteStatusTitle, resolveHostFilter, runHostLabel } from './remoteUi';
import './TraceTabs.css';

type SourceMode = 'loading' | 'live' | 'offline' | 'demo';
import type { ProviderFilter } from './store';

type LazyAgentRun = AgentRun & { agentCount?: number };
type LazyMonitorSnapshot = MonitorSnapshot & { selectedRunId?: string };
type LazyMonitorBridge = MonitorBridge & { loadRun?: (runId: string) => Promise<void> };
type RunTokenSummary = {
  input: number;
  output: number;
  lastLoadedAt: number;
  lastActivityAt?: number;
};

function runAgentCount(run: AgentRun, loadedAgents: Agent[]) {
  const count = (run as LazyAgentRun).agentCount;
  return typeof count === 'number' ? count : loadedAgents.filter((agent) => agent.runId === run.id).length;
}

function snapshotSelectedRunId(snapshot: MonitorSnapshot) {
  return (snapshot as LazyMonitorSnapshot).selectedRunId;
}

const EMPTY_SNAPSHOT: MonitorSnapshot = {
  agents: [],
  runs: [],
  edges: [],
  watching: false,
  errors: [],
};

const DEMO_SNAPSHOT: MonitorSnapshot = {
  watching: true,
  errors: [],
  runs: [
    {
      id: 'demo-run-agent-monitor',
      harness: 'codex',
      rootAgentId: 'demo-root',
      cwd: '/workspace/agent-monitor',
      startedAt: Date.now() - 1000 * 60 * 8,
      lastActivityAt: Date.now() - 1000 * 4,
    },
  ],
  agents: [
    {
      id: 'demo-root',
      runId: 'demo-run-agent-monitor',
      parentId: null,
      harness: 'codex',
      type: 'main',
      status: 'active',
      sessionId: 'demo-session',
      threadId: 'demo-thread',
      model: 'GPT-6 Astra',
      provider: 'OpenAI',
      reasoningEffort: 'high',
      role: 'main agent',
      nickname: 'Astra',
      cwd: '/workspace/agent-monitor',
      createdAt: Date.now() - 1000 * 60 * 8,
      lastActivityAt: Date.now() - 1000 * 3,
      activity: 'Coordinating the Agent Monitor implementation',
      stats: { inputTokens: 124800, outputTokens: 18600, toolCalls: 32, errors: 0 },
    },
    {
      id: 'demo-explorer',
      runId: 'demo-run-agent-monitor',
      parentId: 'demo-root',
      harness: 'codex',
      type: 'subagent',
      status: 'active',
      sessionId: 'demo-session-explorer',
      threadId: 'demo-thread-explorer',
      parentThreadId: 'demo-thread',
      model: 'GPT-5.6 Luna',
      provider: 'OpenAI',
      reasoningEffort: 'medium',
      role: 'explorer',
      nickname: 'Repository Scout',
      createdAt: Date.now() - 1000 * 60 * 5,
      lastActivityAt: Date.now() - 1000 * 7,
      activity: 'Mapping renderer boundaries and existing contracts',
      stats: { inputTokens: 18421, outputTokens: 2194, toolCalls: 12, errors: 0 },
    },
    {
      id: 'demo-tester',
      runId: 'demo-run-agent-monitor',
      parentId: 'demo-root',
      harness: 'codex',
      type: 'subagent',
      status: 'idle',
      sessionId: 'demo-session-tester',
      threadId: 'demo-thread-tester',
      parentThreadId: 'demo-thread',
      model: 'GPT-5.6 Luna',
      provider: 'OpenAI',
      reasoningEffort: 'high',
      role: 'test runner',
      nickname: 'Validation',
      createdAt: Date.now() - 1000 * 60 * 4,
      lastActivityAt: Date.now() - 1000 * 48,
      activity: 'Waiting for the Vite shell to finish compiling',
      stats: { inputTokens: 12640, outputTokens: 3410, toolCalls: 8, errors: 0 },
    },
    {
      id: 'demo-reviewer',
      runId: 'demo-run-agent-monitor',
      parentId: 'demo-explorer',
      harness: 'codex',
      type: 'subagent',
      status: 'finished',
      sessionId: 'demo-session-reviewer',
      threadId: 'demo-thread-reviewer',
      parentThreadId: 'demo-thread-explorer',
      model: 'GPT-5.6 Luna',
      provider: 'OpenAI',
      reasoningEffort: 'low',
      role: 'reviewer',
      nickname: 'Trace Review',
      createdAt: Date.now() - 1000 * 60 * 3,
      lastActivityAt: Date.now() - 1000 * 74,
      activity: 'Finished checking the normalized trace contract',
      stats: { inputTokens: 8300, outputTokens: 1960, toolCalls: 6, errors: 0 },
    },
  ],
  edges: [
    { id: 'demo-edge-root-explorer', source: 'demo-root', target: 'demo-explorer', type: 'spawn', status: 'active' },
    { id: 'demo-edge-root-tester', source: 'demo-root', target: 'demo-tester', type: 'spawn', status: 'finished' },
    { id: 'demo-edge-explorer-reviewer', source: 'demo-explorer', target: 'demo-reviewer', type: 'spawn', status: 'finished' },
  ],
};

const PROVIDERS: Array<{ value: ProviderFilter; label?: string; labelKey?: MessageKey }> = [
  { value: 'all', labelKey: 'app.providers.all' },
  { value: 'codex', label: 'Codex' },
  { value: 'claude', label: 'Claude Code' },
  { value: 'pi', label: 'Pi' },
  { value: 'hermes', label: 'Hermes' },
  { value: 'unknown', labelKey: 'app.providers.misc' },
];

const STATUS_META: Record<Agent['status'], { labelKey: MessageKey; color: string; icon: typeof Activity }> = {
  starting: { labelKey: 'app.status.starting', color: 'var(--status-starting)', icon: LoaderCircle },
  active: { labelKey: 'app.status.active', color: 'var(--status-active)', icon: Activity },
  idle: { labelKey: 'app.status.idle', color: 'var(--status-idle)', icon: PauseCircle },
  finished: { labelKey: 'app.status.finished', color: 'var(--status-finished)', icon: CheckCircle2 },
  error: { labelKey: 'app.status.error', color: 'var(--status-error)', icon: AlertCircle },
};

const TRACE_KIND_LABEL: Record<TraceEntry['kind'], MessageKey> = {
  user: 'app.traceKind.user',
  assistant: 'app.traceKind.assistant',
  thinking: 'app.traceKind.thinking',
  'tool-call': 'app.traceKind.toolCall',
  'tool-result': 'app.traceKind.toolResult',
  usage: 'app.traceKind.usage',
  error: 'app.traceKind.error',
  event: 'app.traceKind.event',
};

function now() {
  return Date.now();
}

function formatCompact(value: number | undefined) {
  if (!value) return '0';
  if (value >= 1000000) return `${formatNumber(value / 1000000, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}m`;
  if (value >= 1000) { const digits = value >= 10000 ? 0 : 1; return `${formatNumber(value / 1000, { minimumFractionDigits: digits, maximumFractionDigits: digits })}k`; }
  return formatNumber(value);
}

function formatExactNumber(value: number | undefined) {
  return formatNumber(value ?? 0);
}

function formatRelative(timestamp: number | undefined) {
  return formatRelativeTime(timestamp, now());
}

function formatDuration(start: number | undefined, end = now()) {
  if (!start) return '—';
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours) return t('app.duration.hoursMinutes', { hours, minutes: String(minutes).padStart(2, '0') });
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function runSort(a: AgentRun, b: AgentRun) {
  return (b.lastActivityAt ?? b.startedAt ?? 0) - (a.lastActivityAt ?? a.startedAt ?? 0);
}

function providerLabel(value: AgentHarness) {
  const provider = PROVIDERS.find((item) => item.value === value);
  return provider?.labelKey ? t(provider.labelKey) : provider?.label ?? t('app.providers.unknown');
}

function sampleTrace(agent: Agent): TraceEntry[] {
  const base = agent.createdAt ?? now() - 1000 * 60;
  return [
    { id: `${agent.id}-trace-1`, timestamp: base, kind: 'event', text: `${agent.role ?? 'Agent'} session discovered by the monitor.` },
    { id: `${agent.id}-trace-2`, timestamp: base + 1200, kind: 'assistant', text: agent.activity ?? 'Working through the current task.' },
    { id: `${agent.id}-trace-3`, timestamp: base + 3600, kind: 'tool-call', text: 'search — rg --files src tests' },
    { id: `${agent.id}-trace-4`, timestamp: base + 4900, kind: 'tool-result', text: 'Found renderer entry points and shared agent types.' },
    { id: `${agent.id}-trace-5`, timestamp: base + 9800, kind: 'usage', text: `${formatExactNumber(agent.stats.inputTokens)} input · ${formatExactNumber(agent.stats.outputTokens)} output tokens` },
  ];
}

function useMonitorSnapshot() {
  const [nativeSnapshot, setNativeSnapshot] = useState<MonitorSnapshot>(EMPTY_SNAPSHOT);
  const [mode, setMode] = useState<SourceMode>(() => (typeof window !== 'undefined' && window.agentMonitor ? 'loading' : 'offline'));
  const [usingDemo, setUsingDemo] = useState(false);
  const [loadedRunId, setLoadedRunId] = useState<string>();
  const [loadingRunId, setLoadingRunId] = useState<string>();
  const [runLoadError, setRunLoadError] = useState<string>();
  const loadRequestRef = useRef(0);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.agentMonitor) {
      setMode('offline');
      return;
    }

    const bridge = window.agentMonitor;
    let cancelled = false;
    let callbackSeen = false;
    let unsubscribe: (() => void) | undefined;

    const receive = (snapshot: MonitorSnapshot) => {
      if (cancelled) return;
      callbackSeen = true;
      setNativeSnapshot(snapshot);
      setLoadedRunId(snapshotSelectedRunId(snapshot));
      setMode('live');
    };

    try {
      unsubscribe = bridge.onSnapshot(receive);
    } catch {
      unsubscribe = undefined;
    }

    void bridge
      .getSnapshot()
      .then((snapshot) => {
        if (!cancelled && !callbackSeen) {
          setNativeSnapshot(snapshot);
          setLoadedRunId(snapshotSelectedRunId(snapshot));
          setMode('live');
        }
      })
      .catch(() => {
        if (!cancelled && !callbackSeen) setMode('offline');
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const snapshot = usingDemo ? DEMO_SNAPSHOT : nativeSnapshot;
  const loadRun = useCallback(async (runId: string) => {
    if (usingDemo) {
      setLoadedRunId(runId);
      setLoadingRunId(undefined);
      setRunLoadError(undefined);
      return;
    }
    const bridge = typeof window !== 'undefined' ? window.agentMonitor as LazyMonitorBridge | undefined : undefined;
    const requestId = ++loadRequestRef.current;
    setLoadingRunId(runId);
    setRunLoadError(undefined);
    setLoadedRunId(undefined);
    if (!bridge?.loadRun) {
      if (requestId === loadRequestRef.current) {
        setLoadingRunId(undefined);
        setRunLoadError(t('app.empty.bridgeCannotLoad'));
      }
      return;
    }
    try {
      await bridge.loadRun(runId);
      if (requestId === loadRequestRef.current) {
        setLoadedRunId(runId);
        setLoadingRunId(undefined);
      }
    } catch (error) {
      if (requestId === loadRequestRef.current) {
        setLoadingRunId(undefined);
        setRunLoadError(error instanceof Error ? error.message : t('app.empty.runLoadFailed'));
      }
    }
  }, [usingDemo]);

  const setDemoMode = useCallback(() => {
    ++loadRequestRef.current;
    setRunLoadError(undefined);
    setLoadingRunId(undefined);
    setLoadedRunId(DEMO_SNAPSHOT.runs[0]?.id);
    setUsingDemo(true);
  }, []);

  const setLiveMode = useCallback(() => {
    ++loadRequestRef.current;
    setRunLoadError(undefined);
    setLoadingRunId(undefined);
    setLoadedRunId(snapshotSelectedRunId(nativeSnapshot));
    setUsingDemo(false);
  }, [nativeSnapshot]);

  return {
    snapshot,
    mode: usingDemo ? 'demo' : mode,
    loadedRunId: usingDemo ? DEMO_SNAPSHOT.runs[0]?.id : loadedRunId,
    loadingRunId,
    runLoadError,
    loadRun,
    setDemo: setDemoMode,
    setLive: setLiveMode,
    usingDemo,
  };
}

type AgentNodeData = {
  agent: Agent;
  pulse: boolean;
  arrived: boolean;
  onOpenTrace?: (agent: Agent) => void;
};

type AgentFlowNode = Node<AgentNodeData, 'agent'>;
type SpawnFlowEdge = Edge<{ status: AgentEdge['status']; active: boolean }, 'spawn'>;

const NODE_WIDTH = 310;
const NODE_HEIGHT = 230;
/** Automatic framing never zooms out past this; below it node text is unreadable. */
const MIN_AUTO_ZOOM = 0.6;
const FIT_PADDING = 0.22;
const FIT_MAX_ZOOM = 1.05;
/** Keeps the framed root clear of the graph toolbar. */
const ROOT_TOP_OFFSET = 96;
const NODE_GAP = 40;
const CHILD_SLOT = NODE_WIDTH + NODE_GAP;

type GraphPosition = { x: number; y: number };

function positionIsAvailable(candidate: GraphPosition, positions: Record<string, GraphPosition>, ignoredId?: string) {
  return Object.entries(positions).every(([id, position]) => {
    if (id === ignoredId) return true;
    const horizontalGap = Math.abs(position.x - candidate.x);
    const verticalGap = Math.abs(position.y - candidate.y);
    return horizontalGap >= NODE_WIDTH + NODE_GAP || verticalGap >= NODE_HEIGHT + NODE_GAP;
  });
}

function findChildPosition(parent: GraphPosition, positions: Record<string, GraphPosition>) {
  // Keep the first child where it was placed. Subsequent children search
  // alternating sides until a full card-sized slot is free. This keeps live
  // arrivals stable and avoids the common 175px sibling overlap.
  const offsets = [0];
  for (let distance = 1; distance <= Object.keys(positions).length + 1; distance += 1) {
    offsets.push(distance, -distance);
  }
  for (const offset of offsets) {
    const candidate = { x: parent.x + offset * CHILD_SLOT, y: parent.y + NODE_HEIGHT + 110 };
    if (positionIsAvailable(candidate, positions)) return candidate;
  }
  return { x: parent.x + (Object.keys(positions).length + 1) * CHILD_SLOT, y: parent.y + NODE_HEIGHT + 110 };
}

function computeDagrePositions(agents: Agent[], edges: AgentEdge[]) {
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: 'TB', ranksep: 104, nodesep: 58, marginx: 28, marginy: 24 });
  agents.forEach((agent) => graph.setNode(agent.id, { width: NODE_WIDTH, height: NODE_HEIGHT }));
  edges.forEach((edge) => {
    if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) graph.setEdge(edge.source, edge.target);
  });
  dagre.layout(graph);

  return Object.fromEntries(
    agents.map((agent) => {
      const point = graph.node(agent.id);
      return [agent.id, { x: (point?.x ?? 0) - NODE_WIDTH / 2, y: (point?.y ?? 0) - NODE_HEIGHT / 2 }];
    }),
  );
}

function AgentNode({ data, selected }: NodeProps<AgentFlowNode>) {
  const { t } = useI18n();
  const { agent, pulse, arrived, onOpenTrace } = data;
  const status = STATUS_META[agent.status];
  const statusLabel = t(status.labelKey);
  const StatusIcon = status.icon;
  const displayName = agent.nickname || agent.role || (agent.type === 'main' ? t('app.agent.main') : t('app.agent.subagent'));
  const model = agent.model || t('app.agent.modelPending');
  const effort = agent.reasoningEffort || t('app.agent.effortDefault');
  const isMain = agent.type === 'main';

  return (
    <article
      className={`agent-node ${isMain ? 'agent-node--main' : ''} ${selected ? 'agent-node--selected' : ''} ${pulse ? 'agent-node--pulse' : ''} ${arrived ? 'agent-node--arrived' : ''}`}
      style={{ '--status-color': status.color } as CSSProperties}
      data-testid={`agent-node-${agent.id}`}
      data-agent-id={agent.id}
      data-agent-type={agent.type}
      aria-label={t('app.agent.nodeLabel', { name: displayName, status: statusLabel, model })}
    >
      <Handle type="target" position={Position.Top} className="agent-node__handle" />
      <div className="agent-node__shine" />
      <header className="agent-node__header">
        <div className="agent-node__kind">{agent.harness.toUpperCase()}</div>
        <div className="agent-node__header-end">
          <div className="agent-node__status" style={{ color: status.color }}><StatusIcon size={13} className={agent.status === 'starting' ? 'spin' : ''} />{statusLabel}</div>
          {onOpenTrace && <button
            type="button"
            className="agent-node__open nodrag nopan"
            title={t('app.agent.openTrace')}
            aria-label={t('app.agent.openNamedTrace', { name: displayName })}
            onClick={(event) => { event.stopPropagation(); onOpenTrace(agent); }}
          ><SquareArrowOutUpRight size={12} /></button>}
        </div>
      </header>
      <div className="agent-node__identity">
        <div className="agent-node__name">{displayName}</div>
        <div className="agent-node__model">{model}<span className="agent-node__dot">·</span><span className="agent-node__effort">{effort}</span></div>
      </div>
      <div className="agent-node__activity"><span>{agent.activity || t('app.agent.waiting')}</span></div>
      <div className="agent-node__metrics">
        <div><span>{t('app.agent.metricIn')}</span><strong>{formatCompact(agent.stats.inputTokens)}</strong></div>
        <div><span>{t('app.agent.metricOut')}</span><strong>{formatCompact(agent.stats.outputTokens)}</strong></div>
        <div><span>{t('app.agent.metricTools')}</span><strong>{formatCompact(agent.stats.toolCalls)}</strong></div>
      </div>
      <footer className="agent-node__footer"><span>{agent.role || (isMain ? t('app.agent.mainRole') : agent.type)}</span><span>{formatRelative(agent.lastActivityAt)}</span></footer>
      <Handle type="source" position={Position.Bottom} className="agent-node__handle" />
    </article>
  );
}

function SpawnEdge(props: EdgeProps<SpawnFlowEdge>) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data } = props;
  const [path] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const active = data?.active ?? false;

  return (
    <>
      <BaseEdge id={id} path={path} className={`spawn-edge ${active ? 'spawn-edge--active' : ''}`} />
      {active && (
        <g className="spawn-edge__particle" aria-hidden="true">
          <circle r="3.5">
            <animateMotion path={path} dur="1.4s" repeatCount="indefinite" />
          </circle>
        </g>
      )}
    </>
  );
}

const nodeTypes = { agent: AgentNode };
const edgeTypes = { spawn: SpawnEdge };

type AgentGraphProps = {
  runId?: string;
  agents: Agent[];
  edges: AgentEdge[];
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string) => void;
  onOpenTrace?: (agent: Agent) => void;
};

function AgentGraph({ runId, agents, edges, selectedAgentId, onSelectAgent, onOpenTrace }: AgentGraphProps) {
  const { t } = useI18n();
  const { fitView, setCenter, setViewport, getNodes, getViewport } = useReactFlow();
  const shellRef = useRef<HTMLDivElement>(null);
  const [layoutNonce, setLayoutNonce] = useState(0);
  const [positionRevision, setPositionRevision] = useState(0);
  const positionsRef = useRef<Record<string, { x: number; y: number }>>({});
  const dimensionsRef = useRef<Record<string, { width: number; height: number }>>({});
  const currentRunRef = useRef<string | undefined>(undefined);
  const lastLayoutNonce = useRef(0);
  const knownAgentIdsRef = useRef(new Set<string>());
  const previousVisibleIdsRef = useRef(new Set<string>());
  const userMovedViewportRef = useRef(false);
  const pulseTimersRef = useRef<number[]>([]);
  const [pulseIds, setPulseIds] = useState<Set<string>>(new Set());

  const visibleAgents = useMemo(() => agents.filter((agent) => !runId || agent.runId === runId), [agents, runId]);
  const visibleIds = useMemo(() => new Set(visibleAgents.map((agent) => agent.id)), [visibleAgents]);
  const visibleEdges = useMemo(() => edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target)), [edges, visibleIds]);
  const visibleAgentsRef = useRef(visibleAgents);
  visibleAgentsRef.current = visibleAgents;
  const fitGraph = useCallback(() => void fitView({ padding: FIT_PADDING, maxZoom: FIT_MAX_ZOOM, duration: 550 }), [fitView]);

  /**
   * Automatic framing: fit the whole graph while it stays readable. Larger
   * graphs keep a readable zoom and show the root (or the focused agent).
   */
  const frameGraph = useCallback((focusId?: string | null) => {
    const graphNodes = getNodes();
    const shell = shellRef.current;
    if (!graphNodes.length || !shell) return;
    const xs = graphNodes.map((node) => node.position.x);
    const ys = graphNodes.map((node) => node.position.y);
    const width = Math.max(...graphNodes.map((node) => node.position.x + (node.measured?.width ?? NODE_WIDTH))) - Math.min(...xs);
    const height = Math.max(...graphNodes.map((node) => node.position.y + (node.measured?.height ?? NODE_HEIGHT))) - Math.min(...ys);
    const scale = 1 + FIT_PADDING * 2;
    const fitZoom = Math.min(shell.clientWidth / (width * scale), shell.clientHeight / (height * scale), FIT_MAX_ZOOM);
    if (fitZoom >= MIN_AUTO_ZOOM) return fitGraph();
    const zoom = Math.max(MIN_AUTO_ZOOM, Math.min(getViewport().zoom, FIT_MAX_ZOOM));
    const focus = focusId ? graphNodes.find((node) => node.id === focusId) : undefined;
    if (focus) {
      void setCenter(focus.position.x + NODE_WIDTH / 2, focus.position.y + NODE_HEIGHT / 2, { zoom, duration: 550 });
      return;
    }
    const agentsInView = visibleAgentsRef.current;
    const rootAgent = agentsInView.find((agent) => agent.type === 'main') ?? agentsInView.find((agent) => !agent.parentId);
    const root = graphNodes.find((node) => node.id === rootAgent?.id) ?? graphNodes[0];
    void setViewport({
      x: shell.clientWidth / 2 - (root.position.x + NODE_WIDTH / 2) * MIN_AUTO_ZOOM,
      y: ROOT_TOP_OFFSET - root.position.y * MIN_AUTO_ZOOM,
      zoom: MIN_AUTO_ZOOM,
    }, { duration: 550 });
  }, [fitGraph, getNodes, getViewport, setCenter, setViewport]);

  useEffect(() => {
    const newAgents = visibleAgents.filter((agent) => !knownAgentIdsRef.current.has(agent.id));
    if (newAgents.length && knownAgentIdsRef.current.size) {
      const parentIds = new Set(newAgents.map((agent) => agent.parentId).filter((id): id is string => Boolean(id)));
      setPulseIds(parentIds);
      const timer = window.setTimeout(() => setPulseIds(new Set()), 1300);
      pulseTimersRef.current.push(timer);
    }
    knownAgentIdsRef.current = visibleIds;
    return () => {
      pulseTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      pulseTimersRef.current = [];
    };
  }, [visibleAgents, visibleIds]);

  useEffect(() => () => {
    pulseTimersRef.current.forEach((timer) => window.clearTimeout(timer));
  }, []);

  const { nodes, flowEdges } = useMemo(() => {
    const runChanged = currentRunRef.current !== runId;
    const forcedLayout = lastLayoutNonce.current !== layoutNonce;
    if (runChanged || forcedLayout) {
      positionsRef.current = computeDagrePositions(visibleAgents, visibleEdges);
      currentRunRef.current = runId;
      lastLayoutNonce.current = layoutNonce;
    } else {
      const fallback = computeDagrePositions(visibleAgents, visibleEdges);
      const existing = positionsRef.current;
      visibleAgents.forEach((agent) => {
        if (existing[agent.id]) return;
        if (agent.parentId && existing[agent.parentId]) {
          existing[agent.id] = findChildPosition(existing[agent.parentId], existing);
        } else {
          existing[agent.id] = fallback[agent.id] ?? { x: 0, y: 0 };
        }
      });
      Object.keys(existing).forEach((id) => {
        if (!visibleIds.has(id)) delete existing[id];
      });
    }

    const flowNodes: AgentFlowNode[] = visibleAgents.map((agent) => {
      const dimensions = dimensionsRef.current[agent.id];
      return {
        id: agent.id,
        type: 'agent',
        position: positionsRef.current[agent.id] ?? { x: 0, y: 0 },
        handles: [
          { id: null, type: 'target', position: Position.Top, x: NODE_WIDTH / 2 - 4, y: -4, width: 8, height: 8 },
          { id: null, type: 'source', position: Position.Bottom, x: NODE_WIDTH / 2 - 4, y: NODE_HEIGHT - 4, width: 8, height: 8 },
        ],
        ...(dimensions ? { width: dimensions.width, height: dimensions.height } : {}),
        ...(dimensions ? { measured: dimensions } : {}),
        data: {
          agent,
          arrived: !knownAgentIdsRef.current.has(agent.id),
          pulse: pulseIds.has(agent.id),
          onOpenTrace,
        },
        selected: agent.id === selectedAgentId,
        draggable: true,
      };
    });
    const flowEdges: SpawnFlowEdge[] = visibleEdges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: 'spawn',
      data: { status: edge.status, active: edge.status === 'active' || edge.status === 'starting' },
    }));
    return { nodes: flowNodes, flowEdges };
  }, [layoutNonce, onOpenTrace, positionRevision, pulseIds, runId, selectedAgentId, visibleAgents, visibleEdges, visibleIds]);

  useEffect(() => {
    if (!visibleAgents.length) return;
    const timer = window.setTimeout(() => frameGraph(), 100);
    return () => window.clearTimeout(timer);
  }, [frameGraph, runId]);

  useEffect(() => {
    const previousIds = previousVisibleIdsRef.current;
    const receivedNewAgent = visibleAgents.some((agent) => !previousIds.has(agent.id));
    previousVisibleIdsRef.current = visibleIds;
    if (!receivedNewAgent || !previousIds.size || userMovedViewportRef.current) return;
    const timer = window.setTimeout(() => frameGraph(), 100);
    return () => window.clearTimeout(timer);
  }, [frameGraph, visibleAgents, visibleIds]);

  useEffect(() => {
    if (!selectedAgentId || !visibleAgents.length) return;
    const timer = window.setTimeout(() => frameGraph(selectedAgentId), 160);
    return () => window.clearTimeout(timer);
  }, [frameGraph, selectedAgentId, visibleAgents.length]);

  const onNodesChange = useCallback((changes: NodeChange<AgentFlowNode>[]) => {
    let changed = false;
    for (const change of changes) {
      if (!('id' in change)) continue;
      if (change.type === 'position' && change.position) {
        positionsRef.current[change.id] = change.position;
        changed = true;
      } else if (change.type === 'dimensions' && change.dimensions) {
        dimensionsRef.current[change.id] = change.dimensions;
        changed = true;
      } else if (change.type === 'remove') {
        delete positionsRef.current[change.id];
        delete dimensionsRef.current[change.id];
        changed = true;
      }
    }
    if (changed) setPositionRevision((value) => value + 1);
  }, []);

  const centerRoot = useCallback(() => {
    const root = visibleAgents.find((agent) => agent.type === 'main') ?? visibleAgents.find((agent) => !agent.parentId);
    const node = root ? getNodes().find((item) => item.id === root.id) : undefined;
    if (node) void setCenter(node.position.x + NODE_WIDTH / 2, node.position.y + NODE_HEIGHT / 2, { zoom: 1.05, duration: 520 });
  }, [getNodes, setCenter, visibleAgents]);

  const centerActive = useCallback(() => {
    const active = visibleAgents.find((agent) => agent.status === 'active') ?? visibleAgents.find((agent) => agent.status === 'starting');
    const node = active ? getNodes().find((item) => item.id === active.id) : undefined;
    if (node) void setCenter(node.position.x + NODE_WIDTH / 2, node.position.y + NODE_HEIGHT / 2, { zoom: 1.05, duration: 520 });
  }, [getNodes, setCenter, visibleAgents]);

  const onNodeClick = useCallback((_: React.MouseEvent, node: AgentFlowNode) => onSelectAgent(node.id), [onSelectAgent]);

  return (
    <div className="graph-shell" ref={shellRef}>
      <ReactFlow
        nodes={nodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        minZoom={0.18}
        maxZoom={1.7}
        nodesConnectable={false}
        onNodeClick={onNodeClick}
        onNodesChange={onNodesChange}
        onMoveStart={(event) => { if (event) userMovedViewportRef.current = true; }}
        onNodeDragStart={() => { userMovedViewportRef.current = true; }}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ type: 'spawn' }}
      >
        <Background color="var(--graph-grid)" gap={24} size={1} />
        <MiniMap
          className="graph-minimap"
          nodeColor={(node) => (node as AgentFlowNode).data?.agent?.type === 'main' ? 'var(--accent)' : 'var(--minimap-node)'}
          maskColor="var(--minimap-mask)"
          pannable
          zoomable
        />
        <Controls className="graph-controls" showInteractive={false} />
        <Panel position="top-left" className="graph-toolbar">
          <button type="button" onClick={fitGraph} title={t('app.graph.fitTitle')}><Maximize2 size={14} />{t('app.graph.fit')}</button>
          <button type="button" onClick={centerRoot} title={t('app.graph.rootTitle')}><Target size={14} />{t('app.graph.root')}</button>
          <button type="button" onClick={centerActive} title={t('app.graph.activeTitle')}><Zap size={14} />{t('app.graph.active')}</button>
          <button type="button" onClick={() => { positionsRef.current = {}; setLayoutNonce((value) => value + 1); }} title={t('app.graph.autoLayoutTitle')}><Network size={14} />{t('app.graph.autoLayout')}</button>
        </Panel>
        {!visibleAgents.length && <Panel position="top-center" className="graph-empty-hint"><Network size={17} /><span>{t('app.graph.noAgents')}</span></Panel>}
      </ReactFlow>
    </div>
  );
}

function EmptyGraph({ mode, selectedRun, loading, loadError, onDemo, onRetry }: { mode: SourceMode; selectedRun?: AgentRun; loading: boolean; loadError?: string; onDemo: () => void; onRetry?: () => void }) {
  const { t } = useI18n();
  const bridgeUnavailable = mode === 'offline';
  const noRunSelected = !bridgeUnavailable && !selectedRun && !loading && !loadError;
  const title = loading
    ? t('app.empty.loadingTitle')
    : loadError
      ? t('app.empty.errorTitle')
      : noRunSelected
        ? t('app.empty.noRunTitle')
        : bridgeUnavailable
          ? t('app.empty.offlineTitle')
          : t('app.empty.waitingTitle');
  const description = loading
    ? t('app.empty.loadingBody')
    : loadError
      ? loadError
      : noRunSelected
        ? t('app.empty.noRunBody')
        : bridgeUnavailable
          ? t('app.empty.offlineBody')
          : t('app.empty.waitingBody');
  return (
    <div className="empty-state">
      {(loading || loadError) && <div className="empty-state__glyph">{loading ? <LoaderCircle size={34} strokeWidth={1.4} className="spin" /> : <TriangleAlert size={34} strokeWidth={1.4} />}</div>}
      <h2>{title}</h2>
      <p>{description}</p>
      {loadError && onRetry ? <button type="button" className="button button--primary" onClick={onRetry}><RefreshCw size={15} />{t('app.empty.retry')}</button> : <button type="button" className="button button--primary" onClick={onDemo}><Play size={15} fill="currentColor" />{t('app.empty.demo')}</button>}
      <span className="empty-state__caption">{t('app.empty.caption')}</span>
    </div>
  );
}

function TraceList({ entries, loading }: { entries: TraceEntry[]; loading: boolean }) {
  const { t, locale } = useI18n();
  if (loading) return <div className="trace-placeholder"><LoaderCircle size={16} className="spin" />{t('app.trace.loading')}</div>;
  if (!entries.length) return <div className="trace-placeholder">{t('app.trace.empty')}</div>;
  return (
    <div className="trace-list">
      {entries.map((entry) => (
        <div className={`trace-entry trace-entry--${entry.kind}`} key={entry.id}>
          <div className="trace-entry__rail"><span /></div>
          <div className="trace-entry__body">
            <div className="trace-entry__meta"><span>{t(TRACE_KIND_LABEL[entry.kind])}</span><time>{entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'}</time></div>
            <p>{entry.text}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="detail-metric"><span>{label}</span><strong>{value}</strong></div>;
}

function AgentDetails({ agent, onClose, onExpand, mode }: { agent?: Agent; onClose: () => void; onExpand: (agent: Agent) => void; mode: SourceMode }) {
  const { t } = useI18n();
  const [trace, setTrace] = useState<TraceEntry[]>([]);
  const [loadingTrace, setLoadingTrace] = useState(false);
  const [traceError, setTraceError] = useState<string>();
  const [refreshNonce, setRefreshNonce] = useState(0);
  const requestIdRef = useRef(0);
  const agentId = agent?.id;

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    let cancelled = false;
    if (!agent) {
      setTrace([]);
      setLoadingTrace(false);
      return () => { cancelled = true; };
    }

    setLoadingTrace(true);
    setTraceError(undefined);
    const bridge = typeof window !== 'undefined' ? window.agentMonitor : undefined;
    if (mode === 'demo' || !bridge) {
      const timer = window.setTimeout(() => {
        if (!cancelled && requestId === requestIdRef.current) {
          setTrace(sampleTrace(agent));
          setLoadingTrace(false);
        }
      }, 150);
      return () => { cancelled = true; window.clearTimeout(timer); };
    }

    void bridge.getTrace(agent.id)
      .then((entries) => {
        if (!cancelled && requestId === requestIdRef.current) {
          setTrace(entries);
          setLoadingTrace(false);
        }
      })
      .catch(() => {
        if (!cancelled && requestId === requestIdRef.current) {
          setTrace([]);
          setTraceError(t('app.trace.loadFailed'));
          setLoadingTrace(false);
        }
      });

    return () => { cancelled = true; };
  }, [agentId, mode, refreshNonce]);

  if (!agent) return null;
  const status = STATUS_META[agent.status];
  const StatusIcon = status.icon;
  const title = agent.nickname || agent.role || (agent.type === 'main' ? t('app.agent.main') : t('app.agent.subagent'));

  return (
    <aside className="details-pane">
      <div className="details-pane__topline"><span className="eyebrow">{t('app.details.eyebrow')}</span><div className="details-pane__actions"><button type="button" className="icon-button" onClick={() => onExpand(agent)} title={t('app.details.expand')} aria-label={t('app.details.expand')}><Maximize2 size={17} /></button><button type="button" className="icon-button" onClick={onClose} title={t('app.details.close')}><PanelRightClose size={17} /></button></div></div>
      <div className="details-pane__heading"><div><h2>{title}</h2><p>{agent.type === 'main' ? t('app.details.rootSession') : agent.role || agent.type}</p></div><span className="details-status" style={{ color: status.color }}><StatusIcon size={14} />{t(status.labelKey)}</span></div>
      <div className="details-chip-row"><span className="chip chip--muted">{providerLabel(agent.harness)}</span><span className="chip chip--muted">{agent.model || t('app.agent.modelPending')}</span><span className="chip chip--muted">{agent.reasoningEffort || t('app.agent.effortDefault')}</span></div>

      <section className="details-section"><div className="details-section__label">{t('app.details.sessionMetadata')}</div><dl className="details-list"><div><dt>{t('app.details.harness')}</dt><dd>{providerLabel(agent.harness)}</dd></div><div><dt>{t('app.details.provider')}</dt><dd>{agent.provider || '—'}</dd></div><div><dt>{t('app.details.role')}</dt><dd>{agent.role || agent.type}</dd></div><div><dt>{t('app.details.lastActivity')}</dt><dd>{formatRelative(agent.lastActivityAt)}</dd></div><div><dt>{t('app.details.duration')}</dt><dd>{formatDuration(agent.createdAt)}</dd></div></dl></section>
      <section className="details-section"><div className="details-section__label">{t('app.details.usage')}</div><div className="detail-metric-grid"><Metric label={t('app.details.input')} value={formatExactNumber(agent.stats.inputTokens)} /><Metric label={t('app.details.output')} value={formatExactNumber(agent.stats.outputTokens)} /><Metric label={t('app.details.toolCalls')} value={formatExactNumber(agent.stats.toolCalls)} /><Metric label={t('app.details.errors')} value={formatExactNumber(agent.stats.errors)} /></div></section>
      <section className="details-section details-section--trace"><div className="details-section__title"><div><div className="details-section__label">{t('app.details.normalizedTrace')}</div><span>{t('app.details.liveEvents')}</span></div><button type="button" className="trace-open-button" title={t('app.details.refreshTrace')} onClick={() => setRefreshNonce((value) => value + 1)}><RefreshCw size={13} /></button></div>{traceError ? <div className="trace-placeholder trace-placeholder--error"><AlertCircle size={14} />{traceError}</div> : <TraceList entries={trace} loading={loadingTrace} />}</section>
      <div className="details-pane__footer"><span><CircleDot size={11} />{agent.threadId ? t('app.details.thread', { id: agent.threadId.slice(0, 12) }) : t('app.details.threadUnavailable')}</span><button type="button" className="button button--quiet" onClick={() => onExpand(agent)}>{t('app.details.openTraceTab')}</button></div>
    </aside>
  );
}

function RemoteStatusList({ remotes, remoteErrors }: { remotes: RemoteHostStatus[]; remoteErrors: Record<string, string[]> }) {
  const { t } = useI18n();
  const connected = remotes.filter((remote) => remote.state === 'connected').length;
  return <div className="remote-status">
    <div className="remote-status__head"><span>{t('app.remote.hosts')}</span><span className="remote-status__count">{t('app.remote.connectedCount', { connected, total: remotes.length })}</span></div>
    <ul className="remote-status__list">
      {remotes.map((remote) => {
        const errors = remoteErrors[remote.id] ?? [];
        const state = remoteIndicatorState(remote, errors);
        const title = remoteStatusTitle(remote, errors) + (remote.state !== 'connected' && remote.lastConnectedAt ? `\n${t('app.remote.lastConnected', { time: formatRelative(remote.lastConnectedAt) })}` : '');
        return <li key={remote.id} className={`remote-status__item remote-status__item--${state}`} title={title} aria-label={title}>
          <span className="remote-status__dot" aria-hidden="true" /><span className="remote-status__label">{remote.label}</span>
        </li>;
      })}
    </ul>
  </div>;
}

function Sidebar({ runs, agents, selectedRunId, loadedRunId, runTokenSummaries, onSelectRun, onDemo, usingDemo, watching, errors, loadingRunId, remotes, remoteErrors }: { runs: AgentRun[]; agents: Agent[]; selectedRunId?: string; loadedRunId?: string; runTokenSummaries: Record<string, RunTokenSummary>; onSelectRun: (id: string) => void; onDemo: () => void; usingDemo: boolean; watching: boolean; errors: string[]; loadingRunId?: string; remotes: RemoteHostStatus[]; remoteErrors: Record<string, string[]> }) {
  const { t } = useI18n();
  const remotesConfigured = remotes.length > 0;
  const watcherTitle = usingDemo ? t('app.sidebar.watcherDemo') : watching ? t('app.sidebar.watcherActive') : t('app.sidebar.watcherPaused');
  const watcherSubtitle = usingDemo ? t('app.sidebar.subtitleDemo') : errors.length ? t('app.sidebar.subtitleIssues', { count: errors.length }) : watching ? t('app.sidebar.subtitleListening') : t('app.sidebar.subtitleConnected');
  return (
    <aside className="sidebar">
      <div className="brand"><div className="brand__name">Agent Monitor</div></div>
      <div className="sidebar__nav"><button type="button" className="sidebar-link sidebar-link--active">{t('app.sidebar.overview')}<span className="sidebar-link__shortcut">⌘ 1</span></button><button type="button" className="sidebar-link">{t('app.sidebar.topology')}<span className="sidebar-link__count">{agents.length}</span></button></div>
      <div className="sidebar__section">
        <div className="sidebar__section-head"><span>{t('app.sidebar.recentRuns')}</span><span className="sidebar__section-count">{runs.length}</span></div>
        <div className="run-list">
          {runs.map((run) => {
            const selected = run.id === selectedRunId;
            const loading = run.id === loadingRunId;
            const summary = runTokenSummaries[run.id];
            const loaded = run.id === loadedRunId && !loadingRunId;
            const hostLabel = runHostLabel(run, remotesConfigured);
            const tokenTotal = (summary?.input ?? 0) + (summary?.output ?? 0);
            const stale = Boolean(summary && !loaded && run.lastActivityAt && summary.lastActivityAt && run.lastActivityAt > summary.lastActivityAt);
            const tokenTitle = loaded
              ? t('app.sidebar.tokensLoaded')
              : summary
                ? stale
                  ? t('app.sidebar.tokensStale')
                  : t('app.sidebar.tokensSnapshot')
                : t('app.sidebar.tokensUnknown');
            return <button key={run.id} type="button" className={`run-item ${selected ? 'run-item--selected' : ''} ${loading ? 'run-item--loading' : ''}`} onClick={() => onSelectRun(run.id)} aria-busy={loading}>
              <span className="run-item__body">
                <span className="run-item__title"><strong>{providerLabel(run.harness)}</strong><span>{t('app.sidebar.agentCount', { count: runAgentCount(run, agents) })}</span>{hostLabel && <span className={`host-tag ${run.host ? 'host-tag--remote' : ''}`} title={run.host ? t('app.sidebar.hostRemote', { host: run.host }) : t('app.sidebar.hostLocal')}>{hostLabel}</span>}</span>
                <span className="run-item__path" title={run.cwd || run.title || t('app.sidebar.currentWorkspace')}>{run.title || run.cwd?.split('/').filter(Boolean).pop() || t('app.sidebar.currentWorkspace')}</span>
                <span className="run-item__meta">
                  <span className="run-item__time">{loading ? t('app.sidebar.loadingAgents') : formatRelative(run.lastActivityAt ?? run.startedAt)}</span>
                  <span className={`run-item__tokens ${!summary && !loaded ? 'run-item__tokens--unknown' : ''} ${stale ? 'run-item__tokens--stale' : ''}`} title={tokenTitle}>
                    {loaded || summary ? <><RollingNumber value={tokenTotal} /> {t('app.sidebar.tokens')}{stale ? ` · ${t('app.sidebar.lastLoaded')}` : ''}</> : t('app.sidebar.loadToSee')}
                  </span>
                </span>
              </span>
              <span className={`run-item__signal ${selected ? 'run-item__signal--active' : ''}`} />
            </button>;
          })}
        </div>
        {!runs.length && <div className="sidebar__empty">{t('app.sidebar.noRuns')}</div>}
      </div>
      <div className="sidebar__bottom">{remotesConfigured && !usingDemo && <RemoteStatusList remotes={remotes} remoteErrors={remoteErrors} />}<div className="sidebar__watching"><span className={`watching-dot ${usingDemo ? 'watching-dot--demo' : ''} ${!usingDemo && errors.length ? 'watching-dot--warning' : ''}`} /><div><strong>{watcherTitle}</strong><span>{watcherSubtitle}</span></div><button type="button" title={t('app.sidebar.loadDemoTitle')} onClick={onDemo}>{t('app.sidebar.demo')}</button></div><div className="sidebar__tip"><span>{t('app.sidebar.tip')}</span></div></div>
    </aside>
  );
}

function App() {
  const { t } = useI18n();
  const [traceTabs, setTraceTabs] = useState<Agent[]>([]);
  const [activeTraceId, setActiveTraceId] = useState<string | null>(null);
  const [runTokenSummaries, setRunTokenSummaries] = useState<Record<string, RunTokenSummary>>({});
  const openTrace = useCallback((agent: Agent) => {
    setTraceTabs(tabs => tabs.some(tab => tab.id === agent.id) ? tabs : [...tabs, agent]);
    setActiveTraceId(agent.id);
  }, []);
  const openTraces = useCallback((agentsToOpen: Agent[]) => {
    setTraceTabs(tabs => [...tabs, ...agentsToOpen.filter(agent => !tabs.some(tab => tab.id === agent.id))]);
  }, []);
  const closeTrace = (id: string) => {
    setTraceTabs(tabs => tabs.filter(tab => tab.id !== id));
    if (activeTraceId === id) setActiveTraceId(null);
  };
  const { snapshot: sourceSnapshot, mode, setDemo, setLive, usingDemo, loadedRunId, loadingRunId, runLoadError, loadRun } = useMonitorSnapshot();
  const { providerFilter, hostFilter, selectedRunId, selectedAgentId, setProviderFilter, setHostFilter, resetHostFilter, selectRun, selectAgent } = useDashboardStore();
  const remotes = useMemo(() => sourceSnapshot.remotes ?? [], [sourceSnapshot.remotes]);
  const remotesConfigured = remotes.length > 0;
  const hostOptions = useMemo(() => buildHostOptions(remotes), [remotes]);
  const effectiveHostFilter = resolveHostFilter(hostFilter, remotes);

  const runs = useMemo(() => filterRunsByHost(sourceSnapshot.runs.filter((run) => providerFilter === 'all' || run.harness === providerFilter), effectiveHostFilter).sort(runSort), [effectiveHostFilter, providerFilter, sourceSnapshot.runs]);
  const selectedRun = runs.find((run) => run.id === selectedRunId);
  const agents = useMemo(() => filterAgentsByHost(sourceSnapshot.agents.filter((agent) => providerFilter === 'all' || agent.harness === providerFilter), sourceSnapshot.runs, effectiveHostFilter), [effectiveHostFilter, providerFilter, sourceSnapshot.agents, sourceSnapshot.runs]);
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId);
  const expandedAgent = activeTraceId ? agents.find(agent => agent.id === activeTraceId) ?? traceTabs.find(agent => agent.id === activeTraceId) : undefined;

  const loadedRunAgents = useMemo(
    () => loadedRunId ? sourceSnapshot.agents.filter((agent) => agent.runId === loadedRunId) : [],
    [loadedRunId, sourceSnapshot.agents],
  );
  const loadedRunMetadata = useMemo(
    () => loadedRunId ? sourceSnapshot.runs.find((run) => run.id === loadedRunId) : undefined,
    [loadedRunId, sourceSnapshot.runs],
  );

  useEffect(() => {
    if (!loadedRunId || !loadedRunMetadata || loadingRunId || !loadedRunAgents.length) return;
    const totals = loadedRunAgents.reduce((sum, agent) => ({
      input: sum.input + agent.stats.inputTokens,
      output: sum.output + agent.stats.outputTokens,
    }), { input: 0, output: 0 });
    setRunTokenSummaries((previous) => {
      const existing = previous[loadedRunId];
      if (existing
        && existing.input === totals.input
        && existing.output === totals.output
        && existing.lastActivityAt === loadedRunMetadata.lastActivityAt) {
        return previous;
      }
      return {
        ...previous,
        [loadedRunId]: {
          ...totals,
          lastLoadedAt: now(),
          lastActivityAt: loadedRunMetadata.lastActivityAt,
        },
      };
    });
  }, [loadedRunAgents, loadedRunId, loadedRunMetadata, loadingRunId]);

  useEffect(() => {
    // A host removed from the config should not leave a dangling filter behind if it comes back later.
    if (mode === 'live' && hostFilter !== effectiveHostFilter) resetHostFilter();
  }, [effectiveHostFilter, hostFilter, mode, resetHostFilter]);

  useEffect(() => {
    if (selectedRunId && !runs.some((run) => run.id === selectedRunId)) {
      selectRun(undefined);
      selectAgent(null);
    }
  }, [runs, selectedRunId, selectAgent, selectRun]);

  useEffect(() => {
    if (selectedAgentId && agents.some((agent) => agent.id === selectedAgentId)) return;
    selectAgent(null);
  }, [agents, selectedAgentId, selectAgent]);

  const runIsLoaded = Boolean(selectedRun && loadedRunId === selectedRun.id);
  const runAgents = runIsLoaded && selectedRun ? agents.filter((agent) => agent.runId === selectedRun.id) : [];
  const runEdges = selectedRun ? sourceSnapshot.edges.filter((edge) => runAgents.some((agent) => agent.id === edge.source) && runAgents.some((agent) => agent.id === edge.target)) : [];
  const hasGraph = Boolean(runIsLoaded && runAgents.length);
  const showRunTokens = hasGraph && loadingRunId !== selectedRun?.id;
  const watcherLive = mode === 'live' && sourceSnapshot.watching;
  const health = useMemo(() => assessMonitorHealth({ errors: sourceSnapshot.errors, remotes, watching: sourceSnapshot.watching }), [remotes, sourceSnapshot.errors, sourceSnapshot.watching]);
  const monitorErrors = health.visibleErrors;
  const monitorHasErrors = mode !== 'demo' && health.warning;
  const liveBadgeTitle = remotesConfigured && mode !== 'demo' ? t('app.remote.hostsConnected', { count: health.totalRemotes, connected: health.connectedRemotes, total: health.totalRemotes }) : undefined;
  const isWatching = watcherLive || mode === 'demo';
  const statusLabel = mode === 'demo'
    ? t('app.topbar.statusDemo')
    : mode === 'loading'
      ? t('app.topbar.statusConnecting')
      : mode === 'offline'
        ? t('app.topbar.statusOffline')
        : sourceSnapshot.watching
          ? monitorHasErrors ? t('app.topbar.statusLiveIssues') : t('app.topbar.statusLive')
          : t('app.topbar.statusConnected');

  const handleDemo = useCallback(() => {
    setTraceTabs([]);
    setActiveTraceId(null);
    setDemo();
    selectRun(DEMO_SNAPSHOT.runs[0]?.id);
    selectAgent(null);
  }, [selectAgent, selectRun, setDemo]);

  const handleRunSelect = useCallback((runId: string) => {
    setTraceTabs([]);
    setActiveTraceId(null);
    selectRun(runId);
    selectAgent(null);
    void loadRun(runId);
  }, [loadRun, selectAgent, selectRun]);

  const handleReturnLive = useCallback(() => {
    setTraceTabs([]);
    setActiveTraceId(null);
    setLive();
    selectRun(undefined);
    selectAgent(null);
  }, [selectAgent, selectRun, setLive]);

  return (
    <div className="app-shell">
      {!expandedAgent && <Sidebar runs={runs} agents={agents} selectedRunId={selectedRun?.id} loadedRunId={loadedRunId} runTokenSummaries={runTokenSummaries} onSelectRun={handleRunSelect} onDemo={handleDemo} usingDemo={usingDemo} watching={sourceSnapshot.watching} errors={health.localErrors} loadingRunId={loadingRunId} remotes={remotes} remoteErrors={health.remoteErrors} />}
      <main className="workspace">
        <header className={`topbar ${hostOptions.length > 0 ? 'topbar--with-host' : ''}`}><div className="topbar__context"><span className="topbar__section-label">{t('app.topbar.workspace')}</span><span className="topbar__slash">/</span><span className="topbar__current">{selectedRun?.cwd?.split('/').filter(Boolean).pop() || t('app.topbar.agentActivity')}</span></div><div className="topbar__controls"><ServersControl remotes={usingDemo ? undefined : remotes} /><ThemeSelector /><LanguageSelector /><Dropdown label={t('app.topbar.provider')} value={providerFilter} options={PROVIDERS.map(provider => ({ value: provider.value, label: provider.labelKey ? t(provider.labelKey) : provider.label ?? '' }))} onChange={value => setProviderFilter(value as ProviderFilter)} />{hostOptions.length > 0 && <Dropdown label={t('app.topbar.host')} value={effectiveHostFilter} options={hostOptions} onChange={setHostFilter} />}<Dropdown label={t('app.topbar.run')} value={selectedRun?.id ?? ''} placeholder={t('app.topbar.selectRun')} wide options={runs.map(run => { const host = runHostLabel(run, remotesConfigured); return { value: run.id, label: run.title || run.cwd?.split('/').filter(Boolean).pop() || t('app.topbar.workspaceFallback'), description: `${host ? `${host} · ` : ''}${providerLabel(run.harness)} · ${t('app.sidebar.agentCount', { count: runAgentCount(run, agents) })} · ${formatRelative(run.lastActivityAt ?? run.startedAt)}` }; })} onChange={handleRunSelect} /><span className={`live-badge live-badge--${mode} ${monitorHasErrors ? 'live-badge--warning' : ''}`} title={liveBadgeTitle}>{isWatching ? <Radio size={13} className="live-badge__radio" /> : monitorHasErrors ? <TriangleAlert size={13} /> : <CircleDot size={13} />}{statusLabel}</span>{usingDemo && <button type="button" className="button button--tiny" onClick={handleReturnLive} disabled={!window.agentMonitor}>{t('app.topbar.returnLive')}</button>}</div></header>
        {traceTabs.length > 0 && <div className="workspace-tabs" role="tablist" aria-label={t('app.tabs.views')} onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
          const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
          if (index < 0) return;
          event.preventDefault();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
          tabs[next]?.focus(); tabs[next]?.click();
        }}>
          <button type="button" role="tab" className="workspace-tab" aria-selected={!activeTraceId} aria-controls="graph-panel" onClick={() => setActiveTraceId(null)}>{t('app.tabs.graph')}</button>
          {traceTabs.map(agent => <div className="workspace-tab-group" data-active={agent.id === activeTraceId} key={agent.id}>
            <button type="button" role="tab" className="workspace-tab workspace-tab--trace" aria-selected={agent.id === activeTraceId} aria-controls="expanded-trace-panel" onClick={() => setActiveTraceId(agent.id)} title={agent.nickname || agent.role || t('app.agent.main')}>{t('app.tabs.trace', { name: agent.nickname || agent.role || t('app.agent.main') })}</button>
            <button type="button" className="workspace-tab-close" aria-label={t('app.tabs.closeTrace', { name: agent.nickname || agent.role || t('app.agent.main') })} onClick={() => closeTrace(agent.id)}><X size={13} /></button>
          </div>)}
        </div>}
        <div id="graph-panel" className="workspace-graph-view" style={expandedAgent ? { display: 'none' } : undefined}>
        <div className="workspace__subbar"><div><h1>{t('app.subbar.title')}</h1><p>{selectedRun && runIsLoaded ? t('app.subbar.summary', { count: runAgents.length, agents: runAgents.length, edges: runEdges.length }) : selectedRun ? t('app.subbar.runLoading') : t('app.subbar.selectRun')}</p></div><div className="workspace__subbar-center">{showRunTokens && <RunTokenDetails key={selectedRun?.id} agents={runAgents} />}</div><div className="workspace__subbar-right"><span className="refresh-label"><RefreshCw size={12} className={isWatching ? 'refresh-label__spin' : ''} />{monitorHasErrors ? t('app.sidebar.subtitleIssues', { count: monitorErrors.length }) : loadingRunId ? t('app.subbar.loadingSelected') : isWatching ? t('app.subbar.updated', { time: formatRelative(selectedRun?.lastActivityAt) }) : mode === 'live' ? t('app.subbar.watcherPaused') : t('app.subbar.waiting')}</span><button type="button" className="icon-button icon-button--search" title={t('app.subbar.searchAgents')}><Search size={16} /></button></div></div>
        {monitorHasErrors && monitorErrors.length > 0 && <div className="monitor-error-strip" role="status"><TriangleAlert size={14} /><span><strong>{t('app.subbar.issueLabel', { count: monitorErrors.length })}</strong> {monitorErrors[0]}</span>{monitorErrors.length > 1 && <span className="monitor-error-strip__count">{t('app.subbar.more', { count: monitorErrors.length - 1 })}</span>}</div>}
        <div className="workspace__body">
          <section className={`canvas-panel ${selectedAgent ? 'canvas-panel--with-details' : ''}`}>
            {hasGraph ? <AgentGraph runId={selectedRun?.id} agents={runAgents} edges={runEdges} selectedAgentId={selectedAgentId} onSelectAgent={selectAgent} onOpenTrace={openTrace} /> : <EmptyGraph mode={mode} selectedRun={selectedRun} loading={Boolean(loadingRunId && loadingRunId === selectedRun?.id)} loadError={selectedRun?.id === selectedRunId ? runLoadError : undefined} onDemo={handleDemo} onRetry={selectedRun ? () => handleRunSelect(selectedRun.id) : undefined} />}
          </section>
          {selectedAgent && <AgentDetails agent={selectedAgent} onClose={() => selectAgent(null)} onExpand={openTrace} mode={mode} />}
        </div>
        </div>
        {expandedAgent && <div id="expanded-trace-panel" role="tabpanel" aria-label={t('app.tabs.expandedTrace')} className="workspace-trace-panel"><TraceWorkspace key={expandedAgent.id} agent={expandedAgent} agents={agents.filter(agent => agent.runId === expandedAgent.runId)} onOpenAgent={openTrace} onOpenAgents={openTraces} demo={usingDemo} /></div>}
      </main>
    </div>
  );
}

export default App;

import {
  Activity,
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Inbox,
  Laptop,
  LoaderCircle,
  Maximize2,
  Network,
  PanelRightClose,
  PauseCircle,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  SquareArrowOutUpRight,
  Target,
  TriangleAlert,
  Unplug,
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
import { Dropdown } from './Dropdown';
import { TraceWorkspace } from './TraceWorkspace';
import { RollingNumber } from './RollingNumber';
import { RunTokenDetails } from './RunTokenDetails';
import { useNumberFormat } from './numberFormat';
import { DateRangePicker } from './DateRangePicker';
import { activeRunIds, filterRunsByRange, readRunRange, saveRunRange, type RunRange } from './runFilter';
import { formatNumber, formatRelativeTime, t, useI18n, type MessageKey } from './i18n';
import { SettingsPage, settingsShortcut, type MonitorMode } from './SettingsPage';
import { assessMonitorHealth, groupRunsBySource, readCollapsedGroups, remoteIndicatorState, remoteStatusTitle, saveCollapsedGroups, toggleGroup, type RemoteIndicatorState } from './remoteUi';
import './TraceTabs.css';

type SourceMode = MonitorMode;
import type { ProviderFilter, SettingsSection } from './store';

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

function useMonitorSnapshot() {
  const [snapshot, setNativeSnapshot] = useState<MonitorSnapshot>(EMPTY_SNAPSHOT);
  const [mode, setMode] = useState<SourceMode>(() => (typeof window !== 'undefined' && window.agentMonitor ? 'loading' : 'offline'));
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

  const loadRun = useCallback(async (runId: string) => {
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
  }, []);

  return { snapshot, mode, loadedRunId, loadingRunId, runLoadError, loadRun };
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
  const { count, title } = useNumberFormat();
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
        <div><span>{t('app.agent.metricIn')}</span><strong title={title(agent.stats.inputTokens)}>{count(agent.stats.inputTokens)}</strong></div>
        <div><span>{t('app.agent.metricOut')}</span><strong title={title(agent.stats.outputTokens)}>{count(agent.stats.outputTokens)}</strong></div>
        <div><span>{t('app.agent.metricTools')}</span><strong>{formatNumber(agent.stats.toolCalls)}</strong></div>
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

type EmptyKind = 'loading-run' | 'error' | 'offline' | 'connecting' | 'no-sessions' | 'filtered' | 'no-run' | 'waiting';

function EmptyGraph({ mode, selectedRun, hasRuns, hasAnyRuns, providerName, loading, loadError, onRetry, onOpenSettings }: {
  mode: SourceMode; selectedRun?: AgentRun; hasRuns: boolean; hasAnyRuns: boolean; providerName: string; loading: boolean; loadError?: string;
  onRetry?: () => void; onOpenSettings: (section: SettingsSection) => void;
}) {
  const { t } = useI18n();
  const kind: EmptyKind = loading ? 'loading-run'
    : loadError ? 'error'
      : mode === 'offline' ? 'offline'
        : mode === 'loading' ? 'connecting'
          : !hasAnyRuns ? 'no-sessions'
            : !hasRuns ? 'filtered'
              : !selectedRun ? 'no-run' : 'waiting';
  const copy: Record<EmptyKind, [string, string]> = {
    'loading-run': [t('app.empty.loadingTitle'), t('app.empty.loadingBody')],
    error: [t('app.empty.errorTitle'), loadError ?? ''],
    offline: [t('app.empty.offlineTitle'), t('app.empty.offlineBody')],
    connecting: [t('app.empty.connectingTitle'), t('app.empty.connectingBody')],
    'no-sessions': [t('app.empty.noSessionsTitle'), t('app.empty.noSessionsBody')],
    filtered: [t('app.empty.noSessionsTitle'), t('app.empty.noSessionsFiltered', { provider: providerName })],
    'no-run': [t('app.empty.noRunTitle'), t('app.empty.noRunBody')],
    waiting: [t('app.empty.waitingTitle'), t('app.empty.waitingBody')],
  };
  const [title, description] = copy[kind];
  const glyph = kind === 'loading-run' || kind === 'connecting' ? <LoaderCircle size={30} strokeWidth={1.4} className="spin" />
    : kind === 'error' ? <TriangleAlert size={30} strokeWidth={1.4} />
      : kind === 'offline' ? <Unplug size={30} strokeWidth={1.4} />
        : kind === 'no-sessions' || kind === 'filtered' ? <Inbox size={30} strokeWidth={1.4} /> : null;
  return (
    <div className={`empty-state empty-state--${kind}`}>
      {glyph && <div className="empty-state__glyph">{glyph}</div>}
      <h2>{title}</h2>
      <p>{description}</p>
      {kind === 'error' && onRetry && <button type="button" className="button button--primary" onClick={onRetry}><RefreshCw size={15} />{t('app.empty.retry')}</button>}
      {kind === 'no-sessions' && <div className="empty-state__actions">
        <button type="button" className="button button--primary" onClick={() => onOpenSettings('servers')}><Plus size={15} />{t('app.empty.addServer')}</button>
        <button type="button" className="button" onClick={() => onOpenSettings('local')}><Laptop size={15} />{t('app.empty.localSources')}</button>
      </div>}
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

function Metric({ label, value, title }: { label: string; value: string; title?: string }) {
  return <div className="detail-metric"><span>{label}</span><strong title={title}>{value}</strong></div>;
}

function AgentDetails({ agent, onClose, onExpand }: { agent?: Agent; onClose: () => void; onExpand: (agent: Agent) => void }) {
  const { t } = useI18n();
  const { count, title: exactTitle } = useNumberFormat();
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
    if (!bridge) {
      setTrace([]);
      setTraceError(t('app.trace.loadFailed'));
      setLoadingTrace(false);
      return () => { cancelled = true; };
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
  }, [agentId, refreshNonce]);

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
      <section className="details-section"><div className="details-section__label">{t('app.details.usage')}</div><div className="detail-metric-grid"><Metric label={t('app.details.input')} value={count(agent.stats.inputTokens)} title={exactTitle(agent.stats.inputTokens)} /><Metric label={t('app.details.output')} value={count(agent.stats.outputTokens)} title={exactTitle(agent.stats.outputTokens)} /><Metric label={t('app.details.toolCalls')} value={formatNumber(agent.stats.toolCalls)} /><Metric label={t('app.details.errors')} value={formatNumber(agent.stats.errors)} /></div></section>
      <section className="details-section details-section--trace"><div className="details-section__title"><div><div className="details-section__label">{t('app.details.normalizedTrace')}</div><span>{t('app.details.liveEvents')}</span></div><button type="button" className="trace-open-button" title={t('app.details.refreshTrace')} onClick={() => setRefreshNonce((value) => value + 1)}><RefreshCw size={13} /></button></div>{traceError ? <div className="trace-placeholder trace-placeholder--error"><AlertCircle size={14} />{traceError}</div> : <TraceList entries={trace} loading={loadingTrace} />}</section>
      <div className="details-pane__footer"><span><CircleDot size={11} />{agent.threadId ? t('app.details.thread', { id: agent.threadId.slice(0, 12) }) : t('app.details.threadUnavailable')}</span><button type="button" className="button button--quiet" onClick={() => onExpand(agent)}>{t('app.details.openTraceTab')}</button></div>
    </aside>
  );
}

type GroupDot = RemoteIndicatorState | 'unknown';

type SidebarProps = {
  /** Runs within the time range (plus active and selected ones). */
  runs: AgentRun[];
  /** Every run, to tell an empty group from one whose runs the time range hides. */
  allRuns: AgentRun[];
  timeRange: RunRange;
  onTimeRange: (range: RunRange) => void;
  agents: Agent[];
  selectedRunId?: string;
  loadedRunId?: string;
  runTokenSummaries: Record<string, RunTokenSummary>;
  onSelectRun: (id: string) => void;
  loadingRunId?: string;
  mode: SourceMode;
  watching: boolean;
  localErrors: string[];
  remotes: RemoteHostStatus[];
  remoteErrors: Record<string, string[]>;
  onOpenSettings: () => void;
  shortcut: string;
  style?: CSSProperties;
};

function Sidebar({ runs, allRuns, timeRange, onTimeRange, agents, selectedRunId, loadedRunId, runTokenSummaries, onSelectRun, loadingRunId, mode, watching, localErrors, remotes, remoteErrors, onOpenSettings, shortcut, style }: SidebarProps) {
  const { t } = useI18n();
  const groups = useMemo(() => groupRunsBySource(runs, remotes), [remotes, runs]);
  const totals = useMemo(() => new Map(groupRunsBySource(allRuns, remotes).map((group) => [group.id, group.runs.length])), [allRuns, remotes]);
  const [collapsed, setCollapsed] = useState(() => readCollapsedGroups());
  const toggle = (id: string) => setCollapsed((current) => {
    const next = toggleGroup(current, id);
    saveCollapsedGroups(next);
    return next;
  });

  function renderRun(run: AgentRun) {
    const selected = run.id === selectedRunId;
    const loading = run.id === loadingRunId;
    const summary = runTokenSummaries[run.id];
    const loaded = run.id === loadedRunId && !loadingRunId;
    const tokenTotal = (summary?.input ?? 0) + (summary?.output ?? 0);
    const stale = Boolean(summary && !loaded && run.lastActivityAt && summary.lastActivityAt && run.lastActivityAt > summary.lastActivityAt);
    const tokenTitle = loaded
      ? t('app.sidebar.tokensLoaded')
      : summary
        ? stale
          ? t('app.sidebar.tokensStale')
          : t('app.sidebar.tokensSnapshot')
        : t('app.sidebar.tokensUnknown');
    return <button key={run.id} type="button" className={`run-item ${selected ? 'run-item--selected' : ''} ${loading ? 'run-item--loading' : ''}`} onClick={() => onSelectRun(run.id)} aria-busy={loading} aria-current={selected ? 'true' : undefined}>
      <span className="run-item__body">
        <span className="run-item__title"><strong>{providerLabel(run.harness)}</strong><span>{t('app.sidebar.agentCount', { count: runAgentCount(run, agents) })}</span></span>
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
  }

  return (
    <aside className="sidebar" style={style}>
      <div className="brand"><div className="brand__name">Agent Monitor</div></div>
      <div className="sidebar__nav"><button type="button" className="sidebar-link sidebar-link--active">{t('app.sidebar.overview')}<span className="sidebar-link__shortcut">⌘ 1</span></button><button type="button" className="sidebar-link">{t('app.sidebar.topology')}<span className="sidebar-link__count">{agents.length}</span></button></div>
      <div className="sidebar__section">
        <div className="sidebar__section-head">
          <span>{t('app.sidebar.recentRuns')}</span>
          <DateRangePicker value={timeRange} onChange={onTimeRange} />
          <span className="sidebar__section-count">{runs.length}</span>
        </div>
        {groups.map((group) => {
          const open = !collapsed.has(group.id);
          const name = group.kind === 'local' ? t('remote.local') : group.label;
          const remote = group.remote;
          const errors = remote ? remoteErrors[remote.id] ?? [] : [];
          let dot: GroupDot;
          let title: string;
          let emptyText: string;
          if (group.kind === 'local') {
            dot = mode === 'loading' ? 'connecting' : mode !== 'live' ? 'unknown' : localErrors.length ? 'warning' : watching ? 'connected' : 'unknown';
            title = [t('app.sidebar.localGroupTitle'), mode === 'live' ? (watching ? t('app.topbar.localWatcherActive') : t('app.topbar.localWatcherPaused')) : undefined, ...localErrors].filter(Boolean).join('\n');
            emptyText = t('app.sidebar.noRuns');
          } else if (remote) {
            dot = remoteIndicatorState(remote, errors);
            title = remoteStatusTitle(remote, errors) + (remote.state !== 'connected' && remote.lastConnectedAt ? `\n${t('app.remote.lastConnected', { time: formatRelative(remote.lastConnectedAt) })}` : '');
            emptyText = remote.state === 'error' ? remote.error ?? errors[0]?.slice(remote.label.length + 3) ?? t('remote.connectionError') : remote.state === 'connecting' ? t('app.sidebar.groupNotConnected') : t('app.sidebar.groupEmpty');
          } else {
            dot = 'unknown';
            title = name;
            emptyText = t('app.sidebar.groupEmpty');
          }
          // Runs exist but are older than the time range: say so instead of "no runs".
          if (!group.runs.length && (totals.get(group.id) ?? 0) > 0 && dot !== 'error') emptyText = t(`app.sidebar.range.${timeRange.kind}.empty`);
          const listId = `run-group-${group.id}`;
          return <section key={group.id} className={`run-group run-group--${dot}`}>
            <button type="button" className="run-group__head" aria-expanded={open} aria-controls={listId} title={title} aria-label={`${open ? t('app.sidebar.collapseGroup', { name }) : t('app.sidebar.expandGroup', { name })}. ${title.split('\n').slice(1).join('. ')}`.trim()} onClick={() => toggle(group.id)}>
              <ChevronRight size={13} className="run-group__chevron" aria-hidden="true" />
              <span className="status-dot" aria-hidden="true" />
              <span className="run-group__name">{name}</span>
              <span className="run-group__count">{group.runs.length}</span>
            </button>
            {open && <div id={listId} className="run-list">
              {group.runs.map(renderRun)}
              {!group.runs.length && <div className={`run-group__empty${dot === 'error' ? ' run-group__empty--error' : ''}`} title={emptyText}>{emptyText}</div>}
            </div>}
          </section>;
        })}
      </div>
      <div className="sidebar__footer">
        <button type="button" className="sidebar-link sidebar__settings" onClick={onOpenSettings} title={t('settings.open', { shortcut })}><SettingsIcon size={15} aria-hidden="true" />{t('app.sidebar.settings')}<span className="sidebar-link__shortcut">{shortcut}</span></button>
      </div>
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
  const { snapshot: sourceSnapshot, mode, loadedRunId, loadingRunId, runLoadError, loadRun } = useMonitorSnapshot();
  const { providerFilter, selectedRunId, selectedAgentId, settingsSection, setProviderFilter, selectRun, selectAgent, openSettings, closeSettings } = useDashboardStore();
  const bridge = typeof window !== 'undefined' ? window.agentMonitor : undefined;
  const shortcut = settingsShortcut(bridge?.platform);
  const remotes = useMemo(() => sourceSnapshot.remotes ?? [], [sourceSnapshot.remotes]);
  const remotesConfigured = remotes.length > 0;

  const runs = useMemo(() => sourceSnapshot.runs.filter((run) => providerFilter === 'all' || run.harness === providerFilter).sort(runSort), [providerFilter, sourceSnapshot.runs]);
  const [timeRange, setTimeRange] = useState<RunRange>(() => readRunRange());
  // Only presets are remembered; a custom range lasts for this session.
  const changeTimeRange = useCallback((range: RunRange) => { setTimeRange(range); saveRunRange(range); }, []);
  // Re-filter once a minute so rolling ranges move without waiting for a snapshot.
  const [clock, setClock] = useState(now);
  useEffect(() => {
    const timer = window.setInterval(() => setClock(now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const liveRunIds = useMemo(() => activeRunIds(sourceSnapshot.agents), [sourceSnapshot.agents]);
  const recentRuns = useMemo(() => filterRunsByRange(runs, timeRange, { now: clock, activeRunIds: liveRunIds, selectedRunId }), [clock, liveRunIds, runs, selectedRunId, timeRange]);
  const selectedRun = runs.find((run) => run.id === selectedRunId);
  const agents = useMemo(() => sourceSnapshot.agents.filter((agent) => providerFilter === 'all' || agent.harness === providerFilter), [providerFilter, sourceSnapshot.agents]);
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
    if (selectedRunId && !runs.some((run) => run.id === selectedRunId)) {
      selectRun(undefined);
      selectAgent(null);
    }
  }, [runs, selectedRunId, selectAgent, selectRun]);

  useEffect(() => {
    if (selectedAgentId && agents.some((agent) => agent.id === selectedAgentId)) return;
    selectAgent(null);
  }, [agents, selectedAgentId, selectAgent]);

  // ⌘, / Ctrl+, toggles the settings page from anywhere.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== ',' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      if (useDashboardStore.getState().settingsSection) closeSettings(); else openSettings();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [closeSettings, openSettings]);

  // Leaving settings puts focus back on the sidebar's settings button rather than the document body.
  const settingsWasOpen = useRef(false);
  useEffect(() => {
    if (settingsWasOpen.current && !settingsSection) document.querySelector<HTMLElement>('.sidebar__settings')?.focus({ preventScroll: true });
    settingsWasOpen.current = Boolean(settingsSection);
  }, [settingsSection]);

  const runIsLoaded = Boolean(selectedRun && loadedRunId === selectedRun.id);
  const runAgents = runIsLoaded && selectedRun ? agents.filter((agent) => agent.runId === selectedRun.id) : [];
  const runEdges = selectedRun ? sourceSnapshot.edges.filter((edge) => runAgents.some((agent) => agent.id === edge.source) && runAgents.some((agent) => agent.id === edge.target)) : [];
  const hasGraph = Boolean(runIsLoaded && runAgents.length);
  const showRunTokens = hasGraph && loadingRunId !== selectedRun?.id;
  const isWatching = mode === 'live' && sourceSnapshot.watching;
  const health = useMemo(() => assessMonitorHealth({ errors: sourceSnapshot.errors, remotes, watching: sourceSnapshot.watching }), [remotes, sourceSnapshot.errors, sourceSnapshot.watching]);
  const monitorErrors = health.visibleErrors;
  const monitorHasErrors = mode === 'live' && health.warning;
  const liveBadgeTitle = mode === 'live' ? [
    sourceSnapshot.watching ? t('app.topbar.localWatcherActive') : t('app.topbar.localWatcherPaused'),
    health.localErrors.length ? t('app.sidebar.subtitleIssues', { count: health.localErrors.length }) : undefined,
    remotesConfigured ? t('app.remote.hostsConnected', { count: health.totalRemotes, connected: health.connectedRemotes, total: health.totalRemotes }) : undefined,
  ].filter(Boolean).join('\n') : undefined;
  const statusLabel = mode === 'loading'
    ? t('app.topbar.statusConnecting')
    : mode === 'offline'
      ? t('app.topbar.statusOffline')
      : sourceSnapshot.watching
        ? monitorHasErrors ? t('app.topbar.statusLiveIssues') : t('app.topbar.statusLive')
        : t('app.topbar.statusConnected');
  const providerName = PROVIDERS.find((provider) => provider.value === providerFilter);

  const handleRunSelect = useCallback((runId: string) => {
    setTraceTabs([]);
    setActiveTraceId(null);
    selectRun(runId);
    selectAgent(null);
    void loadRun(runId);
  }, [loadRun, selectAgent, selectRun]);

  const hidden = settingsSection ? { display: 'none' } : undefined;
  return (
    <div className="app-shell">
      {settingsSection && <SettingsPage bridge={bridge} section={settingsSection} onSection={openSettings} onClose={closeSettings} mode={mode} watching={sourceSnapshot.watching} localErrors={health.localErrors} remotes={remotes} remoteErrors={health.remoteErrors} />}
      {!expandedAgent && <Sidebar style={hidden} runs={recentRuns} allRuns={runs} timeRange={timeRange} onTimeRange={changeTimeRange} agents={agents} selectedRunId={selectedRun?.id} loadedRunId={loadedRunId} runTokenSummaries={runTokenSummaries} onSelectRun={handleRunSelect} loadingRunId={loadingRunId} mode={mode} watching={sourceSnapshot.watching} localErrors={health.localErrors} remotes={remotes} remoteErrors={health.remoteErrors} onOpenSettings={() => openSettings()} shortcut={shortcut} />}
      <main className="workspace" style={hidden}>
        <header className="topbar"><div className="topbar__context"><span className="topbar__section-label">{t('app.topbar.workspace')}</span><span className="topbar__slash">/</span><span className="topbar__current">{selectedRun?.cwd?.split('/').filter(Boolean).pop() || t('app.topbar.agentActivity')}</span></div><div className="topbar__controls"><Dropdown label={t('app.topbar.provider')} value={providerFilter} options={PROVIDERS.map(provider => ({ value: provider.value, label: provider.labelKey ? t(provider.labelKey) : provider.label ?? '' }))} onChange={value => setProviderFilter(value as ProviderFilter)} /><Dropdown label={t('app.topbar.run')} value={selectedRun?.id ?? ''} placeholder={t('app.topbar.selectRun')} wide options={recentRuns.map(run => ({ value: run.id, label: run.title || run.cwd?.split('/').filter(Boolean).pop() || t('app.topbar.workspaceFallback'), description: `${remotesConfigured ? `${run.host ?? t('remote.local')} · ` : ''}${providerLabel(run.harness)} · ${t('app.sidebar.agentCount', { count: runAgentCount(run, agents) })} · ${formatRelative(run.lastActivityAt ?? run.startedAt)}` }))} onChange={handleRunSelect} /><button type="button" className={`live-badge live-badge--${mode} ${monitorHasErrors ? 'live-badge--warning' : ''}`} title={liveBadgeTitle} onClick={() => openSettings('about')}>{isWatching ? <Radio size={13} className="live-badge__radio" /> : monitorHasErrors ? <TriangleAlert size={13} /> : <CircleDot size={13} />}{statusLabel}</button></div></header>
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
            {hasGraph ? <AgentGraph runId={selectedRun?.id} agents={runAgents} edges={runEdges} selectedAgentId={selectedAgentId} onSelectAgent={selectAgent} onOpenTrace={openTrace} /> : <EmptyGraph mode={mode} selectedRun={selectedRun} hasRuns={runs.length > 0} hasAnyRuns={sourceSnapshot.runs.length > 0} providerName={providerName?.labelKey ? t(providerName.labelKey) : providerName?.label ?? ''} loading={Boolean(loadingRunId && loadingRunId === selectedRun?.id)} loadError={selectedRun?.id === selectedRunId ? runLoadError : undefined} onRetry={selectedRun ? () => handleRunSelect(selectedRun.id) : undefined} onOpenSettings={openSettings} />}
          </section>
          {selectedAgent && <AgentDetails agent={selectedAgent} onClose={() => selectAgent(null)} onExpand={openTrace} />}
        </div>
        </div>
        {expandedAgent && <div id="expanded-trace-panel" role="tabpanel" aria-label={t('app.tabs.expandedTrace')} className="workspace-trace-panel"><TraceWorkspace key={expandedAgent.id} agent={expandedAgent} agents={agents.filter(agent => agent.runId === expandedAgent.runId)} onOpenAgent={openTrace} onOpenAgents={openTraces} /></div>}
      </main>
    </div>
  );
}

export default App;

import { useEffect, useId, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowUpRight, Check, ChevronDown, ChevronRight, Copy, Home } from 'lucide-react';
import type { Agent, AgentHarness, TraceEntry } from '../shared/types';
import { formatNumber, t, useI18n, type MessageKey } from './i18n';
import { Dropdown } from './Dropdown';
import { Markdown } from './Markdown';
import {
  conversationDuration,
  conversationUsage,
  filterConversationGroups,
  getToolInput,
  groupTraceEntries,
  type ConversationGroup,
  type ConversationTool,
  type TraceEntryDetails,
} from './traceConversation';
import './TraceWorkspace.css';

const MAX_RECENT_ENTRIES = 200;

const TRACE_KINDS: TraceEntry['kind'][] = ['user', 'assistant', 'thinking', 'tool-call', 'tool-result', 'usage', 'error', 'event'];

const STATUS_COLOR: Record<Agent['status'], string> = {
  starting: 'var(--status-starting)',
  active: 'var(--status-active)',
  idle: 'var(--status-idle)',
  finished: 'var(--status-finished)',
  error: 'var(--status-error)',
};

const HARNESS_LABEL: Record<Exclude<AgentHarness, 'unknown'>, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  pi: 'Pi',
  hermes: 'Hermes',
};

function harnessLabel(harness: AgentHarness) {
  return harness === 'unknown' ? t('trace.harness.unknown') : HARNESS_LABEL[harness];
}

type TraceOrder = 'oldest' | 'newest';
const ORDER_STORAGE_KEY = 'agent-monitor.trace-order';

function readOrder(): TraceOrder {
  try {
    return localStorage.getItem(ORDER_STORAGE_KEY) === 'newest' ? 'newest' : 'oldest';
  } catch {
    return 'oldest';
  }
}

function saveOrder(order: TraceOrder) {
  try { localStorage.setItem(ORDER_STORAGE_KEY, order); } catch { /* Order still applies for this view. */ }
}

type DisclosureProps = {
  openDisclosure: Set<string>;
  onToggle: (key: string) => void;
};

function titleFor(agent: Agent) {
  return agent.nickname || agent.role || (agent.type === 'main' ? t('trace.mainAgent') : t('trace.subagent'));
}

function capitalize(text: string) {
  return text ? text[0].toLocaleUpperCase() + text.slice(1) : text;
}

function subagentLabel(agent: Agent) {
  return `${capitalize(agent.role || t('trace.subagent'))} · ${agent.nickname || agent.id.slice(-8)}`;
}

function isoFor(timestamp: number | undefined) {
  if (!timestamp || !Number.isFinite(timestamp)) return undefined;
  return new Date(timestamp).toISOString();
}

function demoTrace(agent: Agent): TraceEntryDetails[] {
  const base = agent.createdAt ?? Date.now() - 60_000;
  return [
    {
      id: `${agent.id}-demo-discovered`,
      timestamp: base,
      kind: 'event',
      text: t('trace.demo.discovered', { title: titleFor(agent) }),
    },
    {
      id: `${agent.id}-demo-activity`,
      timestamp: agent.lastActivityAt ?? base + 1_000,
      kind: 'assistant',
      text: agent.activity || t('trace.demo.activity'),
      model: agent.model,
      reasoningEffort: agent.reasoningEffort,
      turnId: `${agent.id}-demo-turn`,
    },
    {
      id: `${agent.id}-demo-tool`,
      timestamp: base + 2_000,
      kind: 'tool-call',
      text: 'search: rg --files src tests',
      callId: `${agent.id}-demo-call`,
      toolName: 'search',
    },
    {
      id: `${agent.id}-demo-result`,
      timestamp: base + 3_000,
      kind: 'tool-result',
      text: t('trace.demo.result'),
      callId: `${agent.id}-demo-call`,
    },
  ];
}

function isTextPart(value: unknown): value is { text: string } {
  return typeof value === 'object' && value !== null && typeof (value as { text?: unknown }).text === 'string';
}

function prettyTraceText(text: string) {
  const trimmed = text.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return text;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== 'object') return text;
    // Content-part arrays ([{type:"input_text", text}]) read better as their text.
    if (Array.isArray(parsed) && parsed.length && parsed.every(isTextPart)) {
      return parsed.map((part) => part.text).join('\n');
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return text;
  }
}

function preview(text: string, length = 180) {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > length ? `${compact.slice(0, length - 1)}…` : compact;
}

function groupLabel(kind: ConversationGroup['kind']) {
  if (kind === 'assistant') return t('trace.kind.assistant');
  if (kind === 'user') return t('trace.kind.user');
  if (kind === 'tool') return t('trace.kind.tool-result');
  if (kind === 'usage') return t('trace.kind.usage');
  if (kind === 'error') return t('trace.kind.error');
  return t('trace.kind.event');
}

function toolStatus(tool: ConversationTool) {
  if (!tool.result) return { label: t('trace.tools.noResult'), tone: 'pending' };
  return tool.result.kind === 'error' ? { label: t('trace.tools.error'), tone: 'error' } : { label: t('trace.tools.complete'), tone: 'complete' };
}

export interface TraceWorkspaceProps {
  agent: Agent;
  /** Agents in the same run, used to link parent and subagent traces. */
  agents?: Agent[];
  onOpenAgent?: (agent: Agent) => void;
  /** Opens several traces as tabs without leaving this one. */
  onOpenAgents?: (agents: Agent[]) => void;
  demo?: boolean;
}

export function TraceWorkspace({ agent, agents = [], onOpenAgent, onOpenAgents, demo = false }: TraceWorkspaceProps) {
  const { t } = useI18n();
  const searchId = useId();
  const [entries, setEntries] = useState<TraceEntryDetails[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<MessageKey>();
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<string>('all');
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [order, setOrder] = useState<TraceOrder>(readOrder);
  // Keys the reader toggled away from each disclosure's default state.
  const [openDisclosure, setOpenDisclosure] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    setEntries([]);
    setOpenDisclosure(new Set());

    if (demo) {
      setEntries(demoTrace(agent));
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    const bridge = typeof window === 'undefined' ? undefined : window.agentMonitor;
    if (!bridge) {
      setLoading(false);
      setError('trace.error.unavailable');
      return () => {
        cancelled = true;
      };
    }

    void bridge.getTrace(agent.id)
      .then((nextEntries) => {
        if (cancelled) return;
        setEntries(nextEntries as TraceEntryDetails[]);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setEntries([]);
        setLoading(false);
        setError('trace.error.loadFailed');
      });

    return () => {
      cancelled = true;
    };
  }, [agent.id, demo, refreshNonce]);

  const { locale } = useI18n();
  const kindOptions = useMemo(() => [
    { value: 'all', label: t('trace.kindFilter.all') },
    ...TRACE_KINDS.map((traceKind) => ({ value: traceKind, label: t(`trace.kind.${traceKind}`) })),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [locale]);
  const orderOptions = useMemo(() => [
    { value: 'oldest', label: t('trace.order.oldest') },
    { value: 'newest', label: t('trace.order.newest') },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [locale]);

  const recentEntries = entries.length > MAX_RECENT_ENTRIES ? entries.slice(-MAX_RECENT_ENTRIES) : entries;
  const groups = useMemo(() => groupTraceEntries(recentEntries), [recentEntries]);
  const filteredGroups = useMemo(() => {
    const matches = filterConversationGroups(groups, search, kind);
    return order === 'newest' ? matches.reverse() : matches;
  }, [groups, kind, order, search]);
  const isBounded = entries.length >= MAX_RECENT_ENTRIES;
  const hasFilter = Boolean(search.trim() || kind !== 'all');
  const subagents = agents.filter((candidate) => candidate.parentId === agent.id);
  const parent = agent.parentId ? agents.find((candidate) => candidate.id === agent.parentId) : undefined;

  function toggleDisclosure(key: string) {
    setOpenDisclosure((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function clearFilters() {
    setSearch('');
    setKind('all');
  }

  return (
    <section className="trace-workspace" aria-labelledby={`${searchId}-title`}>
      <div className="trace-workspace__content">
        <div className="trace-workspace__list">
          <TraceHeader
            agent={agent}
            titleId={`${searchId}-title`}
            itemCount={entries.length}
            subagents={subagents}
            parent={parent}
            loading={loading}
            onRefresh={() => setRefreshNonce((value) => value + 1)}
            onOpenAgent={onOpenAgent}
            onOpenAgents={onOpenAgents}
          />

          <div className="trace-workspace__toolbar">
            <div className="trace-workspace__search">
              <input
                id={searchId}
                type="search"
                aria-label={t('trace.search.label')}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t('trace.search.placeholder')}
                autoComplete="off"
              />
            </div>
            <Dropdown label={t('trace.kindFilter.label')} value={kind} options={kindOptions} onChange={setKind} />
            <Dropdown
              label={t('trace.order.label')}
              value={order}
              options={orderOptions}
              onChange={(value) => {
                const next = value === 'newest' ? 'newest' : 'oldest';
                setOrder(next);
                saveOrder(next);
              }}
            />
            <div className="trace-workspace__count" aria-live="polite">
              {t('trace.count', { shown: filteredGroups.length, total: groups.length })}
            </div>
          </div>

          {isBounded && (
            <p className="trace-workspace__notice">
              {t('trace.bounded', { count: Math.min(MAX_RECENT_ENTRIES, entries.length) })}
            </p>
          )}

          {error && (
            <div className="trace-workspace__empty trace-workspace__empty--error" role="alert">
              <p>{t(error)}</p>
              <button type="button" className="trace-workspace__button" onClick={() => setRefreshNonce((value) => value + 1)}>{t('trace.retry')}</button>
            </div>
          )}
          {!error && loading && <div className="trace-workspace__empty" role="status">{t('trace.loading')}</div>}
          {!error && !loading && !groups.length && (
            <div className="trace-workspace__empty">
              <p>{t('trace.empty')}</p>
            </div>
          )}
          {!error && !loading && groups.length > 0 && !filteredGroups.length && (
            <div className="trace-workspace__empty">
              <p>{t('trace.noMatches')}</p>
              {hasFilter && <button type="button" className="trace-workspace__button" onClick={clearFilters}>{t('trace.clearFilters')}</button>}
            </div>
          )}
          {!error && !loading && filteredGroups.length > 0 && (
            <div className="trace-thread" aria-label={t('trace.threadLabel')}>
              {filteredGroups.map((group) => (
                <ConversationCard
                  key={group.id}
                  group={group}
                  openDisclosure={openDisclosure}
                  onToggle={toggleDisclosure}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function TraceHeader({ agent, titleId, itemCount, subagents, parent, loading, onRefresh, onOpenAgent, onOpenAgents }: {
  agent: Agent;
  titleId: string;
  itemCount: number;
  subagents: Agent[];
  parent?: Agent;
  loading: boolean;
  onRefresh: () => void;
  onOpenAgent?: (agent: Agent) => void;
  onOpenAgents?: (agents: Agent[]) => void;
}) {
  const { t } = useI18n();
  const harness = harnessLabel(agent.harness);
  const isMain = agent.type === 'main';
  const modelLabel = [agent.model, agent.reasoningEffort && capitalize(agent.reasoningEffort)].filter(Boolean).join(' · ');
  const parentFile = parent?.tracePath?.split(/[\\/]/).pop();
  return (
    <header className={`trace-hero trace-hero--${agent.harness}`}>
      <div className="trace-hero__title">
        <span
          className={`trace-hero__dot ${agent.status === 'active' ? 'trace-hero__dot--live' : ''}`}
          style={{ '--dot': STATUS_COLOR[agent.status] } as CSSProperties}
          title={t(`trace.status.${agent.status}`)}
          aria-label={t('trace.header.statusLabel', { status: t(`trace.status.${agent.status}`) })}
          role="img"
        />
        <h1 id={titleId}>{t('trace.header.title', { harness })}</h1>
        <span className="trace-chip trace-chip--provider">{harness}</span>
        <span className={`trace-chip ${isMain ? 'trace-chip--main' : 'trace-chip--sub'}`}>{isMain ? t('trace.header.main') : t('trace.header.subagent')}</span>
        <button
          type="button"
          className="trace-workspace__button trace-hero__refresh"
          onClick={onRefresh}
          disabled={loading}
          aria-label={t('trace.header.refresh')}
        >
          {loading ? t('trace.header.loadingButton') : t('trace.header.refreshButton')}
        </button>
      </div>

      <div className="trace-hero__meta">
        {agent.cwd && <span title={agent.cwd}><Home size={12} aria-hidden="true" />{agent.cwd}</span>}
        {(agent.sessionId || agent.threadId) && <span><b>{t('trace.header.id')}</b> {agent.sessionId || agent.threadId}</span>}
        {modelLabel && <span>{modelLabel}</span>}
        {!isMain && agent.role && <span><b>{t('trace.header.role')}</b> {agent.role}</span>}
        {!isMain && agent.nickname && <span><b>{t('trace.header.agent')}</b> {agent.nickname}</span>}
        {!isMain && agent.agentPath && <span><b>{t('trace.header.path')}</b> {agent.agentPath}</span>}
        <span>{t('trace.header.items', { count: itemCount, formatted: formatNumber(itemCount) })}</span>
        <span>{t('trace.header.toolCalls', { count: agent.stats.toolCalls, formatted: formatNumber(agent.stats.toolCalls) })}</span>
        <span style={{ color: STATUS_COLOR[agent.status] }}>{t(`trace.status.${agent.status}`)}</span>
      </div>

      {(subagents.length > 0 || parent) && (
        <div className="trace-hero__links">
          {parent && (
            <>
              <span className="trace-hero__links-label">{t('trace.header.parent')}</span>
              <button type="button" className="trace-link" onClick={() => onOpenAgent?.(parent)} disabled={!onOpenAgent} title={parent.tracePath}>
                <span className="trace-link__tag">{parent.type === 'main' ? t('trace.header.parentTagMain') : t('trace.header.parentTag')}</span>
                {parentFile || titleFor(parent)}
              </button>
            </>
          )}
          {subagents.length > 0 && (
            <>
              <span className="trace-hero__links-label">{t('trace.header.subagents')} <span className="trace-link__count">{subagents.length}</span></span>
              {subagents.map((subagent) => (
                <button
                  type="button"
                  key={subagent.id}
                  className="trace-link"
                  onClick={() => onOpenAgent?.(subagent)}
                  disabled={!onOpenAgent}
                  title={`${t(`trace.status.${subagent.status}`)} · ${subagent.model || t('trace.unknownModel')}`}
                >
                  <span className="trace-link__status" style={{ background: STATUS_COLOR[subagent.status] }} aria-hidden="true" />
                  {subagentLabel(subagent)}
                </button>
              ))}
              {subagents.length > 1 && onOpenAgents && (
                <button type="button" className="trace-link trace-link--all" onClick={() => onOpenAgents(subagents)} title={t('trace.header.openAllTitle')}>
                  {t('trace.header.openAll', { count: subagents.length })}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </header>
  );
}

function ConversationCard({ group, openDisclosure, onToggle }: { group: ConversationGroup } & DisclosureProps) {
  const { t } = useI18n();
  const usage = conversationUsage(group);
  const duration = conversationDuration(group);
  const iso = isoFor(group.timestamp);
  return (
    <article className={`trace-card trace-card--${group.kind}`}>
      <header className="trace-card__header" title={group.turnId ? t('trace.card.turn', { id: group.turnId }) : undefined}>
        <span className="trace-card__dot" aria-hidden="true" />
        <strong>{groupLabel(group.kind)}</strong>
        {group.model && <span className="trace-chip">{group.model}</span>}
        {group.reasoningEffort && <span className="trace-chip trace-chip--effort">{group.reasoningEffort}</span>}
        {iso && <time dateTime={iso}>{iso}</time>}
        <span className="trace-card__stats">
          {usage && group.kind !== 'usage' && (
            <span title={t('trace.card.usageTitle', { input: formatNumber(usage.input), output: formatNumber(usage.output) })}>
              {formatNumber(usage.input)}↓ {formatNumber(usage.output)}↑
            </span>
          )}
          {duration !== undefined && <span title={t('trace.card.durationTitle')}>{formatNumber(Math.round(duration))} ms</span>}
        </span>
      </header>
      <div className="trace-card__body">
        {group.blocks.map((block, index) => {
          const key = `${group.id}:${block.type}:${index}`;
          if (block.type === 'tools') {
            return <ToolGroup key={key} groupKey={key} tools={block.tools} openDisclosure={openDisclosure} onToggle={onToggle} />;
          }
          if (block.type === 'thinking') {
            return (
              <Disclosure
                key={key}
                id={key}
                className="trace-thinking"
                title={block.updates && block.updates > 1 ? t('trace.card.thinkingUpdates', { count: block.updates }) : t('trace.card.thinking')}
                summary={preview(block.entry.text, 220)}
                openDisclosure={openDisclosure}
                onToggle={onToggle}
              >
                <Markdown className="trace-thinking__body" text={block.entry.text} />
              </Disclosure>
            );
          }
          if (block.type === 'tool-result') {
            const failed = block.entry.kind === 'error';
            return (
              <Disclosure
                key={key}
                id={key}
                className={`trace-orphan ${failed ? 'trace-orphan--error' : ''}`}
                title={failed ? t('trace.card.unmatchedError') : t('trace.card.unmatchedResult')}
                summary={preview(prettyTraceText(block.entry.text))}
                openDisclosure={openDisclosure}
                onToggle={onToggle}
              >
                <CodeBlock label={failed ? t('trace.code.error') : t('trace.code.result')} text={prettyTraceText(block.entry.text)} />
              </Disclosure>
            );
          }
          // Usage is summarized in the card header unless the card is only usage.
          if (block.type === 'usage' && group.kind !== 'usage') return null;
          if (block.type === 'text' && (block.entry.kind === 'assistant' || block.entry.kind === 'user')) {
            return <Markdown key={key} className="trace-card__text" text={block.entry.text} />;
          }
          return <p key={key} className={`trace-card__note trace-card__note--${block.type}`}>{block.entry.text}</p>;
        })}
      </div>
    </article>
  );
}

function Disclosure({ id, className, title, summary, openDisclosure, onToggle, children }: {
  id: string;
  className: string;
  title: string;
  summary: string;
  children: ReactNode;
} & DisclosureProps) {
  const open = openDisclosure.has(id);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section className={`trace-disclosure ${className}`}>
      <button type="button" className="trace-disclosure__toggle" aria-expanded={open} onClick={() => onToggle(id)}>
        <Chevron size={13} aria-hidden="true" />
        <strong>{title}</strong>
        {!open && <span>{summary}</span>}
      </button>
      {open && children}
    </section>
  );
}

function ToolGroup({ groupKey, tools, openDisclosure, onToggle }: {
  groupKey: string;
  tools: ConversationTool[];
} & DisclosureProps) {
  const { t } = useI18n();
  // Tool groups start expanded; each call's input and result start collapsed.
  const open = !openDisclosure.has(groupKey);
  const names = Array.from(new Set(tools.map(({ call }) => call.toolName || 'tool'))).join(', ');
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section className="trace-tools">
      <button type="button" className="trace-disclosure__toggle trace-tools__toggle" aria-expanded={open} onClick={() => onToggle(groupKey)}>
        <Chevron size={13} aria-hidden="true" />
        <strong>{t('trace.tools.summary', { count: tools.length, names })}</strong>
      </button>
      {open && (
        <ul className="trace-tools__tree">
          {tools.map((tool, index) => (
            <ToolRow key={`${groupKey}:${tool.call.id}:${index}`} tool={tool} toolKey={`${groupKey}:tool:${index}`} openDisclosure={openDisclosure} onToggle={onToggle} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ToolRow({ tool, toolKey, openDisclosure, onToggle }: {
  tool: ConversationTool;
  toolKey: string;
} & DisclosureProps) {
  const { t } = useI18n();
  const open = openDisclosure.has(toolKey);
  const input = getToolInput(tool.call);
  const status = toolStatus(tool);
  const resultText = tool.result ? prettyTraceText(tool.result.text) || t('trace.tools.emptyResult') : '';
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <li className={`trace-tool trace-tool--${status.tone}`}>
      <button type="button" className="trace-tool__summary" aria-expanded={open} onClick={() => onToggle(toolKey)}>
        <Chevron size={13} aria-hidden="true" />
        <ArrowUpRight size={13} aria-hidden="true" className="trace-tool__icon" />
        <strong>{tool.call.toolName || 'tool'}</strong>
        <code>{preview(input, 120) || t('trace.tools.noInput')}</code>
        <em>· {status.label}</em>
      </button>
      <div className="trace-tool__preview">
        <span aria-hidden="true" />
        {tool.result ? preview(resultText, 240) : t('trace.tools.noResultRetained')}
      </div>
      {open && (
        <div className="trace-tool__details">
          <CodeBlock label={t('trace.code.input')} text={input || '—'} />
          {tool.result && <CodeBlock label={tool.result.kind === 'error' ? t('trace.code.error') : t('trace.code.result')} text={resultText} tone={status.tone} />}
        </div>
      )}
    </li>
  );
}

function CodeBlock({ label, text, tone }: { label: string; text: string; tone?: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_400);
    return () => window.clearTimeout(timer);
  }, [copied]);
  function copy() {
    void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => undefined);
  }
  return (
    <div className={`trace-code ${tone ? `trace-code--${tone}` : ''}`}>
      <div className="trace-code__label">
        <span>{label}</span>
        <button type="button" onClick={copy} aria-label={t('trace.code.copyLabel', { label: label.toLowerCase() })} title={copied ? t('trace.code.copied') : t('trace.code.copy')}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
      <pre>{text}</pre>
    </div>
  );
}

export default TraceWorkspace;

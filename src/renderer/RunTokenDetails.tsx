import { useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Info, X } from 'lucide-react';
import type { Agent } from '../shared/types';
import { estimateAgentCost, estimateModelCosts, PRICING_VERIFIED_AT, UNATTRIBUTED_MODEL, type ModelCostRow } from '../shared/pricing';
import { formatNumber, formatUsd, t, useI18n } from './i18n';
import { RollingNumber, RollingText } from './RollingNumber';
import { TokenUsageCharts } from './TokenUsageCharts';
import { NUMBER_FORMATS, useNumberFormat } from './numberFormat';
import { Segmented } from './Segmented';
import { useDialogFocus } from './useDialogFocus';

const exact = (value: number) => formatNumber(value);

function usd(value: number | null) {
  if (value === null || !Number.isFinite(value)) return t('tokens.unknown');
  if (value !== 0 && Math.abs(value) < 0.0001) return '<$0.0001';
  return formatUsd(value, { minimumFractionDigits: 0, maximumFractionDigits: 4 });
}

function share(part: number, whole: number) {
  if (!whole) return '0%';
  const percent = part / whole * 100;
  return `${percent > 0 && percent < 0.1 ? '<0.1' : formatNumber(percent, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

const rate = (value: number) => formatUsd(value, { minimumFractionDigits: 2, maximumFractionDigits: 4 });

/** Cents are enough for the header; the breakdown keeps full precision. */
function usdShort(value: number) {
  if (Math.abs(value) < 1) return usd(value);
  return formatUsd(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function modelCostLabel(row: ModelCostRow) {
  if (row.complete) return usd(row.knownUsd);
  return row.knownUsd > 0 ? usd(row.knownUsd) : t('tokens.unknown');
}

/** Pricing assumptions (notes) are informational; only unpriced tokens make an estimate partial. */
function modelCostNote(row: ModelCostRow) {
  if (row.complete) return [t('tokens.ratesVerified', { date: PRICING_VERIFIED_AT }), ...row.notes].join(' ');
  const tokens = exact(row.unpricedTokens);
  const prefix = row.knownUsd > 0 ? t('tokens.knownSubtotalUnpriced', { tokens }) : t('tokens.tokensUnpriced', { tokens });
  return [prefix, ...row.notes].join(' ');
}

type AgentCost = ReturnType<typeof estimateAgentCost>;

function costLabel(cost: AgentCost) {
  if (cost.complete && cost.usd !== null) return usd(cost.usd);
  return cost.knownUsd > 0 ? usd(cost.knownUsd) : t('tokens.unknown');
}

function costNote(cost: AgentCost) {
  if (cost.complete) return [t('tokens.ratesVerified', { date: PRICING_VERIFIED_AT }), ...cost.notes].join(' ');
  return cost.notes.length ? cost.notes.join(' ') : t('tokens.knownSubtotalMissing');
}

/** The run's token totals in the header; clicking them opens the breakdown as a floating dialog. */
export function RunTokenDetails({ agents }: { agents: Agent[] }) {
  useI18n();
  const [open, setOpen] = useState(false);
  const totals = agentTotals(agents);
  const cost = runCost(agents);
  return <div className="run-token-details">
    <button type="button" className="run-token-totals" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} aria-label={t('tokens.summaryLabel', { input: exact(totals.input), output: exact(totals.output), cost: cost.label })}>
      <span className="run-token-totals__stat run-token-totals__stat--input" title={t('tokens.inputTitle', { count: exact(totals.input) })}>
        <span className="run-token-totals__label">{t('tokens.input')}</span>
        <strong><RollingNumber value={totals.input} /></strong>
      </span>
      <span className="run-token-totals__stat run-token-totals__stat--output" title={t('tokens.outputTitle', { count: exact(totals.output) })}>
        <span className="run-token-totals__label">{t('tokens.output')}</span>
        <strong><RollingNumber value={totals.output} /></strong>
      </span>
      <span className="run-token-totals__stat run-token-totals__stat--usd" title={t('tokens.costTitle', { cost: cost.label, note: cost.note })}>
        <span className="run-token-totals__label">{t('tokens.estCost')}</span>
        <strong><RollingText text={cost.short} /></strong>
      </span>
      <span className="run-token-totals__details">{t('tokens.details')}<ChevronDown size={14} aria-hidden="true" /></span>
    </button>
    {open && createPortal(<TokenBreakdown agents={agents} onClose={() => setOpen(false)} />, document.body)}
  </div>;
}

function agentTotals(agents: Agent[]) {
  return agents.reduce((sum, agent) => ({
    input: sum.input + agent.stats.inputTokens,
    output: sum.output + agent.stats.outputTokens,
  }), { input: 0, output: 0 });
}

/** Summed cost of the run with its labels: `label` keeps full precision, `short` is for headline numbers. */
function runCost(agents: Agent[]) {
  const costs = agents.map((agent) => estimateAgentCost(agent));
  const total = costs.reduce((sum, cost) => ({
    knownUsd: sum.knownUsd + cost.knownUsd,
    unpricedTokens: sum.unpricedTokens + cost.unpricedTokens,
    complete: sum.complete && cost.complete && cost.usd !== null,
  }), { knownUsd: 0, unpricedTokens: 0, complete: costs.length > 0 });
  const notes = [...new Set(costs.flatMap((cost) => cost.notes))];
  const label = total.complete || total.knownUsd > 0 ? usd(total.knownUsd) : t('tokens.unknown');
  const note = total.complete
    ? [t('tokens.ratesVerified', { date: PRICING_VERIFIED_AT }), ...notes].join(' ')
    : total.knownUsd > 0
      ? t('tokens.knownSubtotalPriced', { tokens: exact(total.unpricedTokens) })
      : t('tokens.noPricedUsage', { tokens: exact(total.unpricedTokens) });
  return { ...total, notes, label, note, short: total.knownUsd > 0 ? usdShort(total.knownUsd) : label };
}

function TokenBreakdown({ agents, onClose }: { agents: Agent[]; onClose: () => void }) {
  useI18n();
  const { format, setFormat, count } = useNumberFormat();
  const panel = useRef<HTMLElement>(null);
  useDialogFocus(panel, onClose);
  const [view, setView] = useState<'agent' | 'model'>('agent');
  const modelRows = useMemo(() => estimateModelCosts(agents), [agents]);
  const titleId = useId();
  const totals = agentTotals(agents);
  const rows = [...agents].sort((a, b) =>
    Number(b.type === 'main') - Number(a.type === 'main')
    || (b.stats.inputTokens + b.stats.outputTokens) - (a.stats.inputTokens + a.stats.outputTokens)
    || a.id.localeCompare(b.id));
  const costByAgentId = new Map(agents.map((agent) => [agent.id, estimateAgentCost(agent)]));
  const totalCost = runCost(agents);
  const totalTokens = totals.input + totals.output;
  const pricedTokens = totalTokens - totalCost.unpricedTokens;
  const perMillion = totalCost.knownUsd > 0 && pricedTokens > 0 ? totalCost.knownUsd / pricedTokens * 1_000_000 : undefined;
  const totalCostLabel = totalCost.label;
  const totalCostNote = totalCost.note;

  return (
    <div className="token-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={panel} className="token-breakdown" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header>
          <div>
            <h2 id={titleId}>{t('tokens.breakdown')}</h2>
            <p>{t('tokens.agentSummary.subagents', { count: agents.length - 1, sub: agents.length - 1, total: agents.length })}</p>
          </div>
          <div className="token-breakdown__actions">
            <Segmented small label={t('ui.numberFormat.label')} value={format} onChange={setFormat}
              options={NUMBER_FORMATS.map((option) => ({ value: option.id, label: t(option.shortKey), title: `${t('ui.numberFormat.label')}: ${t(option.labelKey)}` }))} />
            <button type="button" className="token-breakdown__close" onClick={onClose}><X size={14} aria-hidden="true" />{t('tokens.close')}</button>
          </div>
        </header>
        <div className="token-breakdown__totals" aria-label={t('tokens.aggregated')}>
          <div className="token-breakdown__tile token-breakdown__tile--input">
            <span>{t('tokens.inputTokens')}</span>
            <strong><RollingNumber value={totals.input} /></strong>
            <small>{t('tokens.shareOfTotalCached', { share: share(totals.input, totalTokens) })}</small>
          </div>
          <div className="token-breakdown__tile token-breakdown__tile--output">
            <span>{t('tokens.outputTokens')}</span>
            <strong><RollingNumber value={totals.output} /></strong>
            <small>{t('tokens.shareOfTotal', { share: share(totals.output, totalTokens) })}</small>
          </div>
          <div className="token-breakdown__tile">
            <span>{t('tokens.totalTokens')}</span>
            <strong><RollingNumber value={totalTokens} /></strong>
            <small>{t('tokens.acrossAgents', { count: agents.length })}</small>
          </div>
          <div className="token-breakdown__tile token-breakdown__tile--cost" title={t('tokens.costTileTitle', { cost: totalCostLabel, note: totalCostNote })}>
            <span>{t('tokens.estimatedCost')}</span>
            <strong><RollingText text={totalCost.short} /></strong>
            <small>{perMillion ? t('tokens.perMillion', { cost: usd(perMillion) }) : t('tokens.estimateUsd')}</small>
          </div>
        </div>
        <div className="token-breakdown__notes">
          <span title={totalCost.notes.join('\n') || undefined}><Info size={12} aria-hidden="true" />{t('tokens.estimateNote', { date: PRICING_VERIFIED_AT })}</span>
          {totalCost.unpricedTokens > 0 && <span className="token-breakdown__unpriced" title={t('tokens.excludes', { tokens: exact(totalCost.unpricedTokens) })}>{t('tokens.excludesShort', { tokens: count(totalCost.unpricedTokens) })}</span>}
        </div>
        <div className="token-breakdown__body">
        <div className="token-breakdown__pane">
        <div className="token-breakdown__views" role="tablist" aria-label={t('tokens.groupBy')}>
          <button type="button" role="tab" aria-selected={view === 'agent'} onClick={() => setView('agent')}>{t('tokens.byAgent')} <span>{agents.length}</span></button>
          <button type="button" role="tab" aria-selected={view === 'model'} onClick={() => setView('model')}>{t('tokens.byModel')} <span>{modelRows.filter((row) => row.model !== UNATTRIBUTED_MODEL).length}</span></button>
        </div>
        <div className="token-breakdown__scroll">
          {view === 'agent' ? <table>
            <thead><tr><th scope="col">{t('tokens.colAgent')}</th><th scope="col">{t('tokens.colIn')}</th><th scope="col">{t('tokens.colOut')}</th><th scope="col" title={t('tokens.usdTitle', { note: totalCostNote })}>{t('tokens.colUsd')}</th></tr></thead>
            <tbody>{rows.map(agent => <tr key={agent.id}>
              <th scope="row" title={agent.id}><strong>{agent.nickname || agent.role || (agent.type === 'main' ? t('tokens.mainAgent') : t('tokens.subagentId', { id: agent.id.slice(-8) }))}</strong><span>{agent.type === 'main' ? t('tokens.main') : agent.role || t('tokens.subagent')} · {agent.model || t('tokens.unknownModel')}</span></th>
              <td><RollingNumber value={agent.stats.inputTokens} /></td><td><RollingNumber value={agent.stats.outputTokens} /></td><td className="token-breakdown__cost" title={costNote(costByAgentId.get(agent.id)!)}><RollingText text={costLabel(costByAgentId.get(agent.id)!)} /></td>
            </tr>)}</tbody>
            <tfoot><tr><th scope="row">{t('tokens.runTotal')}</th><td><RollingNumber value={totals.input} /></td><td><RollingNumber value={totals.output} /></td><td className="token-breakdown__cost" title={totalCostNote}><RollingText text={totalCostLabel} /></td></tr></tfoot>
          </table> : <table className="token-breakdown__models">
            <thead><tr><th scope="col">{t('tokens.colModel')}</th><th scope="col">{t('tokens.colIn')}</th><th scope="col">{t('tokens.colOut')}</th><th scope="col" title={t('tokens.usdTitle', { note: totalCostNote })}>{t('tokens.colUsd')}</th><th scope="col">{t('tokens.colShare')}</th></tr></thead>
            <tbody>{modelRows.map(row => {
              const costShare = totalCost.knownUsd > 0 ? row.knownUsd / totalCost.knownUsd : 0;
              return <tr key={row.model}>
                <th scope="row">
                  <strong>{row.model}</strong>
                  <span>{t('tokens.shareOfTokens', { agents: t('tokens.agentCount', { count: row.agents }), share: share(row.inputTokens + row.outputTokens, totalTokens) })}</span>
                  <span>{row.rate ? t('tokens.rates', { input: rate(row.rate.input), output: rate(row.rate.output) }) : row.model === UNATTRIBUTED_MODEL ? t('tokens.noModel') : t('tokens.noRate')}</span>
                </th>
                <td><RollingNumber value={row.inputTokens} /><span className="token-breakdown__sub">{row.inputTokens ? t('tokens.cached', { share: share(row.cacheReadTokens, row.inputTokens) }) : '—'}</span></td>
                <td><RollingNumber value={row.outputTokens} /></td>
                <td className={`token-breakdown__cost ${row.complete ? '' : 'token-breakdown__cost--partial'}`} title={modelCostNote(row)}><RollingText text={modelCostLabel(row)} /></td>
                <td className="token-breakdown__share" aria-label={t('tokens.shareOfCostLabel', { share: share(row.knownUsd, totalCost.knownUsd) })}>
                  <span className="token-breakdown__bar"><span style={{ width: `${Math.max(costShare > 0 ? 2 : 0, costShare * 100)}%` }} /></span>
                  <span>{row.knownUsd > 0 ? share(row.knownUsd, totalCost.knownUsd) : '—'}</span>
                </td>
              </tr>;
            })}</tbody>
            <tfoot><tr><th scope="row">{t('tokens.runTotal')}</th><td><RollingNumber value={totals.input} /></td><td><RollingNumber value={totals.output} /></td><td className="token-breakdown__cost" title={totalCostNote}><RollingText text={totalCostLabel} /></td><td className="token-breakdown__share"><span /><span>100%</span></td></tr></tfoot>
          </table>}
        </div>
        </div>
        <div className="token-breakdown__charts">
          <TokenUsageCharts agents={agents} />
        </div>
        </div>
      </section>
    </div>
  );
}

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown, Info, TriangleAlert, X } from 'lucide-react';
import type { Agent } from '../shared/types';
import { estimateAgentCost, estimateModelCosts, PRICING_VERIFIED_AT, UNATTRIBUTED_MODEL, type ModelCostRow } from '../shared/pricing';
import { formatNumber, formatUsd, t, useI18n } from './i18n';
import { RollingNumber, RollingText } from './RollingNumber';
import { TokenUsageCharts } from './TokenUsageCharts';

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

function modelCostNote(row: ModelCostRow) {
  if (row.complete) return t('tokens.ratesVerified', { date: PRICING_VERIFIED_AT });
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
  if (cost.notes.length) return cost.notes.join(' ');
  return cost.complete
    ? t('tokens.ratesVerified', { date: PRICING_VERIFIED_AT })
    : t('tokens.knownSubtotalMissing');
}

export function RunTokenDetails({ agents }: { agents: Agent[] }) {
  useI18n();
  const ref = useRef<HTMLDetailsElement>(null);
  const [view, setView] = useState<'agent' | 'model'>('agent');
  const modelRows = useMemo(() => estimateModelCosts(agents), [agents]);
  const titleId = useId();
  const totals = agents.reduce((sum, agent) => ({
    input: sum.input + agent.stats.inputTokens,
    output: sum.output + agent.stats.outputTokens,
  }), { input: 0, output: 0 });
  const rows = [...agents].sort((a, b) =>
    Number(b.type === 'main') - Number(a.type === 'main')
    || (b.stats.inputTokens + b.stats.outputTokens) - (a.stats.inputTokens + a.stats.outputTokens)
    || a.id.localeCompare(b.id));
  const costs = agents.map((agent) => ({ agent, cost: estimateAgentCost(agent) }));
  const costByAgentId = new Map(costs.map(({ agent, cost }) => [agent.id, cost]));
  const totalCost = costs.reduce((sum, { cost }) => ({
    knownUsd: sum.knownUsd + cost.knownUsd,
    unpricedTokens: sum.unpricedTokens + cost.unpricedTokens,
    complete: sum.complete && cost.complete && cost.usd !== null,
  }), { knownUsd: 0, unpricedTokens: 0, complete: costs.length > 0 });
  const totalTokens = totals.input + totals.output;
  const pricedTokens = totalTokens - totalCost.unpricedTokens;
  const perMillion = totalCost.knownUsd > 0 && pricedTokens > 0 ? totalCost.knownUsd / pricedTokens * 1_000_000 : undefined;
  const totalCostLabel = totalCost.complete
    ? usd(totalCost.knownUsd)
    : totalCost.knownUsd > 0
      ? usd(totalCost.knownUsd)
      : t('tokens.unknown');
  const totalCostNote = totalCost.complete
    ? t('tokens.ratesVerified', { date: PRICING_VERIFIED_AT })
    : totalCost.knownUsd > 0
      ? t('tokens.knownSubtotalPriced', { tokens: exact(totalCost.unpricedTokens) })
      : t('tokens.noPricedUsage', { tokens: exact(totalCost.unpricedTokens) });

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (ref.current?.open && event.target instanceof Node && !ref.current.contains(event.target)) {
        ref.current.open = false;
      }
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, []);

  function close() {
    if (!ref.current) return;
    ref.current.open = false;
    ref.current.querySelector('summary')?.focus();
  }

  return (
    <details className="run-token-details" ref={ref} onKeyDown={event => {
      if (event.key === 'Escape' && ref.current?.open) { event.preventDefault(); event.stopPropagation(); close(); }
    }}>
      <summary className="run-token-totals" aria-label={t('tokens.summaryLabel', { input: exact(totals.input), output: exact(totals.output), cost: totalCostLabel })}>
        <span className="run-token-totals__stat run-token-totals__stat--input" title={t('tokens.inputTitle', { count: exact(totals.input) })}>
          <span className="run-token-totals__label">{t('tokens.input')}</span>
          <strong><RollingNumber value={totals.input} /></strong>
        </span>
        <span className="run-token-totals__stat run-token-totals__stat--output" title={t('tokens.outputTitle', { count: exact(totals.output) })}>
          <span className="run-token-totals__label">{t('tokens.output')}</span>
          <strong><RollingNumber value={totals.output} /></strong>
        </span>
        <span className="run-token-totals__stat run-token-totals__stat--usd" title={t('tokens.costTitle', { cost: totalCostLabel, note: totalCostNote })}>
          <span className="run-token-totals__label">{t('tokens.estCost')}</span>
          <strong><RollingText text={totalCost.knownUsd > 0 ? usdShort(totalCost.knownUsd) : totalCostLabel} /></strong>
        </span>
        <span className="run-token-totals__details">{t('tokens.details')}<ChevronDown size={14} aria-hidden="true" /></span>
      </summary>
      <section className="token-breakdown" aria-labelledby={titleId}>
        <header>
          <div>
            <h2 id={titleId}>{t('tokens.breakdown')}</h2>
            <p>{t('tokens.agentSummary.subagents', { count: agents.length - 1, sub: agents.length - 1, total: agents.length })}</p>
          </div>
          <button type="button" className="token-breakdown__close" onClick={close}><X size={15} aria-hidden="true" />{t('tokens.close')}</button>
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
            <strong><RollingText text={totalCost.knownUsd > 0 ? usdShort(totalCost.knownUsd) : totalCostLabel} /></strong>
            <small>{perMillion ? t('tokens.perMillion', { cost: usd(perMillion) }) : t('tokens.estimateUsd')}</small>
          </div>
        </div>
        <div className="token-breakdown__notes">
          <span><Info size={13} aria-hidden="true" />{t('tokens.estimateNote', { date: PRICING_VERIFIED_AT })}</span>
          {!totalCost.complete && <span className="token-breakdown__warning"><TriangleAlert size={13} aria-hidden="true" />{t('tokens.excludes', { tokens: exact(totalCost.unpricedTokens) })}</span>}
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
              <td><RollingNumber value={agent.stats.inputTokens} /></td><td><RollingNumber value={agent.stats.outputTokens} /></td><td className="token-breakdown__cost" title={costNote(costByAgentId.get(agent.id) as AgentCost)}><RollingText text={costLabel(costByAgentId.get(agent.id) as AgentCost)} /></td>
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
    </details>
  );
}

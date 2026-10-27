import type { Agent, ModelTokenUsage } from './types';

export const PRICING_VERIFIED_AT = '2026-10-28';
export const PRICING_SOURCES = ['https://developers.openai.com/api/docs/pricing','https://platform.claude.com/docs/en/about-claude/pricing'];
type Rate = { vendor:string; input:number; read:number; write?:number; write1h?:number; output:number; threshold?:number; thresholdInclusive?:boolean; long?:{input:number;read:number;write:number;output:number} };
const rates:Record<string,Rate> = {};
/** OpenAI: cache writes 1.25x input; above 272K request input tokens the whole request costs 2x input and 1.5x output. */
function openai(model:string,input:number,read:number,output:number) {
  rates[model]={vendor:'openai',input,read,write:input*1.25,output,threshold:272000,long:{input:input*2,read:read*2,write:input*2.5,output:output*1.5}};
}
openai('gpt-6-astra',10,1,50);
openai('gpt-6.1-sol',2,.1,10);
openai('gpt-6-sol',2,.2,10);
openai('gpt-6.1-terra',1,.05,5);
openai('gpt-6-luna',.1,.01,.5);
openai('gpt-5.6-sol',4,.4,20);
openai('gpt-5.6-terra',2,.2,12);
openai('gpt-5.6-luna',.2,.02,1.2);
openai('gpt-5.5',5,.5,30);
/** Anthropic: 5-minute cache writes 1.25x input, 1-hour writes 2x; the 1M context costs the same per token throughout. */
function anthropic(model:string,input:number,read:number,output:number,long?:{threshold:number;input:number;read:number;output:number}) {
  rates[model]={vendor:'anthropic',input,read,write:input*1.25,write1h:input*2,output,
    ...(long?{threshold:long.threshold,long:{input:long.input,read:long.read,write:long.input*1.25,output:long.output}}:{})};
}
anthropic('claude-fable-5-1',10,.25,50);
anthropic('claude-opus-5-5',4,.2,20);
anthropic('claude-sonnet-5-5',2,.1,10);
// Haiku 5.5 prices requests above 100K input tokens at a higher tier.
anthropic('claude-haiku-5-5',.1,.01,.5,{threshold:100000,input:.5,read:.05,output:2.5});
anthropic('claude-fable-5',10,1,50);
anthropic('claude-opus-5',5,.5,25);
anthropic('claude-sonnet-5',2,.2,10);
anthropic('claude-haiku-4-5',1,.1,5);

/** The rates entry for a model id as traces record it: case, a `vendor/` prefix, a `[1m]` suffix or a date suffix do not matter. */
function rateKey(model:string):string|undefined {
  const name=model.trim().toLowerCase().replace(/^[\w.-]+\//,'').replace(/\[[^\]]*\]$/,'');
  if(rates[name]) return name;
  const undated=name.replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/,'');
  return rates[undated]?undated:undefined;
}
/** The list rate a model is priced at, if any. */
export function modelRate(model:string):Readonly<Rate>|undefined { const key=rateKey(model); return key?rates[key]:undefined; }

/** List rates in USD per 1M tokens, for display. `long` applies above `threshold` request input tokens. */
export type ModelPrice = Readonly<Rate> & { model: string };
export function listModelPrices(): ModelPrice[] { return Object.entries(rates).map(([model,rate])=>({...rate,model})); }


export interface CostEstimate { usd:number|null; knownUsd:number; complete:boolean; unpricedTokens:number; notes:string[] }
/**
 * Prices one usage bucket at the official API list price of its model, whatever route the tokens took. Missing details
 * are assumed rather than refused: no cache counters means no caching, no TTL split means 5-minute writes, no request
 * size means the base tier, and an unknown service tier means standard. Each assumption adds a note.
 */
function priceUsage(usage:ModelTokenUsage): {usd:number|null;notes:string[]} {
  const rate=modelRate(usage.model);
  if(!rate) return {usd:null,notes:[`No list price for ${usage.model || 'unknown model'}.`]};
  const values=[usage.inputTokens,usage.outputTokens,usage.cacheReadTokens,usage.cacheWriteTokens,usage.cacheWrite5mTokens,usage.cacheWrite1hTokens].filter(v=>v!==undefined);
  if(values.some(v=>!Number.isFinite(v)||(v ?? 0)<0)) return {usd:null,notes:['Invalid token counters.']};
  const notes:string[]=[];
  if(usage.inputTokens && (usage.cacheReadTokens===undefined || usage.cacheWriteTokens===undefined)) notes.push(`Cache counters are missing for ${usage.model}; counted as uncached input.`);
  const read=usage.cacheReadTokens??0, write=usage.cacheWriteTokens??0;
  if(read+write>usage.inputTokens) return {usd:null,notes:['Cached tokens exceed input total.']};
  let selected:Rate=rate;
  const requestInput=usage.requestInputTokens;
  if(rate.threshold && rate.long) {
    if(requestInput===undefined) { if(usage.inputTokens>rate.threshold) notes.push(`Per-request context size is unavailable for ${usage.model}; priced at the base tier.`); }
    else if(requestInput>rate.threshold || (rate.thresholdInclusive && requestInput===rate.threshold)) selected={...rate,...rate.long};
  }
  let writeCost=write*(selected.write??selected.input);
  if(write && selected.write1h!==undefined) {
    const short=usage.cacheWrite5mTokens, long=usage.cacheWrite1hTokens;
    if(short===undefined || long===undefined || short+long!==write) notes.push(`Cache-write lifetime is unavailable for ${usage.model}; priced as 5-minute writes.`);
    else writeCost=short*selected.write!+long*selected.write1h;
  }
  const tier=usage.serviceTier?.toLowerCase();
  let multiplier=1;
  if(tier && !['default','standard','auto','standard_only'].includes(tier)) {
    // OpenAI's priority processing and either vendor's fast mode cost 2x; Anthropic's Priority Tier bills at standard rates.
    if(tier==='fast' || (tier==='priority' && rate.vendor==='openai')) multiplier=2;
    else if(['flex','batch'].includes(tier)) multiplier=.5;
    else if(tier!=='priority') notes.push(`Unknown service tier ${tier}; priced at standard rates.`);
  }
  return {usd:((usage.inputTokens-read-write)*selected.input+read*selected.read+writeCost+usage.outputTokens*selected.output)*multiplier/1e6,notes};
}

/** Current API token-value estimate, never a subscription invoice or historical charge. */
export function estimateAgentCost(agent:Agent):CostEstimate {
  const total=agent.stats.inputTokens+agent.stats.outputTokens;
  if(!total) return {usd:0,knownUsd:0,complete:true,unpricedTokens:0,notes:[]};
  let knownUsd=0,unpricedTokens=0,coveredInput=0,coveredOutput=0;
  const notes=new Set<string>();
  for(const usage of agent.tokenUsage??[]) {
    coveredInput+=usage.inputTokens; coveredOutput+=usage.outputTokens;
    const result=priceUsage(usage);
    for(const note of result.notes) notes.add(note);
    if(result.usd===null) unpricedTokens+=usage.inputTokens+usage.outputTokens;
    else knownUsd+=result.usd;
  }
  const missing=Math.max(0,agent.stats.inputTokens-coveredInput)+Math.max(0,agent.stats.outputTokens-coveredOutput);
  if(missing) {unpricedTokens+=missing;notes.add('Some tokens have no model/cache attribution.');}
  if(coveredInput>agent.stats.inputTokens || coveredOutput>agent.stats.outputTokens) return {usd:null,knownUsd:0,complete:false,unpricedTokens:total,notes:['Usage buckets exceed the recorded total.']};
  const complete=unpricedTokens===0;
  return {usd:complete?knownUsd:null,knownUsd,complete,unpricedTokens,notes:[...notes]};
}

export interface ModelCostRow {
  model: string;
  agents: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  knownUsd: number;
  unpricedTokens: number;
  /** Every token in this row has a verified price. */
  complete: boolean;
  /** List price in USD per 1M tokens, when the model has a verified rate. */
  rate?: { input: number; output: number };
  notes: string[];
}

/** Label for tokens an agent recorded without a model/cache bucket. */
export const UNATTRIBUTED_MODEL = 'Unattributed';

/**
 * Aggregates token usage and API token-value estimates per model across agents,
 * applying the same rules as `estimateAgentCost` so the rows sum to the run total.
 */
export function estimateModelCosts(agents: readonly Agent[]): ModelCostRow[] {
  const rows = new Map<string, ModelCostRow & { agentIds: Set<string> }>();
  const rowFor = (model: string) => {
    let row = rows.get(model);
    if (!row) {
      const rate = modelRate(model);
      row = { model, agents: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, knownUsd: 0, unpricedTokens: 0, complete: true, notes: [], agentIds: new Set(),
        ...(rate ? { rate: { input: rate.input, output: rate.output } } : {}) };
      rows.set(model, row);
    }
    return row;
  };
  for (const agent of agents) {
    const usages = agent.tokenUsage ?? [];
    const coveredInput = usages.reduce((sum, usage) => sum + usage.inputTokens, 0);
    const coveredOutput = usages.reduce((sum, usage) => sum + usage.outputTokens, 0);
    const exceeds = coveredInput > agent.stats.inputTokens || coveredOutput > agent.stats.outputTokens;
    if (exceeds) {
      // Matches estimateAgentCost: inconsistent buckets are never priced.
      const row = rowFor(UNATTRIBUTED_MODEL);
      row.agentIds.add(agent.id);
      row.inputTokens += agent.stats.inputTokens;
      row.outputTokens += agent.stats.outputTokens;
      row.unpricedTokens += agent.stats.inputTokens + agent.stats.outputTokens;
      row.notes.push('Usage buckets exceed the recorded total.');
      continue;
    }
    for (const usage of usages) {
      const row = rowFor(usage.model || UNATTRIBUTED_MODEL);
      row.agentIds.add(agent.id);
      row.inputTokens += usage.inputTokens;
      row.outputTokens += usage.outputTokens;
      row.cacheReadTokens += usage.cacheReadTokens ?? 0;
      const result = priceUsage(usage);
      row.notes.push(...result.notes);
      if (result.usd === null) row.unpricedTokens += usage.inputTokens + usage.outputTokens;
      else row.knownUsd += result.usd;
    }
    const missingInput = Math.max(0, agent.stats.inputTokens - coveredInput);
    const missingOutput = Math.max(0, agent.stats.outputTokens - coveredOutput);
    if (missingInput || missingOutput) {
      const row = rowFor(UNATTRIBUTED_MODEL);
      row.agentIds.add(agent.id);
      row.inputTokens += missingInput;
      row.outputTokens += missingOutput;
      row.unpricedTokens += missingInput + missingOutput;
      row.notes.push('Some tokens have no model/cache attribution.');
    }
  }
  return [...rows.values()]
    .map(({ agentIds, ...row }) => ({ ...row, agents: agentIds.size, complete: row.unpricedTokens === 0, notes: [...new Set(row.notes)] }))
    .filter((row) => row.inputTokens + row.outputTokens > 0)
    .sort((a, b) => b.knownUsd - a.knownUsd || (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens) || a.model.localeCompare(b.model));
}

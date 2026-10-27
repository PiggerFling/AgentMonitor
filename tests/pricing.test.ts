import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateAgentCost } from '../src/shared/pricing';
import type { Agent,ModelTokenUsage } from '../src/shared/types';
const agent=(usage:ModelTokenUsage[]):Agent=>({id:'a',runId:'a',parentId:null,harness:'codex',type:'main',status:'active',tokenUsage:usage,stats:{inputTokens:usage.reduce((n,u)=>n+u.inputTokens,0),outputTokens:usage.reduce((n,u)=>n+u.outputTokens,0),toolCalls:0,errors:0}});
const sample:ModelTokenUsage={model:'gpt-6-astra',inputTokens:100000,outputTokens:10000,cacheReadTokens:80000,cacheWriteTokens:0,requestInputTokens:100000};
test('API prices count cached input once and reasoning is already in output',()=>{assert.equal(estimateAgentCost(agent([sample])).usd,.78);});
test('mixed-model usage uses each model rate',()=>{assert.equal(estimateAgentCost(agent([sample,{...sample,model:'gpt-5.6-luna'}])).usd,.7976);});
test('unknown aliases retain known subtotal without pretending zero cost',()=>{const result=estimateAgentCost(agent([sample,{...sample,model:'codex-auto-review'}]));assert.equal(result.usd,null);assert.equal(result.knownUsd,.78);assert.equal(result.unpricedTokens,110000);});
test('long context uses the entire request and known tier',()=>{const result=estimateAgentCost(agent([{...sample,inputTokens:300000,requestInputTokens:300000,serviceTier:'priority'}]));assert.equal(result.usd,10.62);});
test('missing context and cache details are priced with stated assumptions',()=>{
  const noContext=estimateAgentCost(agent([{...sample,inputTokens:300000,requestInputTokens:undefined}]));
  assert.equal(noContext.usd,2.78); assert.match(noContext.notes.join(' '),/base tier/);
  const noCache=estimateAgentCost(agent([{...sample,cacheReadTokens:undefined}]));
  assert.equal(noCache.usd,1.5); assert.match(noCache.notes.join(' '),/uncached/);
});
test('Anthropic cache writes use distinct TTL rates and default to 5-minute writes',()=>{const usage={...sample,model:'claude-sonnet-5',cacheReadTokens:50000,cacheWriteTokens:20000,cacheWrite5mTokens:10000,cacheWrite1hTokens:10000};assert.equal(estimateAgentCost(agent([usage])).usd,.235);assert.equal(estimateAgentCost(agent([{...usage,cacheWrite1hTokens:undefined}])).usd,.22);});
test('current models are priced whatever the route, alias or tier',()=>{
  const price=(usage:Partial<ModelTokenUsage>)=>estimateAgentCost(agent([{...sample,...usage}])).usd;
  // 20K uncached input, 80K cached, 10K output.
  assert.equal(price({model:'gpt-6.1-sol'}),.148);
  assert.equal(price({model:'gpt-6.1-terra',provider:'custom-proxy'}),.074);
  assert.equal(price({model:'gpt-6-luna'}),.0078);
  assert.equal(price({model:'claude-opus-5-5'}),.296);
  assert.equal(price({model:'anthropic/claude-opus-5-5-20260922'}),.296);
  assert.equal(price({model:'claude-opus-5-5[1m]',serviceTier:'priority'}),.296);
  assert.equal(price({model:'claude-opus-5-5',serviceTier:'fast'}),.592);
  assert.equal(price({model:'claude-fable-5-1'}),.72);
  assert.equal(price({model:'claude-haiku-4-5-20251001'}),.078);
  assert.equal(price({model:'gpt-6.1-sol',serviceTier:'mystery'}),.148);
});
test('Haiku 5.5 prices requests above 100K input tokens at its higher tier',()=>{
  const usage={...sample,model:'claude-haiku-5-5'};
  assert.equal(estimateAgentCost(agent([usage])).usd,.0078);
  assert.equal(estimateAgentCost(agent([{...usage,requestInputTokens:100001}])).usd,.039);
});
test('unattributed and excessive buckets do not yield full prices',()=>{const a=agent([sample]);a.stats.inputTokens++;assert.equal(estimateAgentCost(a).complete,false);a.stats.inputTokens-=2;assert.equal(estimateAgentCost(a).knownUsd,0);});
test('per-model rows aggregate across agents and sum to the agent estimates',async()=>{
  const {estimateModelCosts,UNATTRIBUTED_MODEL}=await import('../src/shared/pricing');
  const luna={...sample,model:'gpt-5.6-luna'};
  const first={...agent([sample,luna]),id:'first'};
  const second={...agent([luna,{...sample,model:'codex-auto-review'}]),id:'second'};
  second.stats={...second.stats,inputTokens:second.stats.inputTokens+500};
  const rows=estimateModelCosts([first,second]);
  assert.deepEqual(rows.map(row=>[row.model,row.agents]),[['gpt-6-astra',1],['gpt-5.6-luna',2],['codex-auto-review',1],[UNATTRIBUTED_MODEL,1]]);
  const lunaRow=rows.find(row=>row.model==='gpt-5.6-luna')!;
  assert.equal(lunaRow.inputTokens,200000); assert.equal(lunaRow.cacheReadTokens,160000); assert.equal(lunaRow.complete,true);
  assert.deepEqual(lunaRow.rate,{input:.2,output:1.2});
  assert.equal(rows.find(row=>row.model===UNATTRIBUTED_MODEL)!.unpricedTokens,500);
  const known=rows.reduce((sum,row)=>sum+row.knownUsd,0);
  const expected=estimateAgentCost(first).knownUsd+estimateAgentCost(second).knownUsd;
  assert.ok(Math.abs(known-expected)<1e-12);
});

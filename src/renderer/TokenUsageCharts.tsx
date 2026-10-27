import { useMemo } from 'react';
import type { Agent } from '../shared/types';
import { formatNumber, t, useI18n } from './i18n';
import { useNumberFormat } from './numberFormat';
import './TokenUsageCharts.css';

type TickAnchor = 'start'|'middle'|'end';
type ChartPoint = {timestamp:number;input:number;output:number;cumulative:number};
const VIEW = {width:600,height:166};
const PLOT = {left:64,right:588,top:12,bottom:130};

/** Rounds up to 1, 2, 2.5 or 5 × 10^n so tick labels stay readable. */
function niceCeil(value:number) {
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1,2,2.5,5,10].find(candidate => candidate*power >= value) ?? 10;
  return step*power;
}

function Axes({max,yTitle,xTicks,count}:{max:number;yTitle:string;xTicks:{at:number;label:string;anchor:TickAnchor}[];count:(value:number)=>string}) {
  const yTicks=[0,0.5,1];
  const middle=(PLOT.top+PLOT.bottom)/2;
  return <g className="token-chart__axes">
    {yTicks.map(fraction=>{
      const at=PLOT.bottom-fraction*(PLOT.bottom-PLOT.top);
      return <g key={fraction}>
        {fraction>0&&<line className="token-chart__grid" x1={PLOT.left} x2={PLOT.right} y1={at} y2={at}/>}
        <text className="token-chart__tick" x={PLOT.left-8} y={at} textAnchor="end" dominantBaseline="middle">{count(max*fraction)}</text>
      </g>;
    })}
    <path className="token-chart__axis" d={`M${PLOT.left} ${PLOT.top}V${PLOT.bottom}H${PLOT.right}`}/>
    {xTicks.map(tick=><g key={tick.anchor}>
      <line className="token-chart__axis" x1={tick.at} x2={tick.at} y1={PLOT.bottom} y2={PLOT.bottom+4}/>
      <text className="token-chart__tick" x={tick.at} y={PLOT.bottom+17} textAnchor={tick.anchor}>{tick.label}</text>
    </g>)}
    <text className="token-chart__title" x={(PLOT.left+PLOT.right)/2} y={VIEW.height-2} textAnchor="middle">{t('tokens.charts.timeLocal')}</text>
    <text className="token-chart__title" transform={`translate(14 ${middle}) rotate(-90)`} textAnchor="middle">{yTitle}</text>
  </g>;
}
export function TokenUsageCharts({agents}:{agents:Agent[]}) {
  const {locale}=useI18n();
  const {count,title}=useNumberFormat();
  const data = useMemo(() => {
    const bins = new Map<number,{input:number;output:number}>();
    for (const agent of agents) for (const point of agent.tokenTimeline ?? []) {
      if (!Number.isFinite(point.timestamp)) continue;
      const minute = Math.floor(point.timestamp / 60000) * 60000;
      const bin = bins.get(minute) ?? {input:0,output:0};
      bin.input += point.inputTokens; bin.output += point.outputTokens; bins.set(minute,bin);
    }
    const times = [...bins.keys()].sort((a,b)=>a-b);
    if (!times.length) return null;
    const start = times[0], end = times.at(-1)!;
    const minutes = (end-start)/60000+1;
    // Bucket wide histories to at most 120 points. Rate retains tokens/minute units.
    const step = Math.max(1,Math.ceil(minutes/120));
    const grouped = Array.from({length:Math.ceil(minutes/step)},(_,index)=>({timestamp:start+index*step*60000,input:0,output:0,cumulative:0}));
    let cumulative = 0, peak = 0;
    for (const [time, bin] of bins) {
      peak = Math.max(peak,bin.input+bin.output);
      const point=grouped[Math.floor((time-start)/60000/step)];
      point.input+=bin.input; point.output+=bin.output;
    }
    const points=grouped.map((point,index)=>{
      cumulative+=point.input+point.output;
      const width=Math.min(step,minutes-index*step);
      return {...point,input:point.input/width,output:point.output/width,cumulative};
    });
    return {points,minutes,step,total:cumulative,peak,start,end};
  },[agents]);
  if (!data) return <p className="token-charts__empty">{t('tokens.charts.empty')}</p>;
  const maxRate=niceCeil(Math.max(1,...data.points.map(p=>p.input+p.output)));
  const maxTotal=niceCeil(Math.max(1,data.total));
  const x=(i:number)=>PLOT.left+i*(PLOT.right-PLOT.left)/Math.max(1,data.points.length-1);
  const y=(value:number,max:number)=>PLOT.bottom-value/max*(PLOT.bottom-PLOT.top);
  const line=(get:(p:ChartPoint)=>number,max:number)=>data.points.map((p,i)=>`${i?'L':'M'}${x(i)},${y(get(p),max)}`).join(' ');
  const range=(time:number)=>new Date(time).toLocaleString(locale,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
  const multiDay=new Date(data.start).toDateString()!==new Date(data.end).toDateString();
  const tickTime=(time:number)=>new Date(time).toLocaleString(locale,multiDay?{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}:{hour:'2-digit',minute:'2-digit'});
  const lastTime=data.points.at(-1)!.timestamp;
  const xTicks:{at:number;label:string;anchor:TickAnchor}[]=data.points.length>1
    ?[{at:PLOT.left,label:tickTime(data.start),anchor:'start'},{at:(PLOT.left+PLOT.right)/2,label:tickTime((data.start+lastTime)/2),anchor:'middle'},{at:PLOT.right,label:tickTime(lastTime),anchor:'end'}]
    :[{at:PLOT.left,label:tickTime(data.start),anchor:'start'}];
  return <section className="token-charts" aria-label={t('tokens.charts.ariaCharts')}>
    <div className="token-charts__stats"><span>{t('tokens.charts.average')} <strong>{t('tokens.charts.perMin',{value:count(data.total/data.minutes)})}</strong></span><span>{t('tokens.charts.peakMinute')} <strong title={title(data.peak)}>{count(data.peak)}</strong></span><span>{t('tokens.charts.recorded')} <strong title={title(data.total)}>{t('tokens.charts.tokensCount',{value:count(data.total)})}</strong></span></div>
    <div className="token-charts__grid">
      <figure><figcaption>{t('tokens.charts.usageRate')} <small>{t('tokens.charts.rateUnit',{buckets:data.step>1?t('tokens.charts.averages',{step:data.step}):t('tokens.charts.oneMinuteBuckets')})}</small></figcaption>
        <div className="token-charts__legend"><span>{t('tokens.charts.legendInput')}</span><span>{t('tokens.charts.legendOutput')}</span><span>{t('tokens.charts.legendTotalDots')}</span></div>
        <svg viewBox={`0 0 ${VIEW.width} ${VIEW.height}`} role="img" aria-label={t('tokens.charts.rateAria',{peak:formatNumber(data.peak)})}>
          <Axes max={maxRate} yTitle={t('tokens.charts.yRate')} xTicks={xTicks} count={count}/>
          <path className="token-chart__input" d={line(p=>p.input,maxRate)}/><path className="token-chart__output" d={line(p=>p.output,maxRate)}/>
          {data.points.map((p,i)=><circle key={p.timestamp} className="token-chart__point" cx={x(i)} cy={y(p.input+p.output,maxRate)} r="2"><title>{t('tokens.charts.pointRate',{time:range(p.timestamp),input:count(Math.round(p.input)),output:count(Math.round(p.output))})}</title></circle>)}
        </svg>
      </figure>
      <figure><figcaption>{t('tokens.charts.cumulative')} <small>{t('tokens.charts.recordedInterval')}</small></figcaption>
        <svg viewBox={`0 0 ${VIEW.width} ${VIEW.height}`} role="img" aria-label={t('tokens.charts.cumulativeAria',{total:formatNumber(data.total)})}>
          <Axes max={maxTotal} yTitle={t('tokens.charts.yCumulative')} xTicks={xTicks} count={count}/>
          <path className="token-chart__input" d={line(p=>p.cumulative,maxTotal)}/>
          {data.points.map((p,i)=><circle key={p.timestamp} className="token-chart__point" cx={x(i)} cy={y(p.cumulative,maxTotal)} r="2"><title>{t('tokens.charts.pointCumulative',{time:range(p.timestamp),total:count(p.cumulative)})}</title></circle>)}
        </svg>
      </figure>
    </div>
    <p className="token-charts__caption">{t('tokens.charts.caption',{start:range(data.start),end:range(data.end)})}</p>
  </section>;
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { MultiSourceMonitor } from '../src/main/trace-monitor/MultiSourceMonitor';
import type { Agent, MonitorSnapshot } from '../src/shared/types';

class Source extends EventEmitter {
  selected?: string;
  constructor(readonly id: string, readonly harness: Agent['harness']) { super(); }
  async start() {}
  async stop() {}
  snapshot(): MonitorSnapshot {
    return { runs: [{id:this.id,harness:this.harness}], agents: this.selected ? [{ id:this.id,runId:this.id,parentId:null,harness:this.harness,type:'main',status:'idle',stats:{inputTokens:0,outputTokens:0,toolCalls:0,errors:0} }] : [], edges:[],errors:[],watching:true };
  }
  async loadRun(id:string) { this.selected=id; this.emit('snapshot'); }
  unloadRun() { this.selected=undefined; }
  async getTrace() { return [{id:'entry',kind:'assistant' as const,text:this.id}]; }
}

test('selection across file/database sources releases prior traces and preserves inventory', async () => {
  const files=new Source('claude:a','claude');
  const database=new Source('hermes:b','hermes');
  const monitor=new MultiSourceMonitor([files,database]);
  await monitor.start();
  assert.equal(monitor.snapshot().runs.length,2);
  assert.equal(monitor.snapshot().agents.length,0);
  await monitor.loadRun('claude:a');
  assert.equal((await monitor.getTrace('claude:a'))[0].text,'claude:a');
  await monitor.loadRun('hermes:b');
  assert.equal(files.selected,undefined);
  assert.deepEqual(monitor.snapshot().agents.map(a=>a.id),['hermes:b']);
  assert.deepEqual(await monitor.getTrace('claude:a'),[]);
  assert.equal(monitor.snapshot().runs.length,2);
  await monitor.stop();
});

class Tracked extends Source {
  started = 0; stopped = 0;
  async start() { this.started++; }
  async stop() { this.stopped++; }
}

test('sources added at runtime start when the monitor runs and show up in snapshots', async () => {
  const files=new Tracked('claude:a','claude');
  const monitor=new MultiSourceMonitor([files]);
  const early=new Tracked('codex:early','codex');
  await monitor.addSource(early);
  assert.equal(early.started,0);
  await monitor.start();
  assert.equal(early.started,1);
  let snapshots=0;
  monitor.on('snapshot',()=>snapshots++);
  const late=new Tracked('hermes:late','hermes');
  await monitor.addSource(late);
  await monitor.addSource(late);
  assert.equal(late.started,1);
  assert.ok(snapshots>0);
  assert.deepEqual(monitor.snapshot().runs.map(run=>run.id).sort(),['claude:a','codex:early','hermes:late']);
  // Its own snapshot events are relayed.
  snapshots=0; late.emit('snapshot');
  assert.equal(snapshots,1);
  await monitor.loadRun('hermes:late');
  assert.deepEqual(monitor.snapshot().agents.map(a=>a.id),['hermes:late']);
  await monitor.stop();
  assert.equal(late.stopped,1);
});

test('removing a source stops it, detaches it, and clears the selection it held', async () => {
  const files=new Tracked('claude:a','claude');
  const remote=new Tracked('remote:x','codex');
  const other=new Tracked('remote:y','codex');
  const monitor=new MultiSourceMonitor([files,remote,other]);
  await monitor.start();
  await monitor.loadRun('remote:x');
  await monitor.removeSource(other);
  assert.equal(other.stopped,1);
  assert.equal(monitor.snapshot().selectedRunId,'remote:x');
  await monitor.removeSource(remote);
  assert.equal(remote.stopped,1);
  assert.equal(remote.selected,undefined);
  const snapshot=monitor.snapshot();
  assert.equal(snapshot.selectedRunId,undefined);
  assert.deepEqual(snapshot.agents,[]);
  assert.deepEqual(snapshot.runs.map(run=>run.id),['claude:a']);
  let snapshots=0;
  monitor.on('snapshot',()=>snapshots++);
  remote.emit('snapshot');
  assert.equal(snapshots,0);
  await monitor.removeSource(remote);
  await assert.rejects(monitor.loadRun('remote:x'),/Unknown trace run/);
  await monitor.stop();
  assert.equal(remote.stopped,1);
});

test('replacing sources starts the new ones first, swaps them in place with one snapshot and keeps the selection', async () => {
  const files=new Tracked('claude:a','claude');
  const hermes=new Tracked('hermes:h','hermes');
  const remote=new Tracked('remote:x','codex');
  const monitor=new MultiSourceMonitor([files,hermes,remote]);
  // Before start nothing is started.
  const early=new Tracked('claude:a','claude');
  await monitor.replaceSources([files],[early]);
  assert.equal(early.started,0);
  await monitor.start();
  await monitor.loadRun('claude:a');
  const snapshots:string[][]=[];
  monitor.on('snapshot',(snapshot:MonitorSnapshot)=>snapshots.push(snapshot.runs.map(run=>run.id).sort()));
  const next=new Tracked('claude:a','claude');
  const other=new Tracked('pi:p','pi');
  await monitor.replaceSources([early,hermes],[next,other]);
  assert.deepEqual([next.started,other.started,early.stopped,hermes.stopped],[1,1,1,1]);
  // No intermediate snapshot without local runs; the old ones' runs are gone.
  assert.ok(snapshots.every(runs=>runs.includes('claude:a')));
  assert.deepEqual(monitor.snapshot().runs.map(run=>run.id).sort(),['claude:a','pi:p','remote:x']);
  assert.deepEqual(monitor['sources'],[next,other,remote]);
  // The selected run was reloaded from the new source.
  assert.equal(next.selected,'claude:a');
  assert.deepEqual(monitor.snapshot().agents.map(a=>a.id),['claude:a']);
  snapshots.length=0; early.emit('snapshot'); hermes.emit('snapshot');
  assert.equal(snapshots.length,0);
  await monitor.stop();
});

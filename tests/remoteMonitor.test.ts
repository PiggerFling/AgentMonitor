import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RemoteMonitor } from '../src/main/trace-monitor/RemoteMonitor';
import { MultiSourceMonitor } from '../src/main/trace-monitor/MultiSourceMonitor';
import { AgentOutdatedError } from '../src/main/remote/sshTunnel';
import { AGENT_PROTOCOL_VERSION, type RemoteEndpoint } from '../src/shared/remoteProtocol';
import type { Agent, MonitorSnapshot } from '../src/shared/types';

const stats = {inputTokens:0,outputTokens:0,toolCalls:0,errors:0};
const agent = (id:string,parentId:string|null):Agent => ({id,runId:'run1',parentId,harness:'codex',type:parentId?'subagent':'main',status:'active',stats});

class FakeAgent {
  server = http.createServer((req,res) => this.handle(req,res));
  streams = new Set<http.ServerResponse>();
  protocol = AGENT_PROTOCOL_VERSION;
  loaded: string[] = [];
  traces: string[] = [];
  selected?: string;
  title = 'first';
  get snap(): MonitorSnapshot {
    const agents = this.selected === 'run1' ? [agent('a',null),agent('b','a')] : [];
    return { runs:[{id:'run1',harness:'codex',rootAgentId:'a',title:this.title}], agents, edges:agents.length?[{id:'a->b',source:'a',target:'b',type:'spawn',status:'active'}]:[], errors:['disk full'], watching:true, ...(this.selected?{selectedRunId:this.selected}:{}) };
  }
  async listen() { await new Promise<void>(r => this.server.listen(0,'127.0.0.1',r)); return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`; }
  push() { for (const res of this.streams) res.write(`event: snapshot\ndata: ${JSON.stringify(this.snap)}\n\n`); }
  drop() { for (const res of this.streams) res.destroy(); this.streams.clear(); }
  async close() { this.drop(); this.server.closeAllConnections(); await new Promise(r => this.server.close(r)); }
  handle(req:http.IncomingMessage,res:http.ServerResponse) {
    const url = new URL(req.url!,'http://x');
    const json = (status:number,body:unknown) => { res.writeHead(status,{'content-type':'application/json'}); res.end(JSON.stringify(body)); };
    if (url.pathname === '/api/version') return json(200,{protocol:this.protocol,version:'test',hostname:'fake'});
    if (url.pathname === '/api/events') {
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.write(': ping\n\n');
      this.streams.add(res);
      req.on('close',() => this.streams.delete(res));
      return this.push();
    }
    if (url.pathname === '/api/trace') { this.traces.push(url.searchParams.get('agentId')!); return json(200,[{id:'t',kind:'assistant',text:url.searchParams.get('agentId')}]); }
    if (url.pathname === '/api/load-run' && req.method === 'POST') {
      let body = '';
      req.on('data',c => body += c);
      req.on('end',() => { const {runId} = JSON.parse(body); if (runId !== 'run1') return json(404,{error:`Unknown trace run: ${runId}`}); this.loaded.push(runId); this.selected = runId; res.writeHead(204).end(); this.push(); });
      return;
    }
    json(404,{error:'not found'});
  }
}

function endpoint(url:string) {
  const calls = {open:0,close:0};
  const ep: RemoteEndpoint = { async open() { calls.open++; return url; }, async close() { calls.close++; } };
  return {ep,calls};
}

async function until(check:() => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r,5)); }
}

const P = 'remote:srv::';

test('namespaces every id, labels runs, pushes live updates and routes loadRun/getTrace', async () => {
  const fake = new FakeAgent();
  const {ep,calls} = endpoint(await fake.listen());
  const monitor = new RemoteMonitor({id:'srv',label:'box',endpoint:ep,retry:{minMs:5,maxMs:20}});
  let emits = 0;
  monitor.on('snapshot',() => emits++);
  await monitor.start();
  assert.equal(monitor.snapshot().remotes![0].state,'connecting');
  assert.equal(monitor.snapshot().watching,false);
  await until(() => monitor.snapshot().remotes![0].state === 'connected');
  let snap = monitor.snapshot();
  assert.deepEqual(snap.runs,[{id:`${P}run1`,harness:'codex',rootAgentId:`${P}a`,title:'first',host:'box'}]);
  assert.deepEqual(snap.errors,['[box] disk full']);
  assert.equal(snap.watching,true);
  assert.ok(snap.remotes![0].lastConnectedAt);
  assert.equal(snap.remotes![0].error,undefined);
  assert.ok(emits >= 2);

  fake.title = 'second'; fake.push();
  await until(() => monitor.snapshot().runs[0].title === 'second');

  await monitor.loadRun(`${P}run1`);
  assert.deepEqual(fake.loaded,['run1']);
  await until(() => monitor.snapshot().agents.length === 2);
  snap = monitor.snapshot();
  assert.equal(snap.selectedRunId,`${P}run1`);
  assert.deepEqual(snap.agents.map(a => [a.id,a.runId,a.parentId]),[[`${P}a`,`${P}run1`,null],[`${P}b`,`${P}run1`,`${P}a`]]);
  assert.deepEqual(snap.edges.map(e => [e.id,e.source,e.target]),[[`${P}a->b`,`${P}a`,`${P}b`]]);
  assert.equal((await monitor.getTrace(`${P}b`))[0].text,'b');
  assert.deepEqual(fake.traces,['b']);

  await assert.rejects(monitor.loadRun('remote:other::run1'),/does not belong to remote box/);
  await assert.rejects(monitor.getTrace('claude:a'),/does not belong to remote box/);
  await assert.rejects(monitor.loadRun(`${P}nope`),/Unknown trace run: nope/);

  monitor.unloadRun();
  assert.deepEqual(monitor.snapshot().agents,[]);
  assert.deepEqual(monitor.snapshot().edges,[]);
  assert.equal(monitor.snapshot().selectedRunId,undefined);

  await monitor.stop();
  const after = emits;
  fake.push();
  await new Promise(r => setTimeout(r,30));
  assert.equal(emits,after);
  assert.equal(calls.close,1);
  assert.equal(fake.streams.size,0);
  await fake.close();
});

test('protocol mismatch reports an error state', async () => {
  const fake = new FakeAgent();
  fake.protocol = AGENT_PROTOCOL_VERSION + 1;
  const {ep} = endpoint(await fake.listen());
  const monitor = new RemoteMonitor({id:'srv',label:'box',endpoint:ep,retry:{minMs:5,maxMs:20}});
  await monitor.start();
  await until(() => monitor.snapshot().remotes![0].state === 'error');
  assert.match(monitor.snapshot().remotes![0].error!,/protocol mismatch/);
  assert.equal(monitor.snapshot().watching,false);
  assert.equal(fake.streams.size,0);
  await assert.rejects(monitor.getTrace(`${P}a`),/not connected/);
  await monitor.stop();
  await fake.close();
});

test('unreachable endpoint does not block start and reports the error', async () => {
  const ep: RemoteEndpoint = { open: () => Promise.reject(new Error('ssh: connect refused')), close: async () => {} };
  const monitor = new RemoteMonitor({id:'srv',label:'box',endpoint:ep,retry:{minMs:5,maxMs:10}});
  await monitor.start();
  await until(() => monitor.snapshot().remotes![0].error === 'ssh: connect refused');
  await monitor.stop();
});

test('reconnects after the stream drops, keeps last runs meanwhile, and re-selects the run', async () => {
  const fake = new FakeAgent();
  const {ep,calls} = endpoint(await fake.listen());
  const monitor = new RemoteMonitor({id:'srv',label:'box',endpoint:ep,retry:{minMs:50,maxMs:100}});
  await monitor.start();
  await until(() => monitor.snapshot().remotes![0].state === 'connected');
  await monitor.loadRun(`${P}run1`);
  const first = monitor.snapshot().remotes![0].lastConnectedAt!;
  fake.selected = undefined; // agent restarted and lost its selection
  fake.drop();
  await until(() => monitor.snapshot().remotes![0].state === 'error');
  assert.equal(monitor.snapshot().runs.length,1);
  assert.equal(monitor.snapshot().watching,false);
  await until(() => monitor.snapshot().remotes![0].state === 'connected');
  assert.ok(calls.open >= 2);
  assert.ok(monitor.snapshot().remotes![0].lastConnectedAt! >= first);
  await until(() => fake.loaded.length === 2 && monitor.snapshot().agents.length === 2);
  await monitor.stop();
  await fake.close();
});

test('stale stream without heartbeat is reconnected', async () => {
  const fake = new FakeAgent();
  const {ep,calls} = endpoint(await fake.listen());
  const monitor = new RemoteMonitor({id:'srv',label:'box',endpoint:ep,retry:{minMs:5,maxMs:10},staleMs:60});
  await monitor.start();
  await until(() => calls.open >= 2);
  await until(() => monitor.snapshot().remotes![0].state === 'connected');
  await monitor.stop();
  await fake.close();
});

test('agent that accepts but never answers /api/version is abandoned', async () => {
  const hung = http.createServer(() => {});
  await new Promise<void>(r => hung.listen(0,'127.0.0.1',r));
  const {ep,calls} = endpoint(`http://127.0.0.1:${(hung.address() as AddressInfo).port}`);
  const monitor = new RemoteMonitor({id:'srv',label:'box',endpoint:ep,retry:{minMs:5,maxMs:10},staleMs:60});
  await monitor.start();
  await until(() => monitor.snapshot().remotes![0].state === 'error' && calls.open >= 2);
  assert.match(monitor.snapshot().remotes![0].error!, /no data from agent/);
  await monitor.stop();
  hung.closeAllConnections();
  await new Promise(r => hung.close(r));
});

test('integrates with MultiSourceMonitor', async () => {
  const fake = new FakeAgent();
  const {ep} = endpoint(await fake.listen());
  const remote = new RemoteMonitor({id:'srv',label:'box',endpoint:ep,retry:{minMs:5,maxMs:20}});
  const multi = new MultiSourceMonitor([remote]);
  await multi.start();
  await until(() => multi.snapshot().remotes?.[0].state === 'connected');
  assert.equal(multi.snapshot().runs[0].host,'box');
  await multi.loadRun(`${P}run1`);
  assert.deepEqual(fake.loaded,['run1']);
  await until(() => multi.snapshot().agents.length === 2);
  assert.equal((await multi.getTrace(`${P}a`))[0].text,'a');
  assert.deepEqual(multi.snapshot().edges.map(e => e.id),[`${P}a->b`]);
  await multi.stop();
  await fake.close();
});

test('an outdated managed agent is reinstalled once, then the connection is retried at once', async () => {
  const fake = new FakeAgent();
  const url = await fake.listen();
  let installed = false, reinstalls = 0, opens = 0;
  const ep: RemoteEndpoint = { async open() { opens++; if (!installed) throw new AgentOutdatedError('srv'); return url; }, async close() {} };
  const monitor = new RemoteMonitor({id:'srv',label:'box',endpoint:ep,retry:{minMs:60_000,maxMs:60_000},reinstall: async () => { reinstalls++; installed = true; }});
  await monitor.start();
  // A 60s backoff would time out here: the retry after reinstalling does not wait.
  await until(() => monitor.snapshot().remotes![0].state === 'connected');
  assert.deepEqual([reinstalls,opens],[1,2]);
  await monitor.stop();
  await fake.close();
});

test('a failing reinstall is reported and tried at most once per backoff cycle', async () => {
  let reinstalls = 0, opens = 0;
  const ep: RemoteEndpoint = { async open() { opens++; throw new AgentOutdatedError('srv'); }, async close() {} };
  const monitor = new RemoteMonitor({id:'srv',label:'box',endpoint:ep,retry:{minMs:40,maxMs:40},reinstall: async () => { reinstalls++; throw new Error('Node.js is gone'); }});
  await monitor.start();
  await until(() => monitor.snapshot().remotes![0].state === 'error');
  assert.match(monitor.snapshot().remotes![0].error!,/missing or outdated and reinstalling it failed: Node.js is gone/);
  await new Promise(r => setTimeout(r,150));
  await monitor.stop();
  assert.ok(reinstalls >= 2 && reinstalls <= 5, `reinstalls ${reinstalls}`);
  assert.equal(opens,reinstalls);
  // A reinstall that succeeds without fixing the agent does not loop either.
  let ok = 0;
  const stubborn = new RemoteMonitor({id:'srv',label:'box',endpoint:ep,retry:{minMs:60_000,maxMs:60_000},reinstall: async () => { ok++; }});
  await stubborn.start();
  await until(() => stubborn.snapshot().remotes![0].state === 'error');
  await new Promise(r => setTimeout(r,50));
  assert.equal(ok,1);
  assert.match(stubborn.snapshot().remotes![0].error!,/missing or outdated/);
  await stubborn.stop();
});

test('stop does not wait for a reinstall in progress', async () => {
  let aborted = false;
  const ep: RemoteEndpoint = { async open() { throw new AgentOutdatedError('srv'); }, async close() {} };
  const monitor = new RemoteMonitor({id:'srv',label:'box',endpoint:ep,reinstall: signal => new Promise(() => { signal.addEventListener('abort',() => { aborted = true; }); })});
  await monitor.start();
  await new Promise(r => setTimeout(r,20));
  await monitor.stop();
  assert.equal(aborted,true);
});

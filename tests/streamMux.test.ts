import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { PassThrough, type Duplex } from 'node:stream';
import test from 'node:test';
import { MAX_FRAME_PAYLOAD, StreamMux } from '../src/shared/streamMux';

/** Two sessions joined back to back; `chop` delivers bytes one at a time to exercise frame reassembly. */
function pair({ chop = false } = {}) {
  const toServer = new PassThrough(), toClient = new PassThrough();
  const client = new StreamMux(toServer), server = new StreamMux(toClient);
  const feed = (mux: StreamMux) => (chunk: Buffer) => { if (!chop) mux.receive(chunk); else for (const byte of chunk) mux.receive(Buffer.from([byte])); };
  toServer.on('data', feed(server));
  toClient.on('data', feed(client));
  return { client, server, toServer, toClient };
}

function read(stream: Duplex): Promise<Buffer> {
  const chunks: Buffer[] = [];
  stream.on('data', chunk => chunks.push(chunk));
  return new Promise((resolve, reject) => { stream.once('end', () => resolve(Buffer.concat(chunks))); stream.once('error', reject); });
}

test('channels carry bytes both ways with half close, and large writes are split into frames', async () => {
  for (const chop of [false, true]) {
    const { client, server } = pair({ chop });
    const accepted = once(server, 'channel') as Promise<[Duplex]>;
    const channel = client.open();
    const [remote] = await accepted;
    const closed = Promise.all([once(channel, 'close'), once(remote, 'close')]);
    const big = Buffer.alloc(chop ? 3 * 1024 : 3 * MAX_FRAME_PAYLOAD + 7, 'x');
    const received = read(remote);
    channel.end(big);
    assert.deepEqual(await received, big);
    // The other direction stays open after the client's half close.
    const reply = read(channel);
    remote.end('done');
    assert.equal((await reply).toString(), 'done');
    await closed;
    assert.equal(client.size, 0);
    assert.equal(server.size, 0);
  }
});

test('an HTTP server serves concurrent requests and an open event stream over channels', async () => {
  const { client, server } = pair();
  const http1 = http.createServer((req, res) => {
    if (req.url === '/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('first\n'); return; }
    let body = '';
    req.setEncoding('utf8').on('data', chunk => body += chunk).on('end', () => res.end(`${req.url} ${body.length}`));
  });
  server.on('channel', channel => http1.emit('connection', channel));
  const agent = new http.Agent({ keepAlive: true });
  (agent as unknown as { createConnection: () => Duplex }).createConnection = () => client.open();
  const request = (path: string, body = '') => new Promise<string>((resolve, reject) => {
    const req = http.request({ host: 'localhost', path, method: body ? 'POST' : 'GET', agent }, res => {
      let text = ''; res.setEncoding('utf8').on('data', chunk => text += chunk).on('end', () => resolve(text));
    });
    req.on('error', reject).end(body);
  });
  const events = await new Promise<http.IncomingMessage>(resolve => http.get({ host: 'localhost', path: '/events', agent }, resolve));
  const [first] = await once(events.setEncoding('utf8'), 'data');
  assert.equal(first, 'first\n');
  const answers = await Promise.all([request('/a'), request('/b', 'y'.repeat(200_000)), request('/c')]);
  assert.deepEqual(answers, ['/a 0', '/b 200000', '/c 0']);
  agent.destroy();
  events.destroy();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(client.size, 0);
  assert.equal(server.size, 0);
});

test('destroying a channel closes its peer', async () => {
  const { client, server } = pair();
  const accepted = once(server, 'channel') as Promise<[Duplex]>;
  const channel = client.open();
  const [remote] = await accepted;
  const closed = once(remote, 'close');
  channel.destroy();
  await closed;
  assert.equal(server.size, 0);
});

test('ending the session or a malformed frame closes every channel', async () => {
  const { client, server } = pair();
  const accepted = once(server, 'channel') as Promise<[Duplex]>;
  const channel = client.open();
  const [remote] = await accepted;
  const sessionClosed = once(server, 'close');
  server.end();
  await Promise.all([once(remote, 'close'), sessionClosed]);
  assert.throws(() => server.open(), /closed/);

  const other = pair();
  const otherChannel = other.client.open();
  const broken = once(other.client, 'close');
  other.client.receive(Buffer.from([9, 0, 0, 0, 1, 0, 0, 0, 0]));
  const [error] = await broken;
  assert.match((error as Error).message, /Invalid/);
  await once(otherChannel, 'close');
  channel.destroy();
});

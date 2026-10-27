import { Duplex } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { Writable } from 'node:stream';

/**
 * Many byte streams ("channels") over one ordered byte stream, e.g. the stdin/stdout of the ssh session that runs a
 * managed agent. Only one side opens channels; the other receives them as 'channel' events.
 *
 * Frame: type (1 byte), channel id (uint32 BE), payload length (uint32 BE), payload.
 *   OPEN  a new channel; DATA  bytes; END  no more bytes from the sender (half close); CLOSE  the channel is gone.
 * There is no per-channel flow control: the agent's responses are bounded, and the underlying stream buffers.
 */
const OPEN = 1, DATA = 2, END = 3, CLOSE = 4;
const HEADER = 9;
/** Larger writes are split; larger incoming frames are a protocol error. */
export const MAX_FRAME_PAYLOAD = 64 * 1024;

function frame(type: number, id: number, payload?: Buffer): Buffer {
  const header = Buffer.allocUnsafe(HEADER);
  header.writeUInt8(type, 0); header.writeUInt32BE(id, 1); header.writeUInt32BE(payload?.length ?? 0, 5);
  return payload?.length ? Buffer.concat([header, payload]) : header;
}

class Channel extends Duplex {
  remoteClosed = false;
  constructor(private readonly mux: StreamMux, readonly id: number) { super({ allowHalfOpen: true }); }
  override _read() {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    for (let at = 0; at < chunk.length; at += MAX_FRAME_PAYLOAD) this.mux.send(DATA, this.id, chunk.subarray(at, at + MAX_FRAME_PAYLOAD));
    this.mux.flushed(callback);
  }
  override _final(callback: (error?: Error | null) => void) { this.mux.send(END, this.id); callback(); }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    this.mux.forget(this);
    if (!this.remoteClosed) this.mux.send(CLOSE, this.id);
    callback(error);
  }
  // Called where code expects a net.Socket, e.g. node's http server and client and the agent's event stream.
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  ref() { return this; }
  unref() { return this; }
  setTimeout(_ms: number, callback?: () => void) { if (callback) this.once('timeout', callback); return this; }
}

/** Emits 'channel' (Duplex) for channels the peer opens and 'close' once, when the session ends or breaks. */
export class StreamMux extends EventEmitter {
  private readonly channels = new Map<number, Channel>();
  private buffer: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private closed = false;

  constructor(private readonly output: Writable) {
    super();
    output.on('error', () => this.destroy());
  }

  get size() { return this.channels.size; }

  /** Opens a channel to the peer. */
  open(): Duplex {
    if (this.closed) throw new Error('Stream multiplexer is closed');
    const channel = new Channel(this, this.nextId);
    this.nextId = this.nextId === 0xffffffff ? 1 : this.nextId + 1;
    this.channels.set(channel.id, channel);
    this.send(OPEN, channel.id);
    return channel;
  }

  /** Feeds bytes read from the peer. */
  receive(chunk: Buffer) {
    if (this.closed) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= HEADER) {
      const type = this.buffer.readUInt8(0), id = this.buffer.readUInt32BE(1), length = this.buffer.readUInt32BE(5);
      if (type < OPEN || type > CLOSE || length > MAX_FRAME_PAYLOAD || (type !== DATA && length)) { this.destroy(new Error('Invalid stream multiplexer frame')); return; }
      if (this.buffer.length < HEADER + length) break;
      const payload = this.buffer.subarray(HEADER, HEADER + length);
      this.buffer = this.buffer.subarray(HEADER + length);
      this.dispatch(type, id, payload);
      if (this.closed) return;
    }
  }

  /** The peer's byte stream ended: every channel is gone. */
  end() { this.destroy(); }

  destroy(error?: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const channel of [...this.channels.values()]) { channel.remoteClosed = true; channel.destroy(); }
    this.emit('close', error);
  }

  private dispatch(type: number, id: number, payload: Buffer) {
    const channel = this.channels.get(id);
    if (type === OPEN) {
      if (channel) { this.destroy(new Error(`Stream multiplexer channel ${id} opened twice`)); return; }
      const opened = new Channel(this, id);
      this.channels.set(id, opened);
      this.emit('channel', opened);
    } else if (!channel) {
      // Frames for a channel this side already destroyed are expected; drop them.
    } else if (type === DATA) channel.push(Buffer.from(payload));
    else if (type === END) channel.push(null);
    else { channel.remoteClosed = true; channel.destroy(); }
  }

  /** @internal */
  send(type: number, id: number, payload?: Buffer) {
    if (!this.closed && this.output.writable) this.output.write(frame(type, id, payload));
  }

  /** @internal Calls back once the output has room again. */
  flushed(callback: () => void) {
    if (this.closed || !this.output.writableNeedDrain) { callback(); return; }
    const done = () => { this.output.off('drain', done); this.off('close', done); callback(); };
    this.output.once('drain', done);
    this.once('close', done);
  }

  /** @internal */
  forget(channel: Channel) { if (this.channels.get(channel.id) === channel) this.channels.delete(channel.id); }
}

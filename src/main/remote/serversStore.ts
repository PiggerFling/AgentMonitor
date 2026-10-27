import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseServersConfig, type ServerConfig } from './config';

type RawEntry = Record<string, unknown>;
interface RawFile { servers: unknown[]; [key: string]: unknown }

/** Turns an ssh alias into a servers.json id: invalid characters become "-", at most 64 characters, "-2", "-3"... when taken. */
export function serverIdFor(alias: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = alias.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'server';
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? '' : `-${n}`;
    const id = base.slice(0, 64 - suffix.length) + suffix;
    if (!used.has(id)) return id;
  }
}

/**
 * Edits servers.json for servers added and removed from the app. Every change re-reads the file, keeps other entries
 * and fields as they are (including invalid or manual ones), and writes atomically (temp file + rename). Changes are
 * serialized. A file that is not valid JSON or has no "servers" array is never overwritten.
 */
export class ServersStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly file: string) {}

  /** Adds a managed entry for `alias` with a fresh id and returns it as parsed. */
  addManaged(entry: { alias: string; label?: string; home: string; nodePath: string }): Promise<ServerConfig> {
    return this.edit(raw => {
      const id = serverIdFor(entry.alias, raw.servers.map(server => (server as RawEntry | null)?.id).filter((id): id is string => typeof id === 'string'));
      const added = { id, ...(entry.label ? { label: entry.label } : {}), ssh: entry.alias, managed: true, home: entry.home, nodePath: entry.nodePath };
      const parsed = parseServersConfig({ servers: [added] });
      if (!parsed.servers[0]) throw new Error(parsed.errors[0] ?? 'invalid server entry');
      raw.servers.push(added);
      return parsed.servers[0];
    });
  }

  /** Removes the entry with `id` and returns it, or undefined (file untouched) when there is none. */
  remove(id: string): Promise<RawEntry | undefined> {
    return this.edit(raw => {
      const index = raw.servers.findIndex(server => (server as RawEntry | null)?.id === id);
      if (index < 0) return undefined;
      return raw.servers.splice(index, 1)[0] as RawEntry;
    }, removed => removed !== undefined);
  }

  private edit<T>(change: (raw: RawFile) => T, changed: (result: T) => boolean = () => true): Promise<T> {
    const run = async () => {
      const raw = await this.read();
      const result = change(raw);
      if (changed(result)) await this.write(raw);
      return result;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async read(): Promise<RawFile> {
    let text: string;
    try { text = await readFile(this.file, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { servers: [] };
      throw error;
    }
    let raw: unknown;
    try { raw = JSON.parse(text); } catch (error) { throw new Error(`${this.file} is not valid JSON (${(error as Error).message}); fix or remove it first`); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray((raw as RawFile).servers)) throw new Error(`${this.file}: expected {"servers": [...]}; fix or remove it first`);
    return raw as RawFile;
  }

  private async write(raw: RawFile): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
      await rename(temp, this.file);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }
}

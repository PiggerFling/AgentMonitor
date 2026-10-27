import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppSettings, UpdateSettingsResult } from '../shared/types';
import { writeFileAtomic } from './atomicFile';
import { createLocalSources } from './trace-monitor/localSources';
import type { MonitorSource, MultiSourceMonitor } from './trace-monitor/MultiSourceMonitor';
import { parseTraceSourceOptions, validLocalDir } from './trace-monitor/traceSources';

export const DEFAULT_SETTINGS: AppSettings = { local: {} };

export function settingsPath(userDataDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENT_MONITOR_SETTINGS_FILE ? path.resolve(env.AGENT_MONITOR_SETTINGS_FILE) : path.join(userDataDir, 'settings.json');
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const copy = (settings: AppSettings): AppSettings => structuredClone(settings);

/** Validates settings (from settings.json or IPC) and normalizes them like parseTraceSourceOptions; other keys are ignored. */
export function parseAppSettings(raw: unknown): { settings: AppSettings } | { problem: string } {
  if (!isRecord(raw)) return { problem: 'expected an object' };
  const local = raw.local ?? {};
  if (!isRecord(local)) return { problem: '"local" must be an object' };
  const parsed = parseTraceSourceOptions(local, validLocalDir, 'an absolute path');
  return 'problem' in parsed ? { problem: `local: ${parsed.problem}` } : { settings: { local: parsed.options } };
}

/** settings.json: read once at startup, rewritten atomically keeping unknown top-level keys. Saves are serialized. */
export class SettingsStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly file: string) {}

  /** The stored settings; defaults when the file is missing, plus `error` when it is unreadable or invalid. */
  load(): { settings: AppSettings; error?: string } {
    let text: string;
    try { text = readFileSync(this.file, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { settings: copy(DEFAULT_SETTINGS) };
      return { settings: copy(DEFAULT_SETTINGS), error: `Cannot read ${this.file}: ${(error as Error).message}` };
    }
    let raw: unknown;
    try { raw = JSON.parse(text); } catch (error) { return { settings: copy(DEFAULT_SETTINGS), error: `Invalid JSON in ${this.file}: ${(error as Error).message}` }; }
    const parsed = parseAppSettings(raw);
    return 'problem' in parsed ? { settings: copy(DEFAULT_SETTINGS), error: `${this.file}: ${parsed.problem}; using defaults` } : { settings: parsed.settings };
  }

  save(settings: AppSettings): Promise<void> {
    const run = async () => {
      let raw: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(await readFile(this.file, 'utf8'));
        if (isRecord(parsed)) raw = parsed;
      } catch { /* missing or invalid: replaced */ }
      await writeFileAtomic(this.file, `${JSON.stringify({ ...raw, ...settings }, null, 2)}\n`);
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

/**
 * The desktop app's settings at runtime: owns the local trace sources inside the MultiSourceMonitor and replaces them
 * when `local` changes, without restarting the app. `createSources` is replaceable for tests.
 */
export class SettingsManager {
  private current: AppSettings;
  private sources: MonitorSource[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: { store: SettingsStore; monitor: MultiSourceMonitor; createSources?: (local: AppSettings['local']) => MonitorSource[] }, errors: string[] = []) {
    const loaded = options.store.load();
    if (loaded.error) errors.push(loaded.error);
    this.current = loaded.settings;
  }

  private create(local: AppSettings['local']) { return (this.options.createSources ?? createLocalSources)(local); }

  /** Adds the local sources for the loaded settings; call once, before remote sources are added. */
  async load(): Promise<void> {
    this.sources = this.create(this.current.local);
    for (const source of this.sources) await this.options.monitor.addSource(source);
  }

  get(): AppSettings { return copy(this.current); }

  /** Validates (malformed input becomes `ok: false`), saves, and restarts the local sources with the new settings. */
  update(raw: unknown): Promise<UpdateSettingsResult> {
    const parsed = parseAppSettings(raw);
    if ('problem' in parsed) return Promise.resolve({ ok: false, message: `Invalid settings: ${parsed.problem}` });
    const run = async (): Promise<UpdateSettingsResult> => {
      try { await this.options.store.save(parsed.settings); } catch (error) { return { ok: false, message: `Cannot save the settings: ${(error as Error).message}` }; }
      this.current = parsed.settings;
      const old = this.sources;
      this.sources = this.create(parsed.settings.local);
      await this.options.monitor.replaceSources(old, this.sources);
      return { ok: true, settings: copy(this.current) };
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

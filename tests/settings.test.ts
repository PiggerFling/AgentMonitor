import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MultiSourceMonitor } from '../src/main/trace-monitor/MultiSourceMonitor';
import { parseAppSettings, SettingsManager, SettingsStore, settingsPath } from '../src/main/settings';
import type { MonitorSnapshot, TraceSourceOptions } from '../src/shared/types';

const abs = path.resolve('/data');

/** A local source that serves one run per enabled tool. */
class Local extends EventEmitter {
  started = 0; stopped = 0;
  constructor(readonly options: TraceSourceOptions) { super(); }
  async start() { this.started++; }
  async stop() { this.stopped++; }
  snapshot(): MonitorSnapshot { return { runs: (this.options.tools ?? ['claude', 'codex']).map(tool => ({ id: `${tool}:run`, harness: tool })), agents: [], edges: [], errors: [], watching: true }; }
  async loadRun() {}
  unloadRun() {}
  async getTrace() { return []; }
}

async function setup(t: test.TestContext, content?: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'am-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = settingsPath(dir, {});
  if (content !== undefined) await writeFile(file, content);
  const monitor = new MultiSourceMonitor([]);
  const created: Local[] = [];
  const errors: string[] = [];
  const settings = new SettingsManager({ store: new SettingsStore(file), monitor, createSources: local => { const source = new Local(local); created.push(source); return [source]; } }, errors);
  return { dir, file, monitor, created, errors, settings };
}

test('settings.json lives in userData unless AGENT_MONITOR_SETTINGS_FILE says otherwise', () => {
  assert.equal(settingsPath('/u', {}), path.join('/u', 'settings.json'));
  assert.equal(settingsPath('/u', { AGENT_MONITOR_SETTINGS_FILE: 'x.json' }), path.resolve('x.json'));
});

test('settings are validated and normalized', () => {
  assert.deepEqual(parseAppSettings({}), { settings: { local: {} } });
  assert.deepEqual(parseAppSettings({ local: { tools: ['codex', 'claude'], traceDirs: { codex: abs, pi: '' } } }), { settings: { local: { tools: ['claude', 'codex'], traceDirs: { codex: abs } } } });
  for (const bad of [null, [], 'x', { local: 1 }, { local: { tools: ['x'] } }, { local: { traceDirs: { codex: 'relative' } } }, { local: { traceDirs: { codex: `${abs}\n` } } }]) {
    assert.ok('problem' in parseAppSettings(bad), JSON.stringify(bad));
  }
});

test('a missing file means defaults; an invalid one is reported and ignored', async t => {
  const missing = await setup(t);
  assert.deepEqual(missing.settings.get(), { local: {} });
  assert.deepEqual(missing.errors, []);
  const invalid = await setup(t, '{"local": {"tools": "all"}}');
  assert.deepEqual(invalid.settings.get(), { local: {} });
  assert.match(invalid.errors[0], /"tools" must be an array/);
});

test('updating saves atomically, keeps unknown keys and restarts the local sources in place', async t => {
  const { file, monitor, created, settings } = await setup(t, JSON.stringify({ local: { tools: ['claude'] }, theme: 'dark' }));
  await settings.load();
  const remote = new Local({ tools: ['pi'] });
  await monitor.addSource(remote);
  await monitor.start();
  assert.deepEqual(monitor.snapshot().runs.map(run => run.id).sort(), ['claude:run', 'pi:run']);
  const result = await settings.update({ local: { tools: ['codex', 'hermes'], traceDirs: { codex: abs } } });
  assert.deepEqual(result, { ok: true, settings: { local: { tools: ['codex', 'hermes'], traceDirs: { codex: abs } } } });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { local: { tools: ['codex', 'hermes'], traceDirs: { codex: abs } }, theme: 'dark' });
  assert.deepEqual(created.map(source => [source.options, source.started, source.stopped]), [[{ tools: ['claude'] }, 1, 1], [{ tools: ['codex', 'hermes'], traceDirs: { codex: abs } }, 1, 0]]);
  // Old local runs are gone, new ones are there, and the remote keeps its place after the local sources.
  assert.deepEqual(monitor.snapshot().runs.map(run => run.id).sort(), ['codex:run', 'hermes:run', 'pi:run']);
  assert.deepEqual(monitor['sources'], [created[1], remote]);
  assert.deepEqual(settings.get(), result.ok && result.settings);
  // Invalid input changes nothing.
  const bad = await settings.update({ local: { traceDirs: { codex: 'relative' } } });
  assert.equal(bad.ok, false);
  assert.equal(created.length, 2);
  await monitor.stop();
});

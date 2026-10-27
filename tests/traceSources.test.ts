import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { HermesMonitor } from '../src/main/trace-monitor/HermesMonitor';
import { createLocalSources } from '../src/main/trace-monitor/localSources';
import { TraceMonitor } from '../src/main/trace-monitor/TraceMonitor';
import { agentTraceArgs, parseTraceSourceOptions, traceRoots, validLocalDir } from '../src/main/trace-monitor/traceSources';

const home = path.resolve('/home/u');
const p = (...parts: string[]) => path.join(home, ...parts);

test('trace roots follow the variables, the options and the tool selection', () => {
  assert.deepEqual(traceRoots({}, {}, home), [p('.claude', 'projects'), p('.codex', 'sessions'), p('.pi', 'agent', 'sessions'), p('.hermes', 'session-exports', 'traces'), p('.hermes', 'sessions')]);
  const env = { CODEX_HOME: p('.config', 'codex'), CLAUDE_CONFIG_DIR: p('claude', 'projects') };
  assert.deepEqual(traceRoots({ tools: ['claude', 'codex'] }, env, home), [p('claude', 'projects'), p('.config', 'codex', 'sessions')]);
  // An option wins over the variable.
  assert.deepEqual(traceRoots({ tools: ['codex'], traceDirs: { codex: p('x') } }, env, home), [p('x', 'sessions')]);
  assert.deepEqual(traceRoots({ tools: [] }, env, home), []);
});

test('local sources skip disabled tools; AGENT_MONITOR_TRACE_ROOT replaces them all', () => {
  const kinds = (sources: unknown[]) => sources.map(source => source instanceof HermesMonitor ? 'hermes' : source instanceof TraceMonitor ? 'files' : '?');
  assert.deepEqual(kinds(createLocalSources({}, {})), ['hermes', 'files']);
  assert.deepEqual(kinds(createLocalSources({ tools: ['codex'] }, {})), ['files']);
  assert.deepEqual(kinds(createLocalSources({ tools: ['hermes'] }, {})), ['hermes', 'files']);
  assert.deepEqual(kinds(createLocalSources({ tools: [] }, {})), []);
  const hermes = createLocalSources({ tools: ['hermes'], traceDirs: { hermes: p('h') } }, {})[0];
  assert.equal(hermes['dbPath' as keyof typeof hermes], p('h', 'state.db'));
  const files = createLocalSources({ tools: ['codex'], traceDirs: { codex: p('c') } }, {})[0];
  assert.deepEqual(files['roots' as keyof typeof files], [p('c', 'sessions')]);
  const fixed = createLocalSources({ tools: [] }, { AGENT_MONITOR_TRACE_ROOT: p('t') });
  assert.deepEqual(kinds(fixed), ['files']);
  assert.deepEqual(fixed[0]['roots' as keyof (typeof fixed)[0]], [p('t')]);
});

test('options are validated, normalized and turned into agent flags', () => {
  assert.deepEqual(parseTraceSourceOptions({ tools: ['pi', 'claude', 'pi'], traceDirs: { pi: '', codex: p('c') } }, validLocalDir), { options: { tools: ['claude', 'pi'], traceDirs: { codex: p('c') } } });
  assert.deepEqual(parseTraceSourceOptions({ tools: ['claude', 'codex', 'pi', 'hermes'], traceDirs: {} }, validLocalDir), { options: {} });
  assert.deepEqual(parseTraceSourceOptions({ traceDirs: { codex: 'rel' } }, validLocalDir), { problem: '"traceDirs.codex" must be an absolute path' });
  assert.deepEqual(parseTraceSourceOptions({ traceDirs: { codex: 1 } }, validLocalDir), { problem: '"traceDirs.codex" must be an absolute path' });
  assert.deepEqual(parseTraceSourceOptions({ tools: [1] }, validLocalDir), { problem: '"tools" must be an array of claude, codex, pi, hermes' });
  assert.deepEqual(agentTraceArgs({}), []);
  assert.deepEqual(agentTraceArgs({ tools: [], traceDirs: { hermes: '/h', claude: '/c' } }), ['--tools=', '--claude-dir=/c', '--hermes-dir=/h']);
});

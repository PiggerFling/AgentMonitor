import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface AgentBundle { path: string; sha256: string }

/**
 * The agent.cjs shipped with the app and its hex sha256, which managed servers must match. Packaged apps carry it as
 * an electron-builder extra resource; development reads `dist-agent/agent.cjs` beside the built main (`mainDir`).
 * Throws when the file cannot be read.
 */
export function loadAgentBundle(options: { packaged: boolean; resourcesPath: string; mainDir: string }): AgentBundle {
  const file = options.packaged ? path.join(options.resourcesPath, 'agent.cjs') : path.join(options.mainDir, '../dist-agent/agent.cjs');
  return { path: file, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') };
}

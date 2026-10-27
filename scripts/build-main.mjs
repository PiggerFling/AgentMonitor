import { build } from 'esbuild';
await build({ entryPoints: ['src/main/index.ts', 'src/main/preload.ts'], outdir: 'dist-electron', outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], sourcemap: true });
// Headless agent for remote servers: one self-contained file with no Electron dependency.
await build({ entryPoints: ['src/agent/index.ts'], outfile: 'dist-agent/agent.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node22', sourcemap: true, banner: { js: '#!/usr/bin/env node' } });

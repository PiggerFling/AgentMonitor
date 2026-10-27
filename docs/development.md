# Development

```sh
npm test
npm run typecheck
npm run build
```

- `src/main/`: Electron lifecycle, IPC bridge, filesystem monitor.
- `src/traces/`: provider adapters and normalization.
- `src/graph/`: agent relationship and run derivation.
- `src/shared/`: provider-independent contracts.
- `src/renderer/`: React Flow dashboard, details, trace viewer, Zustand state.

Renderer edits reload during `npm run dev`. The dev server prefers port 5173 and moves to the next free port when it is taken; Electron always opens the port Vite actually bound (`scripts/dev.mjs`). Extra arguments pass to Electron, e.g. `npm run dev -- --inspect`. Restart that command after changing main-process or preload code. Build outputs are `dist/` and `dist-electron/`.

Trace detection and normalization follow the concepts in the neighboring `jsonl-viewer` project. The Electron bridge follows the [context isolation guidance](https://www.electronjs.org/docs/latest/tutorial/context-isolation).

## Memory bounds

Only the selected run has parsed trace bodies in memory. Its live detail view retains the latest 200 normalized entries per agent, with individual displayed entries capped at 64 KiB. JSONL metrics are folded across the entire selected file even when older display entries are discarded. Hermes database metrics come from its stored session counters; its reader queries only the latest 200 message rows per selected agent. Original trace files remain unchanged. Oversized malformed lines are skipped so a partial write cannot grow an unbounded buffer.

The app icon lives in `build/`: `icon.png` (1024 px, used for the window and the macOS Dock during development), `icon.icns` for macOS, and `icon.ico` for Windows.

`npm run screenshots` rebuilds the app and regenerates the README images in `docs/images/` from synthetic sessions.

`npm run test:smoke` builds the application and runs the Electron acceptance scenario with temporary synthetic sessions. It requires a desktop session and verifies explicit run selection, live nodes and edges, details, completion, and switching runs.

## Production build

```sh
npm run build
npm start
```

`npm run dev:web` serves the interface in a browser without data (it shows an offline empty state); trace discovery and settings require Electron.

## Packaging and releases

`npm run dist` packages installers for the current platform into `release/` using `electron-builder.yml` (macOS `.dmg`/`.zip`, Windows NSIS `.exe`, Linux `.AppImage`). Builds are unsigned; macOS builds are ad-hoc signed so Apple Silicon can open them.

Pushing a `v*` tag runs `.github/workflows/release.yml`, which packages on macOS, Windows, and Linux runners and publishes a GitHub release with `.github/release-notes.md`. Bump `version` in `package.json` before tagging.

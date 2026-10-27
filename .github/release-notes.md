First release of Agent Monitor: a local dashboard for Codex, Claude Code, Pi, and Hermes agent traces. Explore agent trees, read traces, and track token usage and estimated API cost. Traces stay on your machine.

## Downloads

| Platform | File |
| --- | --- |
| macOS (Apple Silicon) | `agent-monitor-*-mac-arm64.dmg` |

The `.zip` file is the same app without an installer image. Intel Macs, Windows and Linux can build the app from source with `npm run dist`.

## First launch

These builds are not signed with an Apple developer certificate yet.

- **macOS:** open the `.dmg` and drag Agent Monitor to Applications. On first launch, macOS blocks the app; open **System Settings → Privacy & Security** and choose **Open Anyway**. Alternatively run `xattr -dr com.apple.quarantine "/Applications/Agent Monitor.app"`.

See the [README](https://github.com/donvito/agent-monitor#readme) for where each provider's traces are read from.

# Remote servers

Agent Monitor can show runs from other machines. Each server runs a small headless agent that serves its local traces, and the desktop app reaches it over an ssh connection it opens itself, using your `~/.ssh/config`, keys, and ssh-agent. Remote runs appear in the sidebar beside local ones.

There are two kinds of servers in `servers.json`:

- **Managed** (`"managed": true`): added from the app. The app keeps its own copy of the agent in `~/.agent-monitor` on the server and runs it as the command of its ssh connection, talking to it over that connection's stdin/stdout. Nothing stays running on the server; the agent exits when the connection closes. See [Managed servers](#managed-servers).
- **Manual**: you run the agent yourself as a resident service on `127.0.0.1:8787`, as described in [Manual setup](#manual-setup).

## Managed servers

Requirements on the server: Linux or macOS, `/bin/sh`, Node.js 22.12+, and key-based ssh login from this machine (the app runs ssh with `BatchMode=yes`, so it cannot ask for passwords or passphrases: use a key loaded in ssh-agent or one without a passphrase).

### Adding a server

The app's **Servers** panel lists the concrete hosts of `~/.ssh/config` (including `Include`d files; wildcard `Host` patterns and `Match` blocks are skipped). Adding one runs these steps over ssh, without scp or sftp:

1. **Probe**: runs a small `sh` script (`ssh -T -o BatchMode=yes -o ClearAllForwardings=yes -- <host> sh -s`) that reports the home directory, `uname -s`/`-m`, and every Node.js it can find: `node` on the non-login `PATH`, `node` on the login shell's `PATH`, nvm (`~/.nvm/versions/node/*`), fnm (`~/.local/share/fnm/node-versions/*`), Volta, asdf, `/usr/local/bin`, `/opt/homebrew/bin` and `/usr/bin`. The newest version that is at least 22.12 is used, by absolute path, because commands run over ssh do not load nvm/fnm/volta `PATH` changes.
2. **Install**: creates `~/.agent-monitor` (mode 700), streams the app's bundled `agent.cjs` into it through ssh's stdin, checks its sha256 on the server (`sha256sum`, `shasum -a 256` or `openssl`), and only then writes `~/.agent-monitor/agent.sha256` containing just the hex hash.
3. **Save**: appends an entry to `servers.json` (written atomically; other entries and fields are kept) and connects right away.

Failures are reported with a reason: the key was rejected, the host key is unknown (the app shows its fingerprint and can retry with `StrictHostKeyChecking=accept-new` once you confirm it, or run `ssh <host>` once yourself), the host key changed, the host is unreachable, the OS is not Linux/macOS, or Node.js is missing or older than 22.12. To install Node.js for your user, for example with nvm:

```sh
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && nvm install 22
```

Removing a server stops it and deletes its entry; optionally the app also deletes `~/.agent-monitor` on the server.

### How a managed server connects

The entry records the absolute home directory and node path found by the probe:

```json
{ "id": "dev-1", "ssh": "dev-1", "managed": true, "home": "/home/alice", "nodePath": "/home/alice/.nvm/versions/node/v22.12.0/bin/node" }
```

`home` and `nodePath` must be absolute paths without `'`, `\` or control characters. For each connection the app runs

```
ssh -T -e none -o BatchMode=yes -o ClearAllForwardings=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 <sshArgs> -- <ssh> sh -c '<script>'
```

where `<script>` (single-quoted as a whole, so bash, zsh, fish and csh login shells all pass it to `sh` unchanged) is

```sh
cd '<home>/.agent-monitor' && [ "$(cat agent.sha256 2>/dev/null)" = '<sha256 of the bundled agent>' ] || exit 42; exec '<nodePath>' agent.cjs --stdio
```

The agent prints `agent-monitor ready` on stdout; anything the login shell printed before that line is ignored. After it, stdin and stdout carry multiplexed connections to the agent's HTTP server ([`src/shared/streamMux.ts`](../src/shared/streamMux.ts)), and the app serves them to itself on a free port on its own `127.0.0.1`. The agent exits when ssh closes its stdin.

No port forwarding is involved, so `ClearAllForwardings=yes` drops any `LocalForward`, `RemoteForward` or `DynamicForward` your `~/.ssh/config` sets for the host (for example one a clipboard tool added for interactive logins); those keep working in your own sessions, and the app never takes their ports. Setup commands (probe, install, remove) clear them the same way. `-e none` turns off the `~` escape character, since stdin carries binary data.

If `agent.sha256` is missing or does not match the app's bundled agent (for example after the app was updated), the command exits with code 42 and the app uploads the agent again (the install step above) and reconnects. If that fails, the server shows the error and the app tries again on its normal reconnect schedule.

## Manual setup

### Run the agent on a server

The agent needs Node.js 22.12+ and the same trace locations as the desktop app (see [Discovery and privacy](discovery-and-privacy.md)); `AGENT_MONITOR_TRACE_ROOT` and `AGENT_MONITOR_IDLE_MS` work the same way.

From a checkout:

```sh
npm ci
npm run agent
```

Or build once (`npm run build:main`) and copy the single file `dist-agent/agent.cjs` to the server; it has no dependencies:

```sh
node agent.cjs              # --port <port> or AGENT_MONITOR_PORT to change 8787
```

The agent prints `agent-monitor ready` once it is listening. To keep it running, a systemd user unit (`~/.config/systemd/user/agent-monitor.service`):

```ini
[Unit]
Description=Agent Monitor agent

[Service]
ExecStart=/usr/bin/node %h/agent-monitor/agent.cjs
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user enable --now agent-monitor
loginctl enable-linger "$USER"   # keep it running while logged out
```

### Configure the desktop app

Create `servers.json` in the app's data directory, or point `AGENT_MONITOR_SERVERS_FILE` at another file (servers added from the app are written there too). Restart the app after editing it by hand.

| OS | Installed app | `npm run dev` |
| --- | --- | --- |
| Linux | `~/.config/Agent Monitor/servers.json` | `~/.config/agent-monitor/servers.json` |
| macOS | `~/Library/Application Support/Agent Monitor/servers.json` | `~/Library/Application Support/agent-monitor/servers.json` |
| Windows | `%APPDATA%\Agent Monitor\servers.json` | `%APPDATA%\agent-monitor\servers.json` |

```json
{
  "servers": [
    { "id": "dev-1", "label": "Dev box", "ssh": "dev-1" },
    { "id": "gpu", "ssh": "alice@gpu.internal", "remotePort": 8787, "sshArgs": ["-J", "bastion"] }
  ]
}
```

| Field | |
| --- | --- |
| `id` | Required, unique, 1-64 of `A-Z a-z 0-9 . _ -` |
| `label` | Display name; defaults to `id` |
| `ssh` | Required host, `user@host`, or `~/.ssh/config` alias; no leading `-` or whitespace |
| `remotePort` | Agent port on the server; defaults to 8787 (manual servers) |
| `sshArgs` | Extra `ssh` options placed before the destination |
| `managed`, `home`, `nodePath` | Managed servers only, see [Managed servers](#managed-servers) |

Invalid entries are skipped and reported in the app's error list. A missing file means no remote servers.

The app runs `ssh -N -T -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -L 127.0.0.1:<free port>:127.0.0.1:<remotePort> <sshArgs> -- <ssh>`. `BatchMode` means ssh cannot prompt: **use key-based authentication with keys loaded in ssh-agent (or without a passphrase), and accept the host key once with a manual `ssh <host>` first.** Connection failures, such as `Permission denied (publickey)`, are shown on the server's status. Dropped tunnels are reopened automatically; quitting the app closes them.

## Security model

- The agent has no authentication or encryption of its own. It refuses to listen on anything but loopback; SSH provides both, with your existing keys and host verification.
- Managed servers do not listen at all: the agent is reachable only through the ssh session that started it.
- On a manual server, any process running as a user who can connect to `127.0.0.1:8787` can read the traces. On a shared machine, that includes other local users; anyone with a shell as your user can read the trace files directly anyway.
- The desktop side forwards only to a free port on its own `127.0.0.1`. Other local users on the desktop machine can connect to that port while the app runs.
- Trace content is read-only and never executed, on either side.

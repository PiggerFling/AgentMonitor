# Remote servers

Agent Monitor can show runs from other machines. Each server runs a small headless agent that serves its local traces on `127.0.0.1:8787`. The desktop app reaches it through an `ssh -L` port forward it opens itself, using your `~/.ssh/config`, keys, and ssh-agent. Remote runs appear in the sidebar beside local ones.

## Run the agent on a server

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

To keep it running, a systemd user unit (`~/.config/systemd/user/agent-monitor.service`):

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

## Configure the desktop app

Create `servers.json` in the app's data directory, or point `AGENT_MONITOR_SERVERS_FILE` at another file. Restart the app after editing it.

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
| `remotePort` | Agent port on the server; defaults to 8787 |
| `sshArgs` | Extra `ssh` options placed before the destination |

Invalid entries are skipped and reported in the app's error list. A missing file means no remote servers.

The app runs `ssh -N -T -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -L 127.0.0.1:<free port>:127.0.0.1:<remotePort> <sshArgs> -- <ssh>`. `BatchMode` means ssh cannot prompt: **use key-based authentication with keys loaded in ssh-agent (or without a passphrase), and accept the host key once with a manual `ssh <host>` first.** Connection failures, such as `Permission denied (publickey)`, are shown on the server's status. Dropped tunnels are reopened automatically; quitting the app closes them.

## Security model

- The agent has no authentication or encryption of its own. It refuses to listen on anything but loopback; SSH provides both, with your existing keys and host verification.
- On the server, any process running as a user who can connect to `127.0.0.1:8787` can read the traces. On a shared machine, that includes other local users; anyone with a shell as your user can read the trace files directly anyway.
- The desktop side forwards only to a free port on its own `127.0.0.1`. Other local users on the desktop machine can connect to that port while the app runs.
- Trace content is read-only and never executed, on either side.

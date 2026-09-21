#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$REPO_ROOT/server"
SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
ENV_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/foundry-mcp-live"
SERVICE_PATH="$SERVICE_DIR/foundry-mcp-live.service"
ENV_PATH="$ENV_DIR/server.env"
NODE_PATH="$(command -v node)"
NPM_PATH="$(command -v npm)"

mkdir -p "$SERVICE_DIR" "$ENV_DIR"

if [[ ! -f "$ENV_PATH" ]]; then
  cat > "$ENV_PATH" <<'ENVEOF'
# Foundry MCP Live server environment.
# Write and self-test tools are off by default; `evaluate` is ON by default.
# Uncomment only what you want for this local machine.

# FOUNDRY_MCP_ALLOW_WRITE=1
# FOUNDRY_MCP_ALLOW_SELF_TEST=1
# FOUNDRY_MCP_ALLOW_EVAL=0   # uncomment to DROP the evaluate tool

# Optional ports/hosts.
# FOUNDRY_MCP_PORT=3000
# FOUNDRY_WS_PORT=3001

# Bind address for the Foundry WebSocket bridge. 127.0.0.1 (the default) means
# only a browser on THIS machine can reach it. Set :: to expose it to the LAN
# so a second device browsing Foundry over the network can connect its bridge —
# pair that with FOUNDRY_WS_TOKEN below. Remember to open the port in your host
# firewall too; the bind address alone is not enough.
#
# Use :: rather than 0.0.0.0: 0.0.0.0 is IPv4-only, so a browser that resolves
# "localhost" to ::1 finds nothing listening and fails with no useful error,
# while shell-based checks pass because they fall back to IPv4. :: binds IPv6
# and accepts IPv4 via v4-mapped addresses.
#
# The MCP HTTP port is always loopback-bound regardless of this.
# FOUNDRY_WS_HOST=::

# Optional diagnostics/relaunch support.
# FOUNDRY_URLS=http://localhost:30000
# FOUNDRY_RELAUNCH_ENABLED=1
# FOUNDRY_RELAUNCH_URL=http://localhost:30000
# FOUNDRY_RELAUNCH_GM_USER=Gamemaster
# FOUNDRY_RELAUNCH_GM_PASSWORD=
# FOUNDRY_CHROME_PATH=/usr/bin/chromium
# FOUNDRY_CHROME_USER_DATA_DIR=%h/.local/share/foundry-mcp-live/chrome-profile

# Shared secret for the WebSocket bridge only. Strongly recommended whenever
# FOUNDRY_WS_HOST is not loopback — without it, anything that can route to the
# bridge port can register as a GM bridge. Generate one with:
#   openssl rand -hex 24
# Then, once per browser that connects:
#   localStorage.setItem("mcpBridgeToken", "<token>")
# This does NOT affect MCP clients on http://127.0.0.1:3000/mcp.
# FOUNDRY_WS_TOKEN=

# Shared secret for BOTH the bridge and the MCP HTTP endpoint. Setting this
# requires every MCP client to send `Authorization: Bearer <token>` — Codex has
# no per-server header config and would need server/proxy.mjs with BRIDGE_TOKEN
# in its env. Prefer FOUNDRY_WS_TOKEN above unless you specifically want that.
# BRIDGE_TOKEN=
ENVEOF
  chmod 600 "$ENV_PATH"
fi

cat > "$SERVICE_PATH" <<EOF
[Unit]
Description=Foundry MCP Live server
Documentation=https://github.com/DimitroffVodka/foundry-mcp-live
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$SERVER_DIR
Environment=PATH=$(dirname "$NODE_PATH"):$(dirname "$NPM_PATH"):/usr/local/bin:/usr/bin:/bin
EnvironmentFile=-$ENV_PATH
ExecStart=$NODE_PATH $SERVER_DIR/server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
EOF

chmod 644 "$SERVICE_PATH"
chmod 600 "$ENV_PATH"   # may hold FOUNDRY_WS_TOKEN / BRIDGE_TOKEN

if [[ ! -d "$SERVER_DIR/node_modules" ]]; then
  "$NPM_PATH" --prefix "$SERVER_DIR" install
fi

systemctl --user daemon-reload
systemctl --user enable --now foundry-mcp-live.service

cat <<EOF
Installed and started user service:
  $SERVICE_PATH

Environment file:
  $ENV_PATH

Useful commands:
  systemctl --user status foundry-mcp-live.service
  journalctl --user -u foundry-mcp-live.service -f
  systemctl --user restart foundry-mcp-live.service
  systemctl --user disable --now foundry-mcp-live.service

To start at machine boot before login, enable lingering once:
  sudo loginctl enable-linger $USER
EOF

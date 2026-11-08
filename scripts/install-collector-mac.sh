#!/usr/bin/env bash
set -euo pipefail

TOKEN="${1:?usage: install-collector-mac.sh <token> [machine]}"
MACHINE="${2:-LAPTOP}"
DIR="$HOME/msc-collector"
LABEL="com.ai-agent-company.collector"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="$HOME/.local/share/fnm/aliases/default/bin/node"
PORT=5190

TS_IP="$(ifconfig | awk '/inet 100\./ {print $2; exit}')"
[ -n "$TS_IP" ] || { echo "No Tailscale 100.x address" >&2; exit 1; }
[ -x "$NODE" ] || NODE="$(command -v node)"

SRC="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$DIR"
cp -R "$SRC/server" "$SRC/shared" "$DIR/"
printf '{ "name": "msc-collector", "private": true, "type": "module" }\n' > "$DIR/package.json"
printf 'MSC_ROLE=collector\nMSC_MACHINE=%s\nMSC_HOST=%s\nMSC_PORT=%s\nMSC_TOKEN=%s\n' "$MACHINE" "$TS_IP" "$PORT" "$(printf '%s' "$TOKEN" | tr -d '[:space:]')" > "$DIR/.env"
chmod 600 "$DIR/.env"

cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>server/hub.ts</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Standard</string>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/msc-collector.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/msc-collector.log</string>
</dict>
</plist>
PL
plutil -lint "$PLIST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 5
curl -s -m 5 "http://$TS_IP:$PORT/healthz"
echo

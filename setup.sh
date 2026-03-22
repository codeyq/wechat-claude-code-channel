#!/usr/bin/env bash
set -euo pipefail

# ── Resolve the directory where this script lives ──
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── 1. Check for Node.js >= 22 ──
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js is not installed."
  echo "The WeChat API requires Node.js >= 22."
  echo "Install it from https://nodejs.org/ or via nvm/fnm."
  exit 1
fi

NODE_VERSION="$(node -v)"                       # e.g. v22.4.0
NODE_MAJOR="${NODE_VERSION#v}"                   # 22.4.0
NODE_MAJOR="${NODE_MAJOR%%.*}"                   # 22

if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "ERROR: Node.js >= 22 is required (found $NODE_VERSION)."
  echo "Please upgrade Node.js before running this script."
  exit 1
fi

echo "Node.js $NODE_VERSION detected (>= 22). OK."

# ── 2. Run npm install if node_modules doesn't exist ──
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  echo "node_modules not found. Running npm install..."
  (cd "$SCRIPT_DIR" && npm install)
else
  echo "node_modules already exists. Skipping npm install."
fi

# ── 3. Detect full path to the node binary ──
NODE_PATH="$(command -v node)"
echo "Node binary: $NODE_PATH"

# ── 4. Detect full path to channel.mjs ──
CHANNEL_PATH="$SCRIPT_DIR/channel.mjs"
if [ ! -f "$CHANNEL_PATH" ]; then
  echo "ERROR: channel.mjs not found at $CHANNEL_PATH"
  exit 1
fi
echo "Channel file: $CHANNEL_PATH"

# ── 5. Create/update .mcp.json in the project directory ──
MCP_JSON="$SCRIPT_DIR/.mcp.json"

cat > "$MCP_JSON" <<EOF
{
  "mcpServers": {
    "wechat": {
      "command": "$NODE_PATH",
      "args": ["$CHANNEL_PATH"]
    }
  }
}
EOF

echo ""
echo ".mcp.json written to $MCP_JSON"

# ── 6. Print usage instructions ──
echo ""
echo "============================================"
echo "  Setup complete!"
echo "============================================"
echo ""
echo "To start Claude Code with the WeChat channel:"
echo ""
echo "  cd $SCRIPT_DIR"
echo "  claude --dangerously-load-development-channels server:wechat"
echo ""
echo "A QR code will appear in stderr. Scan it with WeChat to log in."
echo ""

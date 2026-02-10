#!/bin/bash
set -e

PORT="${OAUTHROUTER_PORT:-8402}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG="/tmp/oauthrouter.log"

echo "OAuthRouter Rebuild & Restart"
echo ""

# 1. Build
echo "-> Building..."
cd "$DIR" && npm run build --silent
echo "   Build OK"

# 2. Kill existing process
PID=$(lsof -ti:"$PORT" 2>/dev/null || true)
if [ -n "$PID" ]; then
  echo "-> Killing existing process on port $PORT (pid $PID)..."
  kill "$PID" 2>/dev/null || true
  sleep 1
else
  echo "-> No existing process on port $PORT"
fi

# 3. Restart
echo "-> Starting proxy on port $PORT (log: $LOG)..."
nohup node "$DIR/scripts/openclaw-proxy.mjs" > "$LOG" 2>&1 &
NEW_PID=$!

# 4. Wait for ready
for i in 1 2 3 4 5; do
  sleep 1
  if curl -s -o /dev/null -w "" "http://127.0.0.1:$PORT/health" 2>/dev/null; then
    echo ""
    echo "OK - proxy running on port $PORT (pid $NEW_PID)"
    exit 0
  fi
done

echo ""
echo "WARNING - proxy may not be ready yet, check $LOG"
exit 1

#!/usr/bin/env bash
# dev.sh — manage all Riverline services
# Usage:
#   ./scripts/dev.sh start    start Docker + worker + API
#   ./scripts/dev.sh stop     stop everything
#   ./scripts/dev.sh restart  stop then start
#   ./scripts/dev.sh status   show what's running
#   ./scripts/dev.sh logs     tail worker + API logs

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PID_FILE="$ROOT/.pids"
WORKER_LOG="/tmp/riverline-worker.log"
API_LOG="/tmp/riverline-api.log"
PNPM="$HOME/.local/bin/pnpm"

# ── Colours ───────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; RESET='\033[0m'
ok()   { echo -e "${GREEN}✓${RESET} $*"; }
warn() { echo -e "${YELLOW}!${RESET} $*"; }
err()  { echo -e "${RED}✗${RESET} $*"; }

# ── Helpers ───────────────────────────────────────────────────────────────────

wait_healthy() {
  local service="$1" max="${2:-30}" i=0
  printf "  Waiting for %s" "$service"
  until docker compose ps "$service" 2>/dev/null | grep -q "healthy"; do
    sleep 2; i=$((i+2)); printf "."
    if [ $i -ge $max ]; then echo; err "$service not healthy after ${max}s"; return 1; fi
  done
  echo; ok "$service is healthy"
}

wait_temporal() {
  local max=30 i=0
  printf "  Waiting for Temporal"
  until docker compose logs temporal 2>/dev/null | grep -q "Started Worker"; do
    sleep 2; i=$((i+2)); printf "."
    if [ $i -ge $max ]; then echo; warn "Temporal may still be starting..."; return 0; fi
  done
  echo; ok "Temporal is ready"
}

pid_is_running() { kill -0 "$1" 2>/dev/null; }

# ── Commands ──────────────────────────────────────────────────────────────────

cmd_start() {
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  Riverline — Starting all services"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # 1. Docker
  echo ""
  echo "▶ Starting Docker services..."
  cd "$ROOT"
  docker compose up -d postgres temporal temporal-ui 2>&1 | grep -E "Started|Running|Healthy|error" || true

  wait_healthy postgres 30
  wait_temporal

  # 2. Worker
  echo ""
  echo "▶ Starting Temporal worker..."
  pkill -f "worker.ts" 2>/dev/null || true
  sleep 1
  cd "$ROOT" && $PNPM run worker >"$WORKER_LOG" 2>&1 &
  WORKER_PID=$!
  sleep 6
  if pid_is_running $WORKER_PID && grep -q "RUNNING" "$WORKER_LOG" 2>/dev/null; then
    ok "Worker running (PID $WORKER_PID)"
  else
    err "Worker failed to start — check $WORKER_LOG"
  fi

  # 3. API
  echo ""
  echo "▶ Starting API server..."
  pkill -f "server.ts" 2>/dev/null || true
  sleep 1
  cd "$ROOT" && $PNPM run api >"$API_LOG" 2>&1 &
  API_PID=$!
  # Wait for the health endpoint (pnpm spawns tsx as a child — PID check is unreliable)
  printf "  Waiting for API"
  for i in $(seq 1 15); do
    sleep 1; printf "."
    if curl -sf http://localhost:3000/health >/dev/null 2>&1; then
      echo; ok "API server running"; break
    fi
    if [ $i -eq 15 ]; then echo; err "API failed to start — check $API_LOG"; fi
  done

  # Save PIDs
  echo "WORKER_PID=$WORKER_PID" > "$PID_FILE"
  echo "API_PID=$API_PID"      >> "$PID_FILE"

  # 4. Health check
  echo ""
  echo "▶ Health check..."
  sleep 1
  HEALTH=$(curl -sf http://localhost:3000/health 2>/dev/null || echo '{"status":"unreachable"}')
  if echo "$HEALTH" | grep -q '"status":"ok"'; then
    ok "GET /health → ok"
  else
    warn "API health: $HEALTH"
  fi

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  ok "All services started"
  echo ""
  echo "  API        → http://localhost:3000"
  echo "  Temporal   → http://localhost:8080"
  echo "  Worker log → $WORKER_LOG"
  echo "  API log    → $API_LOG"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
}

cmd_stop() {
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  Riverline — Stopping all services"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # Kill worker + API from PID file
  if [ -f "$PID_FILE" ]; then
    source "$PID_FILE"
    if [ -n "${WORKER_PID:-}" ] && pid_is_running "$WORKER_PID"; then
      kill "$WORKER_PID" 2>/dev/null && ok "Worker stopped (PID $WORKER_PID)"
    fi
    if [ -n "${API_PID:-}" ] && pid_is_running "$API_PID"; then
      kill "$API_PID" 2>/dev/null && ok "API stopped (PID $API_PID)"
    fi
    rm -f "$PID_FILE"
  fi

  # Fallback: pkill by name
  pkill -f "worker.ts" 2>/dev/null && ok "Worker killed (by name)" || true
  pkill -f "server.ts" 2>/dev/null && ok "API killed (by name)"   || true

  # Docker
  echo ""
  cd "$ROOT"
  docker compose down 2>&1 | grep -E "Stopped|Removed|error" || true
  ok "Docker services stopped"

  echo ""
  ok "All services stopped"
  echo ""
}

cmd_restart() {
  cmd_stop
  sleep 2
  cmd_start
}

cmd_status() {
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  Riverline — Service status"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""

  # Docker
  echo "  Docker containers:"
  cd "$ROOT"
  docker compose ps 2>/dev/null | grep -E "NAME|postgres|temporal" | \
    awk '{printf "    %-40s %s\n", $1, $4}' || warn "Docker not running"

  # Worker
  echo ""
  echo "  Worker:"
  if pgrep -f "temporal/worker.ts" >/dev/null 2>&1; then
    ok "  Running (PID $(pgrep -f 'temporal/worker.ts' | head -1))"
  else
    err "  Not running"
  fi

  # API
  echo ""
  echo "  API server:"
  HEALTH=$(curl -sf http://localhost:3000/health 2>/dev/null || echo '')
  if [ -n "$HEALTH" ]; then
    ok "  Running → http://localhost:3000"
    COST=$(curl -sf http://localhost:3000/cost 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"\${ d['totalCostUsd']}\")" 2>/dev/null || echo "n/a")
    echo "     LLM spend so far: $COST"
  else
    err "  Not responding"
  fi

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
}

cmd_logs() {
  echo "Tailing worker + API logs (Ctrl+C to exit)..."
  tail -f "$WORKER_LOG" "$API_LOG" 2>/dev/null || warn "No log files found — run ./scripts/dev.sh start first"
}

# ── Entry point ───────────────────────────────────────────────────────────────

CMD="${1:-help}"
case "$CMD" in
  start)   cmd_start   ;;
  stop)    cmd_stop    ;;
  restart) cmd_restart ;;
  status)  cmd_status  ;;
  logs)    cmd_logs    ;;
  *)
    echo ""
    echo "Usage: ./scripts/dev.sh [start|stop|restart|status|logs]"
    echo ""
    echo "  start    Start Docker (postgres + temporal + temporal-ui) + worker + API"
    echo "  stop     Stop worker + API + Docker containers"
    echo "  restart  stop then start"
    echo "  status   Show what's running + current LLM spend"
    echo "  logs     Tail worker and API logs"
    echo ""
    ;;
esac

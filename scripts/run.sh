#!/usr/bin/env bash
# run.sh — execute specific parts of the Riverline pipeline
# Usage:
#   ./scripts/run.sh eval              Full eval pipeline (EVAL_SEED=42, 3 iterations)
#   ./scripts/run.sh eval --quick      Quick smoke test (1 iteration, 5 conversations)
#   ./scripts/run.sh dgm               DGM demonstration (no API key needed)
#   ./scripts/run.sh trigger           Start one interactive borrower workflow
#   ./scripts/run.sh trigger --auto    Start one autonomous workflow (canned borrower)
#   ./scripts/run.sh chat <wfId> <msg> Send a chat message to a running workflow

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PNPM="$HOME/.local/bin/pnpm"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; RESET='\033[0m'
ok()   { echo -e "${GREEN}✓${RESET} $*"; }
info() { echo -e "${CYAN}→${RESET} $*"; }
warn() { echo -e "${YELLOW}!${RESET} $*"; }
err()  { echo -e "${RED}✗${RESET} $*"; }

check_api() {
  if ! curl -sf http://localhost:3000/health >/dev/null 2>&1; then
    err "API server not running. Start it first: ./scripts/dev.sh start"
    exit 1
  fi
}

check_env() {
  # Load .env first
  if [ -f "$ROOT/.env" ]; then
    set -o allexport
    source "$ROOT/.env"
    set +o allexport
  fi

  local provider="${LLM_PROVIDER:-openrouter}"

  if [ "$provider" = "cerebras" ]; then
    if [ -z "${CEREBRAS_API_KEY:-}" ]; then
      err "CEREBRAS_API_KEY not set. Add it to $ROOT/.env"
      exit 1
    fi
    ok "CEREBRAS_API_KEY loaded (provider: cerebras)"
  elif [ "$provider" = "groq" ]; then
    if [ -z "${GROQ_API_KEY:-}" ]; then
      err "GROQ_API_KEY not set. Add it to $ROOT/.env"
      exit 1
    fi
    ok "GROQ_API_KEY loaded (provider: groq)"
  elif [ "$provider" = "openrouter" ]; then
    if [ -z "${OPENROUTER_API_KEY:-}" ]; then
      err "OPENROUTER_API_KEY not set. Add it to $ROOT/.env"
      exit 1
    fi
    ok "OPENROUTER_API_KEY loaded (provider: openrouter)"
  elif [ "$provider" = "anthropic" ]; then
    if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
      err "ANTHROPIC_API_KEY not set. Add it to $ROOT/.env"
      exit 1
    fi
    ok "ANTHROPIC_API_KEY loaded (provider: anthropic)"
  fi
}

# ── Commands ──────────────────────────────────────────────────────────────────

cmd_eval() {
  local quick="${1:-}"
  check_env

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  Riverline Eval Pipeline"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  if [ "$quick" = "--quick" ]; then
    warn "Quick mode: 1 iteration, 5 conversations per version"
    export EVAL_SEED=42
    export EVAL_ITERATIONS=1
    export EVAL_CONVERSATIONS=5
  else
    info "Full mode: 3 iterations, 20 conversations per version, seed=42"
    export EVAL_SEED=42
  fi

  echo ""
  info "Loading .env..."
  set -o allexport
  source "$ROOT/.env" 2>/dev/null || true
  set +o allexport

  info "Running eval pipeline..."
  echo ""
  cd "$ROOT" && $PNPM run eval

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  ok "Eval complete"
  echo ""
  echo "  Results:"
  ls -lh "$ROOT/data/results/" 2>/dev/null | grep -v "^total\|\.gitkeep" | awk '{print "    "$NF, $5}' || warn "No results yet"
  echo ""
  info "Re-run: EVAL_SEED=42 pnpm run eval"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
}

cmd_dgm() {
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  Darwin Godel Machine — Demonstration"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  cd "$ROOT" && $PNPM exec tsx scripts/demo-dgm.ts
  echo ""
}

cmd_trigger() {
  local mode="${1:-}"
  check_api
  check_env

  set -o allexport
  source "$ROOT/.env" 2>/dev/null || true
  set +o allexport

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  Starting full pipeline demo"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # Use demo-live.ts for the full browser-based 3-agent flow
  info "Launching full pipeline: Agent 1 (chat) → Agent 2 (voice) → Agent 3 (chat)"
  echo "  Chrome will open automatically for each stage."
  echo ""
  cd "$ROOT" && $PNPM exec tsx scripts/demo-live.ts
  return 0

  # Legacy manual flow below (kept for reference)
  RESPONSE=$(curl -sf -X POST http://localhost:3000/borrowers/demo-001/start \
    -H "Content-Type: application/json" \
    -d "{
      \"borrowerProfile\": {
        \"borrowerId\": \"demo-001\",
        \"name\": \"Jane Doe\",
        \"partialAccountNumber\": \"4321\",
        \"debtAmount\": 12000,
        \"loanType\": \"personal\"
      }
    }" 2>/dev/null)

  if [ -z "$RESPONSE" ]; then
    err "Failed to trigger workflow — is the API running?"
    exit 1
  fi

  WF_ID=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['workflowId'])" 2>/dev/null || echo "unknown")

  echo ""
  ok "Workflow started"
  echo "  Workflow ID : $WF_ID"
  echo "  Temporal UI : http://localhost:8080"
  echo ""

  if [ "$mode" != "--auto" ]; then
    echo "  Agent 1 chat: http://localhost:3000/agent1?wfId=$WF_ID"
    echo ""
    echo "  Or use ./scripts/run.sh chat $WF_ID 'Hello, I received your message'"
  fi

  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
}

cmd_chat() {
  local wf_id="${1:-}"
  local message="${2:-}"

  if [ -z "$wf_id" ] || [ -z "$message" ]; then
    err "Usage: ./scripts/run.sh chat <workflowId> <message>"
    exit 1
  fi

  check_api

  echo ""
  info "Sending message to workflow $wf_id..."
  echo ""

  RESPONSE=$(curl -sf -X POST "http://localhost:3000/chat/$wf_id/message" \
    -H "Content-Type: application/json" \
    -d "{\"message\": \"$message\"}" 2>/dev/null)

  if [ -z "$RESPONSE" ]; then
    err "No response — check workflow is still running"
    exit 1
  fi

  REPLY=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('reply',''))" 2>/dev/null || echo "$RESPONSE")
  echo -e "${GREEN}Agent:${RESET} $REPLY"
  echo ""
}

# ── Entry point ───────────────────────────────────────────────────────────────

CMD="${1:-help}"
shift || true

case "$CMD" in
  eval)    cmd_eval "${1:-}"    ;;
  dgm)     cmd_dgm              ;;
  trigger) cmd_trigger "${1:-}" ;;
  chat)    cmd_chat "$@"        ;;
  *)
    echo ""
    echo "Usage: ./scripts/run.sh <command> [options]"
    echo ""
    echo "  eval [--quick]           Full eval pipeline (3 iterations, seed=42)"
    echo "                           --quick: 1 iteration, 5 conversations (smoke test)"
    echo ""
    echo "  dgm                      Darwin Godel Machine demo (no API key needed)"
    echo ""
    echo "  trigger [--auto]         Start a borrower workflow"
    echo "                           --auto: autonomous mode (canned script, no chat)"
    echo ""
    echo "  chat <wfId> <message>    Send a chat message to a running workflow"
    echo ""
    echo "Examples:"
    echo "  ./scripts/run.sh eval --quick"
    echo "  ./scripts/run.sh trigger"
    echo "  ./scripts/run.sh chat borrower-demo-001-xxx 'I got your message'"
    echo ""
    ;;
esac

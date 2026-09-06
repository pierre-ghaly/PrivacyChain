#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# PrivacyChain — one-command local dev environment
#
# What it does:
#   1. Starts a Hardhat local node (chain 31337) on http://127.0.0.1:8545
#   2. Deploys the smart contracts → writes shared/deployments/localhost.json
#   3. Starts L2 (key-management service) on http://127.0.0.1:3001
#      L2 subscribes to L1 events and begins deriving keys immediately.
#   4. Starts L3 (encrypted-storage service) on http://127.0.0.1:3002
#   5. Seeds the chain with deterministic fixtures (registered users, assets,
#      transfers) so every `npm run dev` has the same realistic starting state.
#      Skip with --no-seed.
#   6. Serves shared/setup.html on http://127.0.0.1:8080/setup.html
#      — a one-click helper to add the Hardhat network to MetaMask.
#   7. Starts the Frontend dev server (if Frontend/package.json exists).
#
# Flags:
#   --no-seed    skip fixture seeding (deploy-only)
#
# Press Ctrl+C to stop everything cleanly.
# -----------------------------------------------------------------------------
set -euo pipefail

# --- Node version enforcement ------------------------------------------------
# Helia (L3) requires Node 22+. Load nvm if available and switch to the
# version pinned in .nvmrc. If nvm is not installed, check manually.
REQUIRED_NODE_MAJOR=22
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck source=/dev/null
  \. "$NVM_DIR/nvm.sh"
  nvm use --silent 2>/dev/null || nvm use "$REQUIRED_NODE_MAJOR" --silent 2>/dev/null || true
fi
CURRENT_NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))" 2>/dev/null || echo "0")
if [ "$CURRENT_NODE_MAJOR" -lt "$REQUIRED_NODE_MAJOR" ]; then
  printf "\033[1;31m[dev-up]\033[0m Node %s detected, but Node %s+ is required (Helia).\n" \
    "$(node --version 2>/dev/null || echo 'unknown')" "$REQUIRED_NODE_MAJOR"
  printf "\033[1;31m[dev-up]\033[0m Run \`nvm install %s && nvm use %s\` then retry.\n" \
    "$REQUIRED_NODE_MAJOR" "$REQUIRED_NODE_MAJOR"
  exit 1
fi

RUN_SEED=1
for arg in "$@"; do
  case "$arg" in
    --no-seed) RUN_SEED=0 ;;
    -h|--help)
      echo "Usage: $0 [--no-seed]"
      exit 0 ;;
    *) echo "Unknown flag: $arg" >&2; exit 1 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_DIR="$ROOT/.dev"
HARDHAT_LOG="$DEV_DIR/hardhat.log"
L2_LOG="$DEV_DIR/l2.log"
L3_LOG="$DEV_DIR/l3.log"
SETUP_LOG="$DEV_DIR/setup-server.log"
FRONTEND_LOG="$DEV_DIR/frontend.log"
DEPLOYMENT_FILE="$ROOT/shared/deployments/localhost.json"

HARDHAT_RPC="http://127.0.0.1:8545"
L2_PORT=3001
L3_PORT=3002
SETUP_PORT=8080
SETUP_URL="http://127.0.0.1:${SETUP_PORT}/setup.html"

HARDHAT_PID=""
L2_PID=""
L3_PID=""
SETUP_PID=""
FRONTEND_PID=""

mkdir -p "$DEV_DIR" "$ROOT/shared/deployments"

log()   { printf "\033[1;36m[dev-up]\033[0m %s\n" "$*"; }
warn()  { printf "\033[1;33m[dev-up]\033[0m %s\n" "$*"; }
error() { printf "\033[1;31m[dev-up]\033[0m %s\n" "$*" 1>&2; }

cleanup() {
  echo ""
  log "Shutting down..."
  for pid_var in FRONTEND_PID SETUP_PID L3_PID L2_PID HARDHAT_PID; do
    pid="${!pid_var:-}"
    if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; fi
  done
  if command -v lsof >/dev/null 2>&1; then
    for port in 8545 "$L2_PORT" "$L3_PORT" "$SETUP_PORT"; do
      L=$(lsof -t -i:$port 2>/dev/null || true)
      if [[ -n "$L" ]]; then kill $L 2>/dev/null || true; fi
    done
  fi
  log "Done."
}
trap cleanup EXIT INT TERM

open_url() {
  local url="$1"
  if   command -v open       >/dev/null 2>&1; then open "$url" >/dev/null 2>&1 || true
  elif command -v xdg-open   >/dev/null 2>&1; then xdg-open "$url" >/dev/null 2>&1 || true
  elif command -v start      >/dev/null 2>&1; then start "$url" >/dev/null 2>&1 || true
  fi
}

wait_for_http() {
  local url="$1" label="$2" pid="$3" max="${4:-30}"
  for i in $(seq 1 "$max"); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      log "$label is up."
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      error "$label process died unexpectedly. Check the log."
      return 1
    fi
    sleep 1
  done
  error "$label did not become ready within ${max}s."
  return 1
}

# --- Preflight ---------------------------------------------------------------
command -v npx     >/dev/null 2>&1 || { error "npx not found. Install Node.js (>=18)."; exit 1; }
command -v python3 >/dev/null 2>&1 || { error "python3 not found (needed for the setup helper server)."; exit 1; }

if command -v lsof >/dev/null 2>&1; then
  for port in 8545 "$L2_PORT" "$L3_PORT" "$SETUP_PORT"; do
    if lsof -Pi :$port -sTCP:LISTEN -t >/dev/null 2>&1; then
      error "Port $port is already in use. Stop that process and retry."
      exit 1
    fi
  done
fi

# --- Install deps ------------------------------------------------------------
if [[ ! -d "$ROOT/node_modules" ]]; then
  log "Installing workspace dependencies (first-time setup)..."
  (cd "$ROOT" && npm install)
fi

# --- Copy .env files if not present -----------------------------------------
for svc in L2 L3; do
  if [[ ! -f "$ROOT/$svc/.env" && -f "$ROOT/$svc/.env.example" ]]; then
    cp "$ROOT/$svc/.env.example" "$ROOT/$svc/.env"
    log "Created $svc/.env from .env.example"
  fi
done

# --- Clean stale OpenZeppelin upgrades manifest for this local chain ---------
rm -f "$ROOT/SmartContracts/.openzeppelin/unknown-31337.json"

# --- Start Hardhat node ------------------------------------------------------
log "Starting Hardhat node (log: $HARDHAT_LOG)..."
(cd "$ROOT/SmartContracts" && exec npx hardhat node) > "$HARDHAT_LOG" 2>&1 &
HARDHAT_PID=$!

log "Waiting for Hardhat node on $HARDHAT_RPC ..."
for i in $(seq 1 60); do
  if curl -fsS -X POST -H "Content-Type: application/json" \
       --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
       "$HARDHAT_RPC" >/dev/null 2>&1; then
    log "Hardhat node is up."
    break
  fi
  if ! kill -0 "$HARDHAT_PID" 2>/dev/null; then
    error "Hardhat node process died. See $HARDHAT_LOG"; exit 1
  fi
  sleep 1
  if [[ $i -eq 60 ]]; then
    error "Hardhat node did not become ready within 60 seconds."
    error "Check log: $HARDHAT_LOG"; exit 1
  fi
done

# --- Deploy contracts --------------------------------------------------------
log "Deploying contracts to localhost..."
(cd "$ROOT/SmartContracts" && npx hardhat run scripts/deploy.ts --network localhost)

if [[ ! -f "$DEPLOYMENT_FILE" ]]; then
  error "Deployment artifact not found at $DEPLOYMENT_FILE"; exit 1
fi
CONTRACT_ADDR=$(node -e "console.log(require('$DEPLOYMENT_FILE').contracts.AssetRegistry.address)")

# --- Start L2 (Key Management Service) ---------------------------------------
# Wipe L2's SQLite key store before each run — Hardhat's chain (and therefore
# its txIds and asset IDs) resets to zero on every restart, but the SQLite
# file otherwise persists, so old txId/assetId numbers would collide with the
# new chain's and resolve to stale, since-deleted L3 CIDs.
rm -f "$ROOT/L2/.data/keys.db"
# L2 must start BEFORE seeding so it catches all events emitted during seed.
log "Starting L2 key-management service on :${L2_PORT} (log: $L2_LOG)..."
(cd "$ROOT/L2" && exec npx tsx src/index.ts) > "$L2_LOG" 2>&1 &
L2_PID=$!
wait_for_http "http://127.0.0.1:${L2_PORT}/health" "L2" "$L2_PID" 30

# --- Start L3 (Encrypted Storage Service) ------------------------------------
# Wipe the libp2p/Helia peer store before each run — stale peer records from a
# prior run (or after a dep upgrade) cause a non-base32 decode crash on startup.
# Pinned IPFS blocks (.data/ipfs/blocks/) are also cleared; the seed script
# re-pins everything fresh, so this is safe on a local dev chain. This also
# wipes L3's own (txId, dataType) -> CID index (.data/cids.db) — same
# staleness reasoning as L2's keys.db wipe above: the chain's txIds reset to
# zero too, so old entries would collide with the new chain's.
rm -rf "$ROOT/L3/.data"
log "Starting L3 encrypted-storage service on :${L3_PORT} (log: $L3_LOG)..."
(cd "$ROOT/L3" && exec npx tsx src/index.ts) > "$L3_LOG" 2>&1 &
L3_PID=$!
wait_for_http "http://127.0.0.1:${L3_PORT}/health" "L3" "$L3_PID" 60

# --- Seed fixtures (users, assets, transfers) --------------------------------
if [[ "$RUN_SEED" -eq 1 ]]; then
  if [[ -f "$ROOT/SmartContracts/scripts/seed.ts" ]]; then
    log "Seeding deterministic fixtures..."
    (cd "$ROOT/SmartContracts" && npx hardhat run scripts/seed.ts --network localhost)
  else
    warn "No seed.ts found — skipping seed step."
  fi
else
  log "Skipping seed (--no-seed)."
fi

# --- Start setup-helper static server ----------------------------------------
log "Starting MetaMask setup helper on port $SETUP_PORT..."
(cd "$ROOT/shared" && exec python3 -m http.server "$SETUP_PORT" --bind 127.0.0.1) \
  > "$SETUP_LOG" 2>&1 &
SETUP_PID=$!
wait_for_http "$SETUP_URL" "Setup helper" "$SETUP_PID" 20

if [[ -z "${CI:-}" && -z "${PLAYWRIGHT_TEST:-}" ]]; then
  log "Opening setup helper in browser: $SETUP_URL"
  open_url "$SETUP_URL"
fi

# --- Ready banner ------------------------------------------------------------
cat <<BANNER

============================================================
  PrivacyChain dev environment is READY
============================================================

  Chain (L1):       http://127.0.0.1:8545  (chainId 31337)
  AssetRegistry:    $CONTRACT_ADDR
  Deployment file:  $DEPLOYMENT_FILE

  L2 (key mgmt):    http://127.0.0.1:${L2_PORT}
    GET  /health              service status
    GET  /keys/:txId          fetch Kr (L3 internal use)
    GET  /events?user=<addr>  SSE stream  ← Frontend subscribes here
    GET  /status/:user        key destruction status
    Logs: $L2_LOG

  L3 (storage):     http://127.0.0.1:${L3_PORT}
    GET  /health                          service status
    POST /store                           encrypt + pin to IPFS
    GET  /retrieve/:cid?txId=<id>         decrypt from IPFS
    Logs: $L3_LOG

  MetaMask setup:   $SETUP_URL

  --- Stop everything: press Ctrl+C ---
============================================================

BANNER

# --- Frontend ----------------------------------------------------------------
if [[ -f "$ROOT/Frontend/package.json" ]]; then
  log "Starting Frontend dev server..."
  if [[ ! -d "$ROOT/Frontend/node_modules" ]]; then
    log "Installing Frontend dependencies (first-time)..."
    (cd "$ROOT/Frontend" && npm install)
  fi
  (cd "$ROOT/Frontend" && exec npm run dev) 2>&1 | tee "$FRONTEND_LOG" &
  FRONTEND_PID=$!
  wait "$FRONTEND_PID"
else
  warn "Frontend/package.json not found — skipping frontend startup."
  log "L1 + L2 + L3 are running. Press Ctrl+C to stop."
  wait "$HARDHAT_PID"
fi

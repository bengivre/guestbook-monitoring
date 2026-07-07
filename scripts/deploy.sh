#!/usr/bin/env bash
#
# deploy.sh — bootstrap a local kind cluster and deploy the Guestbook + the
#             Prometheus/Grafana monitoring stack onto it with Pulumi.
#
# It will:
#   1. verify required tooling (docker, kind, kubectl, pulumi, node/npm),
#      offering a `brew` install on macOS for anything missing;
#   2. create a kind cluster (or reuse a running one);
#   3. wait until the cluster + nodes are Ready;
#   4. run `pulumi up` against that cluster's kube-context;
#   5. print the Guestbook URL, Grafana URL and admin credentials.
#
# Config comes from a .env file (auto-loaded) and/or `--interactive` prompts.
#
# Usage:
#   ./scripts/deploy.sh                     # use .env / defaults, non-interactive
#   ./scripts/deploy.sh --interactive       # prompt for each setting
#   ./scripts/deploy.sh --env-file prod.env # load a specific env file
#   ./scripts/deploy.sh --destroy           # tear down the stack and delete the cluster
#   ./scripts/deploy.sh --yes               # skip the final confirmation prompt
#
set -Eeuo pipefail

# ---------------------------------------------------------------------------
# Pretty output helpers
# ---------------------------------------------------------------------------
if [[ -t 1 ]]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'
  YLW=$'\033[33m'; BLU=$'\033[34m'; RST=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GRN=""; YLW=""; BLU=""; RST=""
fi
step() { printf "\n${BOLD}${BLU}==>${RST} ${BOLD}%s${RST}\n" "$*"; }
info() { printf "    %s\n" "$*"; }
ok()   { printf "    ${GRN}✓${RST} %s\n" "$*"; }
warn() { printf "    ${YLW}!${RST} %s\n" "$*"; }
die()  { printf "\n${RED}✗ %s${RST}\n" "$*" >&2; exit 1; }

trap 'die "Failed at line $LINENO. See output above."' ERR

# ---------------------------------------------------------------------------
# Defaults (overridable via .env or --interactive)
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

CLUSTER_NAME="${CLUSTER_NAME:-guestbook}"
KIND_WORKER_NODES="${KIND_WORKER_NODES:-2}"
GRAFANA_NODE_PORT="${GRAFANA_NODE_PORT:-30080}"
FRONTEND_NODE_PORT="${FRONTEND_NODE_PORT:-30081}"
PULUMI_STACK="${PULUMI_STACK:-dev}"
PULUMI_BACKEND_URL="${PULUMI_BACKEND_URL:-file://~}"
PULUMI_CONFIG_PASSPHRASE="${PULUMI_CONFIG_PASSPHRASE:-guestbook}"
GRAFANA_ADMIN_PASSWORD="${GRAFANA_ADMIN_PASSWORD:-prom-operator}"

INTERACTIVE=false
ASSUME_YES=false
DESTROY=false
ENV_FILE=".env"

# ---------------------------------------------------------------------------
# Arg parsing
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    -i|--interactive) INTERACTIVE=true; shift ;;
    -y|--yes)         ASSUME_YES=true;  shift ;;
    --destroy)        DESTROY=true;     shift ;;
    --env-file)       ENV_FILE="$2";    shift 2 ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//' | sed '/^!/d'; exit 0 ;;
    *) die "Unknown argument: $1 (try --help)" ;;
  esac
done

# ---------------------------------------------------------------------------
# Load .env
# ---------------------------------------------------------------------------
if [[ -f "$ENV_FILE" ]]; then
  step "Loading environment from ${ENV_FILE}"
  set -a; # shellcheck disable=SC1090
  source "$ENV_FILE"; set +a
  ok "Loaded ${ENV_FILE}"
else
  warn "No ${ENV_FILE} found — using defaults (copy config/.env.example to .env to customize)."
fi

KUBE_CONTEXT="kind-${CLUSTER_NAME}"

# ---------------------------------------------------------------------------
# Interactive prompts
# ---------------------------------------------------------------------------
ask() { # ask VAR "Prompt" [secret]
  local __var="$1" __prompt="$2" __secret="${3:-}" __cur="${!1}" __ans
  if [[ "$__secret" == "secret" ]]; then
    read -rsp "    ${__prompt} [${DIM}hidden${RST}]: " __ans; echo
  else
    read -rp "    ${__prompt} [${DIM}${__cur}${RST}]: " __ans
  fi
  [[ -n "$__ans" ]] && printf -v "$__var" '%s' "$__ans"
}

if [[ "$INTERACTIVE" == true ]]; then
  step "Interactive configuration (press Enter to keep the shown default)"
  ask CLUSTER_NAME            "kind cluster name"
  ask KIND_WORKER_NODES       "Number of worker nodes"
  ask GRAFANA_NODE_PORT       "Grafana NodePort -> host port"
  ask FRONTEND_NODE_PORT      "Guestbook NodePort -> host port"
  ask PULUMI_STACK            "Pulumi stack name"
  ask PULUMI_BACKEND_URL      "Pulumi backend URL"
  ask PULUMI_CONFIG_PASSPHRASE "Pulumi config passphrase" secret
  ask GRAFANA_ADMIN_PASSWORD  "Grafana admin password" secret
  KUBE_CONTEXT="kind-${CLUSTER_NAME}"
fi

export PULUMI_BACKEND_URL PULUMI_CONFIG_PASSPHRASE

# ---------------------------------------------------------------------------
# 1. Tooling checks
# ---------------------------------------------------------------------------
IS_MAC=false
[[ "$(uname -s)" == "Darwin" ]] && IS_MAC=true

have() { command -v "$1" >/dev/null 2>&1; }

brew_pkg() { # brew_pkg <cmd> <brew-formula-or-cask> [cask]
  local cmd="$1" formula="$2" cask="${3:-}"
  if have brew; then
    read -rp "    Install '${cmd}' via Homebrew now? [Y/n]: " a
    if [[ "${a:-Y}" =~ ^[Yy]?$ ]]; then
      if [[ "$cask" == "cask" ]]; then brew install --cask "$formula"; else brew install "$formula"; fi
      return 0
    fi
  fi
  return 1
}

require_tool() { # require_tool <cmd> <brew-formula> [cask] [manual-url]
  local cmd="$1" formula="$2" cask="${3:-}" url="${4:-}"
  if have "$cmd"; then ok "$cmd $(command -v "$cmd" | sed "s|$HOME|~|")"; return; fi
  warn "'$cmd' not found."
  if [[ "$IS_MAC" == true ]]; then
    if ! have brew; then
      die "Homebrew is not installed. Install it from https://brew.sh then re-run, or install '$cmd' manually."
    fi
    brew_pkg "$cmd" "$formula" "$cask" && have "$cmd" && { ok "$cmd installed"; return; }
    die "'$cmd' is still missing. Install it and re-run."
  else
    die "'$cmd' is required. On Linux install it manually${url:+ (see $url)}."
  fi
}

step "Checking required tools"
require_tool docker  docker  cask   "https://docs.docker.com/engine/install/"
require_tool kind    kind    ""     "https://kind.sigs.k8s.io/docs/user/quick-start/"
require_tool kubectl kubectl ""     "https://kubernetes.io/docs/tasks/tools/"
require_tool pulumi  pulumi  ""     "https://www.pulumi.com/docs/install/"
require_tool node    node    ""     "https://nodejs.org/"
have npm || die "npm is required (ships with Node.js)."
ok "npm $(command -v npm | sed "s|$HOME|~|")"

step "Checking the Docker daemon"
docker info >/dev/null 2>&1 || die "Docker is installed but not running. Start Docker Desktop / the daemon and re-run."
ok "Docker daemon is running"

# ---------------------------------------------------------------------------
# Destroy path
# ---------------------------------------------------------------------------
if [[ "$DESTROY" == true ]]; then
  step "Tearing down"
  if kind get clusters 2>/dev/null | grep -qx "$CLUSTER_NAME"; then
    if pulumi stack select "$PULUMI_STACK" >/dev/null 2>&1; then
      info "Running pulumi destroy…"
      pulumi destroy --yes || warn "pulumi destroy reported errors (continuing to delete cluster)."
    fi
    kind delete cluster --name "$CLUSTER_NAME"
    ok "Deleted kind cluster '${CLUSTER_NAME}'."
  else
    warn "No kind cluster named '${CLUSTER_NAME}' to delete."
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# 2. Cluster bootstrap
# ---------------------------------------------------------------------------
step "Ensuring kind cluster '${CLUSTER_NAME}' exists"
if kind get clusters 2>/dev/null | grep -qx "$CLUSTER_NAME"; then
  ok "Cluster '${CLUSTER_NAME}' already running — reusing it."
else
  info "Creating cluster with 1 control-plane + ${KIND_WORKER_NODES} worker node(s)…"
  {
    echo "kind: Cluster"
    echo "apiVersion: kind.x-k8s.io/v1alpha4"
    echo "nodes:"
    echo "  - role: control-plane"
    echo "    extraPortMappings:"
    echo "      - containerPort: ${GRAFANA_NODE_PORT}"
    echo "        hostPort: ${GRAFANA_NODE_PORT}"
    echo "        protocol: TCP"
    echo "      - containerPort: ${FRONTEND_NODE_PORT}"
    echo "        hostPort: ${FRONTEND_NODE_PORT}"
    echo "        protocol: TCP"
    for ((i=0; i<KIND_WORKER_NODES; i++)); do echo "  - role: worker"; done
  } > /tmp/kind-${CLUSTER_NAME}.yaml
  kind create cluster --name "$CLUSTER_NAME" --config "/tmp/kind-${CLUSTER_NAME}.yaml" --wait 120s
  ok "Cluster '${CLUSTER_NAME}' created."
fi

kubectl config use-context "$KUBE_CONTEXT" >/dev/null
ok "kubectl context set to '${KUBE_CONTEXT}'."

# ---------------------------------------------------------------------------
# 3. Wait for readiness
# ---------------------------------------------------------------------------
step "Waiting for all nodes to be Ready"
kubectl wait --for=condition=Ready nodes --all --timeout=180s >/dev/null
ok "All nodes Ready."
info "Waiting for core system pods (kube-system)…"
kubectl wait --for=condition=Ready pods --all -n kube-system --timeout=180s >/dev/null 2>&1 || \
  warn "Some kube-system pods not Ready yet (continuing)."
kubectl get nodes

# ---------------------------------------------------------------------------
# 4. Pulumi deploy
# ---------------------------------------------------------------------------
step "Preparing Pulumi"
if [[ -z "${PULUMI_ACCESS_TOKEN:-}" ]]; then
  info "Logging into Pulumi backend: ${PULUMI_BACKEND_URL}"
  pulumi login "$PULUMI_BACKEND_URL" >/dev/null
else
  info "Using Pulumi service backend (PULUMI_ACCESS_TOKEN set)."
  pulumi login >/dev/null
fi

if [[ ! -d node_modules ]]; then
  info "Installing npm dependencies…"
  npm install --silent
fi
ok "Dependencies ready."

info "Selecting stack '${PULUMI_STACK}'…"
pulumi stack select "$PULUMI_STACK" 2>/dev/null || pulumi stack init "$PULUMI_STACK"

info "Applying configuration…"
pulumi config set useLoadBalancer false
pulumi config set localKindCluster true
pulumi config set grafanaNodePort  "$GRAFANA_NODE_PORT"
pulumi config set frontendNodePort "$FRONTEND_NODE_PORT"
pulumi config set --secret grafanaAdminPassword "$GRAFANA_ADMIN_PASSWORD"

step "Deploying with Pulumi (this can take a few minutes)"
if [[ "$ASSUME_YES" == true ]]; then
  pulumi up --yes
else
  pulumi up
fi

# ---------------------------------------------------------------------------
# 5. Output access details
# ---------------------------------------------------------------------------
step "Deployment complete 🎉"
GRAFANA_PW="$(pulumi stack output grafanaAdminPassword --show-secrets 2>/dev/null || echo "$GRAFANA_ADMIN_PASSWORD")"

cat <<EOF

${BOLD}Guestbook${RST}
  URL:        http://localhost:${FRONTEND_NODE_PORT}

${BOLD}Grafana${RST}
  URL:        http://localhost:${GRAFANA_NODE_PORT}
  Dashboard:  Dashboards → "Guestbook Overview"
  Username:   admin
  Password:   ${GRAFANA_PW}

${BOLD}Verify Prometheus is scraping the Guestbook${RST}
  kubectl -n monitoring port-forward svc/kps-kube-prometheus-stack-prometheus 9090
  open http://localhost:9090  →  Status → Target health
  (look for serviceMonitor/guestbook/redis-leader & redis-follower = UP)
  (control-plane targets are disabled automatically on kind)

${BOLD}Tear everything down${RST}
  ./scripts/deploy.sh --destroy

${DIM}kube-context: ${KUBE_CONTEXT}${RST}
EOF

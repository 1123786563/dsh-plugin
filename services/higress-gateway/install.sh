#!/usr/bin/env bash
# Wrap the official Higress AI gateway one-click installer so the port plan
# is env-driven and reproducible from this repo. The installer starts the
# gateway (Envoy), the console, and their dependencies as Docker containers.
#
# Env (see .env.example):
#   GATEWAY_HTTP_PORT   default 8080  — the OpenAI-compatible data plane
#   GATEWAY_HTTPS_PORT  default 8443
#   CONSOLE_PORT        default 8001  — the admin console
#   HIGRESS_INSTALL_SCRIPT_URL — override to pin a different installer
set -euo pipefail

# Load the sibling .env when present (README documents this workflow);
# real environment variables win because .env is only a fallback here.
_env_file="$(cd "$(dirname "$0")" && pwd)/.env"
if [ -f "$_env_file" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$_env_file"
  set +a
fi

GATEWAY_HTTP_PORT="${GATEWAY_HTTP_PORT:-8080}"
GATEWAY_HTTPS_PORT="${GATEWAY_HTTPS_PORT:-8443}"
CONSOLE_PORT="${CONSOLE_PORT:-8001}"
SCRIPT_URL="${HIGRESS_INSTALL_SCRIPT_URL:-https://higress.cn/ai-gateway/install.sh}"

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT
curl -fsSL "$SCRIPT_URL" -o "$workdir/install.sh"

# The official installer reads these exact names (its own DEFAULT_* are
# unconditional assignments, so exporting DEFAULT_* is a no-op there).
# CONSOLE_PORT is the installer's own console port variable name.
export GATEWAY_HTTP_PORT GATEWAY_HTTPS_PORT CONSOLE_PORT

echo "==> Installing Higress AI gateway (http ${GATEWAY_HTTP_PORT}, https ${GATEWAY_HTTPS_PORT}, console ${CONSOLE_PORT})"
bash "$workdir/install.sh"

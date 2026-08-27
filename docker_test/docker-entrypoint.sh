#!/usr/bin/env bash
set -euo pipefail

quote_env_value() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

MATE_HOME="${MATE_HOME:-/root/.mate}"
mkdir -p "$MATE_HOME"

if [[ -n "${OPENAI_API_KEY:-}" || -n "${OPENAI_BASE_URL:-}" || -n "${OPENAI_MODEL:-}" ]]; then
  cat > "$MATE_HOME/keys.env" <<EOF
OPENAI_API_KEY=$(quote_env_value "${OPENAI_API_KEY:-test-key}")
OPENAI_BASE_URL=$(quote_env_value "${OPENAI_BASE_URL:-https://api.openai.com/v1}")
OPENAI_MODEL=$(quote_env_value "${OPENAI_MODEL:-gpt-4.1-mini}")
EOF
  chmod 600 "$MATE_HOME/keys.env"
fi

exec "$@"

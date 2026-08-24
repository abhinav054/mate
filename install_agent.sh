#!/usr/bin/env bash
if [ -z "${BASH_VERSION:-}" ]; then
  exec bash "$0" "$@"
fi
set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]:-$0}"
AGENTS_HOME="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
OPENAI_API_KEY="${OPENAI_API_KEY:-}"
OPENAI_BASE_URL="${OPENAI_BASE_URL:-}"
OPENAI_MODEL="${OPENAI_MODEL:-}"

usage() {
  echo "Usage: $0 [--api-key KEY] [--base-url URL] [--model MODEL]"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-key)
      OPENAI_API_KEY="${2:-}"
      shift 2
      ;;
    --base-url)
      OPENAI_BASE_URL="${2:-}"
      shift 2
      ;;
    --model)
      OPENAI_MODEL="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

prompt_if_missing() {
  local var_name="$1"
  local prompt="$2"
  local default_value="${3:-}"
  local secret="${4:-0}"
  local current_value="${!var_name:-}"

  if [[ -n "$current_value" ]]; then
    return
  fi

  if [[ "$secret" == "1" ]]; then
    read -rsp "$prompt: " current_value
    echo
  elif [[ -n "$default_value" ]]; then
    read -rp "$prompt [$default_value]: " current_value
    current_value="${current_value:-$default_value}"
  else
    read -rp "$prompt: " current_value
  fi

  printf -v "$var_name" '%s' "$current_value"
}

quote_env_value() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

prompt_if_missing OPENAI_API_KEY "OpenAI-compatible API key" "" 1
prompt_if_missing OPENAI_BASE_URL "OpenAI-compatible base URL" "https://api.openai.com/v1"
prompt_if_missing OPENAI_MODEL "OpenAI-compatible model" "gpt-4.1-mini"

cd "$AGENTS_HOME"

if [[ ! -d ".venv" ]]; then
  "$PYTHON_BIN" -m venv .venv
fi

# shellcheck disable=SC1091
source "$AGENTS_HOME/.venv/bin/activate"

python -m pip install --upgrade pip
python -m pip install -e "$AGENTS_HOME"

mkdir -p "$AGENTS_HOME/.mate"
cat > "$AGENTS_HOME/.mate/keys.env" <<EOF
OPENAI_API_KEY=$(quote_env_value "$OPENAI_API_KEY")
OPENAI_BASE_URL=$(quote_env_value "$OPENAI_BASE_URL")
OPENAI_MODEL=$(quote_env_value "$OPENAI_MODEL")
EOF
chmod 600 "$AGENTS_HOME/.mate/keys.env"

echo "Installed Mate."
echo "Saved model settings to: $AGENTS_HOME/.mate/keys.env"
echo "Run with a new temporary workspace: $AGENTS_HOME/run_agent.sh"
echo "Run from any project with: $AGENTS_HOME/run_agent.sh /path/to/workspace"

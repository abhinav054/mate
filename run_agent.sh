#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]:-$0}"
AGENTS_HOME="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
WORKSPACE="${1:-}"

if [[ -n "$WORKSPACE" && ! -d "$WORKSPACE" ]]; then
  echo "Workspace does not exist: $WORKSPACE" >&2
  exit 1
fi

export AGENT_RESOURCES_DIR="${AGENT_RESOURCES_DIR:-$AGENTS_HOME/agent_resources}"
export MATE_HOME="${MATE_HOME:-$AGENTS_HOME/.mate}"

if [[ -f "$AGENTS_HOME/.venv/bin/activate" ]]; then
  # shellcheck disable=SC1091
  source "$AGENTS_HOME/.venv/bin/activate"
elif [[ -f "$AGENTS_HOME/agent_terminal/.venv/bin/activate" ]]; then
  # shellcheck disable=SC1091
  source "$AGENTS_HOME/agent_terminal/.venv/bin/activate"
fi

if command -v mate >/dev/null 2>&1; then
  MATE_CMD=(mate)
elif command -v agent-terminal >/dev/null 2>&1; then
  MATE_CMD=(agent-terminal)
else
  MATE_CMD=(python -m agent_terminal.main)
  export PYTHONPATH="$AGENTS_HOME${PYTHONPATH:+:$PYTHONPATH}"
fi

if [[ -n "$WORKSPACE" ]]; then
  cd "$WORKSPACE"
  exec "${MATE_CMD[@]}" "$WORKSPACE"
fi

exec "${MATE_CMD[@]}"

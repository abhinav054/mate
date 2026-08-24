#!/usr/bin/env bash
if [ -z "${BASH_VERSION:-}" ]; then
  exec bash "$0" "$@"
fi
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/share/mate}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
REPO="${REPO:-abhinav054/mate}"
RELEASE_URL="${RELEASE_URL:-}"
SOURCE_DIR="${SOURCE_DIR:-}"
OPENAI_API_KEY="${OPENAI_API_KEY:-}"
OPENAI_BASE_URL="${OPENAI_BASE_URL:-}"
OPENAI_MODEL="${OPENAI_MODEL:-}"

usage() {
  echo "Usage: $0 [--release-url URL | --source-dir DIR] [--install-dir DIR] [--bin-dir DIR] [--api-key KEY] [--base-url URL] [--model MODEL]"
  echo "If neither --release-url nor --source-dir is set, the latest GitHub release tarball is used."
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --release-url)
      RELEASE_URL="${2:-}"
      shift 2
      ;;
    --source-dir)
      SOURCE_DIR="${2:-}"
      shift 2
      ;;
    --install-dir)
      INSTALL_DIR="${2:-}"
      shift 2
      ;;
    --bin-dir)
      BIN_DIR="${2:-}"
      shift 2
      ;;
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

latest_release_url() {
  local release_metadata release_metadata_url release_url

  if ! command -v curl >/dev/null 2>&1; then
    echo "curl is required to discover the latest Mate release." >&2
    return 1
  fi

  release_metadata_url="https://github.com/$REPO/releases/latest/download/latest-release.txt"
  if ! release_metadata="$(curl -fsSL "$release_metadata_url" 2>/dev/null)"; then
    echo "Could not download latest release metadata: $release_metadata_url" >&2
    return 1
  fi

  release_url="$(printf '%s\n' "$release_metadata" | sed -n 's/^bundle_url=//p' | head -n 1)"
  if [[ -z "$release_url" ]]; then
    echo "Latest release metadata did not include bundle_url." >&2
    return 1
  fi
  if [[ "$release_url" != *-bundle.tar.gz ]]; then
    echo "Latest release metadata bundle_url is not a bundle tarball: $release_url" >&2
    return 1
  fi

  printf '%s\n' "$release_url"
}

if [[ -z "$SOURCE_DIR" && -z "$RELEASE_URL" ]]; then
  RELEASE_URL="$(latest_release_url)"
  if [[ -z "$RELEASE_URL" ]]; then
    echo "Could not find a Mate bundle tarball on the latest release for $REPO." >&2
    exit 1
  fi
fi

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

prompt_if_missing OPENAI_API_KEY "OpenAI-compatible API key" "" 1
prompt_if_missing OPENAI_BASE_URL "OpenAI-compatible base URL" "https://api.openai.com/v1"
prompt_if_missing OPENAI_MODEL "OpenAI-compatible model" "gpt-4.1-mini"

quote_env_value() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

echo "Preparing install directories:"
echo "  install: $INSTALL_DIR"
echo "  bin: $BIN_DIR"
mkdir -p "$INSTALL_DIR" "$BIN_DIR"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

if [[ -n "$SOURCE_DIR" ]]; then
  echo "Installing Mate from source directory:"
  echo "  $SOURCE_DIR"
  cp -R "$SOURCE_DIR"/. "$TMP_DIR/source"
else
  echo "Downloading Mate tarball:"
  echo "  $RELEASE_URL"
  if command -v curl >/dev/null 2>&1; then
    curl --fail --show-error --location --progress-bar "$RELEASE_URL" -o "$TMP_DIR/mate.tar.gz"
  elif command -v wget >/dev/null 2>&1; then
    wget --show-progress -O "$TMP_DIR/mate.tar.gz" "$RELEASE_URL"
  else
    echo "Install curl or wget, then rerun this installer." >&2
    exit 1
  fi
  mkdir -p "$TMP_DIR/source"
  echo "Extracting Mate tarball."
  tar -xzf "$TMP_DIR/mate.tar.gz" -C "$TMP_DIR/source" --strip-components=1
fi

echo "Installing files into:"
echo "  $INSTALL_DIR"
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
cp -R "$TMP_DIR/source"/. "$INSTALL_DIR"

if [[ ! -d "$INSTALL_DIR/.venv" ]]; then
  echo "Creating Python virtual environment:"
  echo "  $INSTALL_DIR/.venv"
  "$PYTHON_BIN" -m venv "$INSTALL_DIR/.venv"
fi

# shellcheck disable=SC1091
source "$INSTALL_DIR/.venv/bin/activate"
echo "Installing Mate package into the virtual environment."
python -m pip install --upgrade pip
python -m pip install -e "$INSTALL_DIR"

echo "Creating Mate launcher:"
echo "  $BIN_DIR/mate -> $INSTALL_DIR/run_agent.sh"
chmod +x "$INSTALL_DIR/run_agent.sh"
cat > "$BIN_DIR/mate" <<EOF
#!/usr/bin/env bash
exec "$INSTALL_DIR/run_agent.sh" "\$@"
EOF
chmod +x "$BIN_DIR/mate"

if [[ ! -d "$INSTALL_DIR/.mate" ]]; then
  echo "Creating Mate config directory:"
  echo "  $INSTALL_DIR/.mate"
  mkdir -p "$INSTALL_DIR/.mate"
fi

echo "Writing Mate environment config:"
echo "  $INSTALL_DIR/.mate/keys.env"
cat > "$INSTALL_DIR/.mate/keys.env" <<EOF
OPENAI_API_KEY=$(quote_env_value "$OPENAI_API_KEY")
OPENAI_BASE_URL=$(quote_env_value "$OPENAI_BASE_URL")
OPENAI_MODEL=$(quote_env_value "$OPENAI_MODEL")
EOF
chmod 600 "$INSTALL_DIR/.mate/keys.env"

echo "Mate installed successfully."
echo "Run: $BIN_DIR/mate"
echo "Config: $INSTALL_DIR/.mate"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "Add $BIN_DIR to PATH if the mate command is not found." ;;
esac

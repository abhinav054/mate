#!/usr/bin/env bash
if [ -z "${BASH_VERSION:-}" ]; then
  exec bash "$0" "$@"
fi
set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]:-$0}"
ROOT_DIR="$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
DIST_DIR="$ROOT_DIR/dist"
PACKAGE_DIR="$ROOT_DIR"

cd "$ROOT_DIR"

LATEST_TAG="$(git describe --tags --abbrev=0)"
TAG="${TAG:-$LATEST_TAG}"
VERSION="${TAG#v}"
RELEASE_TITLE="${RELEASE_TITLE:-Mate $TAG}"
NOTES_FILE="${NOTES_FILE:-}"
PUBLISH="${PUBLISH:-0}"
GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-}"

if [[ -z "$GITHUB_REPOSITORY" ]]; then
  origin_url="$(git config --get remote.origin.url || true)"
  GITHUB_REPOSITORY="$(printf '%s' "$origin_url" | sed -E 's#^git@[^:]+:##; s#^https://[^/]+/##; s#\.git$##')"
fi

rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

PYPROJECT_FILE="$ROOT_DIR/pyproject.toml"
PYPROJECT_BACKUP="$(mktemp "${TMPDIR:-/tmp}/mate-pyproject.XXXXXX")"
cp "$PYPROJECT_FILE" "$PYPROJECT_BACKUP"
restore_pyproject() {
  cp "$PYPROJECT_BACKUP" "$PYPROJECT_FILE"
  rm -f "$PYPROJECT_BACKUP"
}
trap restore_pyproject EXIT
"$PYTHON_BIN" -c 'import pathlib, re, sys; path = pathlib.Path("pyproject.toml"); text = path.read_text(); path.write_text(re.sub(r"^version = \"[^\"]+\"", f"version = \"{sys.argv[1]}\"", text, count=1, flags=re.MULTILINE))' "$VERSION"

"$PYTHON_BIN" -m venv "$DIST_DIR/.build-venv"
# shellcheck disable=SC1091
source "$DIST_DIR/.build-venv/bin/activate"
python -m pip install --upgrade pip build
python -m build "$PACKAGE_DIR" --outdir "$DIST_DIR/python"

ARCHIVE_ROOT="$DIST_DIR/mate-$VERSION"
mkdir -p "$ARCHIVE_ROOT"
cp -R "$ROOT_DIR/agent_terminal" "$ARCHIVE_ROOT/agent_terminal"
cp -R "$ROOT_DIR/agent_resources" "$ARCHIVE_ROOT/agent_resources"
cp -R "$ROOT_DIR/.mate" "$ARCHIVE_ROOT/.mate"
cp "$ROOT_DIR/pyproject.toml" "$ARCHIVE_ROOT/pyproject.toml"
cp "$ROOT_DIR/README.md" "$ARCHIVE_ROOT/README.md"
cp "$ROOT_DIR/run_agent.sh" "$ARCHIVE_ROOT/run_agent.sh"
cp "$ROOT_DIR/install_agent.sh" "$ARCHIVE_ROOT/install_agent.sh"
cp "$ROOT_DIR/scripts/install_mate.sh" "$ARCHIVE_ROOT/install_mate.sh"
find "$ARCHIVE_ROOT" -type d \( -name __pycache__ -o -name .build-venv \) -prune -exec rm -rf {} +
find "$ARCHIVE_ROOT" -type f -name '*.pyc' -delete
rm -f "$ARCHIVE_ROOT/.env" "$ARCHIVE_ROOT/.mate/keys.env"

tar -C "$DIST_DIR" -czf "$DIST_DIR/mate-$VERSION-bundle.tar.gz" "mate-$VERSION"

LATEST_RELEASE_TXT="$DIST_DIR/latest-release.txt"
BUNDLE_URL=""
if [[ "$GITHUB_REPOSITORY" == */* ]]; then
  BUNDLE_URL="https://github.com/$GITHUB_REPOSITORY/releases/download/$TAG/mate-$VERSION-bundle.tar.gz"
fi
{
  printf 'tag=%s\n' "$TAG"
  printf 'version=%s\n' "$VERSION"
  printf 'bundle_url=%s\n' "$BUNDLE_URL"
} > "$LATEST_RELEASE_TXT"

echo "Built release artifacts:"
find "$DIST_DIR" -maxdepth 2 -type f -printf "  %p\n" | sort

if [[ "$PUBLISH" != "1" ]]; then
  echo
  echo "Dry run complete. Publish with:"
  echo "  PUBLISH=1 $0"
  exit 0
fi

if [[ -z "$GITHUB_REPOSITORY" || "$GITHUB_REPOSITORY" != */* ]]; then
  echo "Set GITHUB_REPOSITORY as owner/repo, for example: GITHUB_REPOSITORY=abhinav054/mate" >&2
  exit 1
fi

if command -v gh >/dev/null 2>&1; then
  if [[ -n "$NOTES_FILE" ]]; then
    gh release create "$TAG" "$DIST_DIR"/python/* "$DIST_DIR/mate-$VERSION-bundle.tar.gz" "$LATEST_RELEASE_TXT" --title "$RELEASE_TITLE" --notes-file "$NOTES_FILE"
  else
    gh release create "$TAG" "$DIST_DIR"/python/* "$DIST_DIR/mate-$VERSION-bundle.tar.gz" "$LATEST_RELEASE_TXT" --title "$RELEASE_TITLE" --generate-notes
  fi
  echo "Published GitHub release $TAG."
  exit 0
fi

if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  echo "Set GITHUB_TOKEN, or install GitHub CLI and run: gh auth login" >&2
  exit 1
fi

notes="Release $TAG"
if [[ -n "$NOTES_FILE" ]]; then
  notes="$(cat "$NOTES_FILE")"
fi

release_json="$(TAG="$TAG" RELEASE_TITLE="$RELEASE_TITLE" RELEASE_NOTES="$notes" "$PYTHON_BIN" -c 'import json, os; print(json.dumps({"tag_name": os.environ["TAG"], "name": os.environ["RELEASE_TITLE"], "body": os.environ["RELEASE_NOTES"], "draft": False, "prerelease": False}))')"

release_response="$(curl -fsSL \
  -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/repos/$GITHUB_REPOSITORY/releases" \
  -d "$release_json")"

upload_url="$(printf '%s' "$release_response" | "$PYTHON_BIN" -c 'import json, sys; print(json.load(sys.stdin)["upload_url"].split("{", 1)[0])')"

for asset in "$DIST_DIR"/python/* "$DIST_DIR/mate-$VERSION-bundle.tar.gz" "$LATEST_RELEASE_TXT"; do
  name="$(basename "$asset")"
  curl -fsSL \
    -X POST \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    -H "Content-Type: application/octet-stream" \
    --data-binary @"$asset" \
    "$upload_url?name=$name" >/dev/null
  echo "Uploaded $name"
done

echo "Published GitHub release $TAG."

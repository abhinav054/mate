#!/usr/bin/env bash
if [ -z "${BASH_VERSION:-}" ]; then
  exec bash "$0" "$@"
fi
set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]:-$0}"
ROOT_DIR="$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)"
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

PACKAGE_JSON="$ROOT_DIR/package.json"
PACKAGE_BACKUP="$(mktemp "${TMPDIR:-/tmp}/mate-package.XXXXXX")"
cp "$PACKAGE_JSON" "$PACKAGE_BACKUP"
restore_package() {
  cp "$PACKAGE_BACKUP" "$PACKAGE_JSON"
  rm -f "$PACKAGE_BACKUP"
}
trap restore_package EXIT
node -e 'const fs=require("fs"); const path="package.json"; const pkg=JSON.parse(fs.readFileSync(path, "utf8")); pkg.version=process.argv[1]; fs.writeFileSync(path, JSON.stringify(pkg, null, 2)+"\n");' "$VERSION"

npm pack "$PACKAGE_DIR" --pack-destination "$DIST_DIR" >/dev/null

LATEST_RELEASE_TXT="$DIST_DIR/latest-release.txt"
PACKAGE_TGZ="$(find "$DIST_DIR" -maxdepth 1 -type f -name '*.tgz' -print -quit)"
PACKAGE_URL=""
if [[ "$GITHUB_REPOSITORY" == */* && -n "$PACKAGE_TGZ" ]]; then
  PACKAGE_URL="https://github.com/$GITHUB_REPOSITORY/releases/download/$TAG/$(basename "$PACKAGE_TGZ")"
fi
{
  printf 'tag=%s\n' "$TAG"
  printf 'version=%s\n' "$VERSION"
  printf 'package_url=%s\n' "$PACKAGE_URL"
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
    gh release create "$TAG" "$DIST_DIR"/*.tgz "$LATEST_RELEASE_TXT" --title "$RELEASE_TITLE" --notes-file "$NOTES_FILE"
  else
    gh release create "$TAG" "$DIST_DIR"/*.tgz "$LATEST_RELEASE_TXT" --title "$RELEASE_TITLE" --generate-notes
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

release_json="$(TAG="$TAG" RELEASE_TITLE="$RELEASE_TITLE" RELEASE_NOTES="$notes" node -e 'console.log(JSON.stringify({tag_name: process.env.TAG, name: process.env.RELEASE_TITLE, body: process.env.RELEASE_NOTES, draft: false, prerelease: false}))')"

release_response="$(curl -fsSL \
  -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/repos/$GITHUB_REPOSITORY/releases" \
  -d "$release_json")"

upload_url="$(printf '%s' "$release_response" | node -e 'let data=""; process.stdin.on("data", c => data += c); process.stdin.on("end", () => console.log(JSON.parse(data).upload_url.split("{", 1)[0]));')"

for asset in "$DIST_DIR"/*.tgz "$LATEST_RELEASE_TXT"; do
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

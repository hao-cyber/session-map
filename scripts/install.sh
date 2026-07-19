#!/bin/sh

set -eu

REPOSITORY="hao-cyber/session-map"
REQUESTED_VERSION="${1:-latest}"

if [ "$(uname -s)" != "Darwin" ]; then
  printf '%s\n' "SessionMap currently supports macOS only." >&2
  exit 1
fi

case "$(uname -m)" in
  arm64) RELEASE_ARCH="arm64" ;;
  x86_64) RELEASE_ARCH="x86_64" ;;
  *)
    printf 'Unsupported Mac architecture: %s\n' "$(uname -m)" >&2
    exit 1
    ;;
esac

if [ "$REQUESTED_VERSION" = "latest" ]; then
  RELEASE_TAG="$(curl -fsSL "https://api.github.com/repos/$REPOSITORY/releases/latest" | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
  if [ -z "$RELEASE_TAG" ]; then
    printf '%s\n' "Could not determine the latest SessionMap release." >&2
    exit 1
  fi
else
  RELEASE_TAG="$REQUESTED_VERSION"
fi

case "$RELEASE_TAG" in
  v*) RELEASE_VERSION="${RELEASE_TAG#v}" ;;
  *)
    printf 'Invalid release tag: %s\n' "$RELEASE_TAG" >&2
    exit 1
    ;;
esac

case "$RELEASE_VERSION" in
  *[!0-9A-Za-z.-]*|'')
    printf 'Invalid release version: %s\n' "$RELEASE_VERSION" >&2
    exit 1
    ;;
esac

ASSET="sessionmap-${RELEASE_VERSION}-darwin-${RELEASE_ARCH}.tar.gz"
BASE_URL="https://github.com/$REPOSITORY/releases/download/$RELEASE_TAG"
TEMPORARY_DIRECTORY="$(mktemp -d "${TMPDIR:-/tmp}/sessionmap-install.XXXXXX")"
trap 'rm -rf "$TEMPORARY_DIRECTORY"' EXIT HUP INT TERM

printf 'Downloading SessionMap %s for %s...\n' "$RELEASE_VERSION" "$RELEASE_ARCH"
curl -fL --retry 3 --proto '=https' --tlsv1.2 "$BASE_URL/$ASSET" -o "$TEMPORARY_DIRECTORY/$ASSET"
curl -fL --retry 3 --proto '=https' --tlsv1.2 "$BASE_URL/checksums.txt" -o "$TEMPORARY_DIRECTORY/checksums.txt"

EXPECTED_CHECKSUM="$(awk -v asset="$ASSET" '$2 == asset { print $1 }' "$TEMPORARY_DIRECTORY/checksums.txt")"
if [ -z "$EXPECTED_CHECKSUM" ]; then
  printf 'Release checksum does not contain %s.\n' "$ASSET" >&2
  exit 1
fi
ACTUAL_CHECKSUM="$(shasum -a 256 "$TEMPORARY_DIRECTORY/$ASSET" | awk '{ print $1 }')"
if [ "$ACTUAL_CHECKSUM" != "$EXPECTED_CHECKSUM" ]; then
  printf '%s\n' "SessionMap archive checksum verification failed." >&2
  exit 1
fi

mkdir "$TEMPORARY_DIRECTORY/package"
tar -xzf "$TEMPORARY_DIRECTORY/$ASSET" -C "$TEMPORARY_DIRECTORY/package"
if [ ! -x "$TEMPORARY_DIRECTORY/package/sessionmap" ]; then
  printf '%s\n' "Release archive does not contain an executable sessionmap binary." >&2
  exit 1
fi

"$TEMPORARY_DIRECTORY/package/sessionmap" install
"$HOME/.local/bin/sessionmap" open

printf '%s\n' "SessionMap $RELEASE_VERSION is installed."

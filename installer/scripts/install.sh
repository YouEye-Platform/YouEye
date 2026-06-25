#!/bin/sh
# YouEye Installer bootstrap
#
# Public usage:
#   curl -fsSL https://raw.githubusercontent.com/youeye-platform/YouEye/main/installer/scripts/install.sh | sudo bash
#
# Silent usage:
#   curl -fsSL https://raw.githubusercontent.com/youeye-platform/YouEye/main/installer/scripts/install.sh | sudo bash -s -- --silent --yes
#
# Bootstrap overrides:
#   INSTALLER_REPO_URL   repository containing installer releases
#   INSTALLER_CHANNEL    release channel/branch (default: main)
#   INSTALLER_TAG        exact installer release tag
#   INSTALLER_URL        direct binary URL (overrides repo/channel/tag)
#   DEST                 install path for the transient installer binary
set -e

INSTALLER_REPO_URL="${INSTALLER_REPO_URL:-https://github.com/youeye-platform/YouEye}"
INSTALLER_CHANNEL="${INSTALLER_CHANNEL:-main}"
INSTALLER_TAG="${INSTALLER_TAG:-}"
INSTALLER_URL="${INSTALLER_URL:-}"
DEST="${DEST:-/usr/local/bin/youeye-installer}"

PROVIDER=""
RELEASE_BASE_URL=""
RELEASE_API_URL=""
RELEASE_ORG=""
RELEASE_REPO=""

if [ "$(id -u)" != "0" ]; then
    echo "The YouEye installer must run as root (e.g. via sudo)." >&2
    exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
    echo "curl is required but not installed." >&2
    exit 1
fi

parse_repo_url() {
    url="${1%/}"
    url="${url%.git}"
    case "$url" in
        http://*|https://*) ;;
        *) echo "INSTALLER_REPO_URL must start with http:// or https://" >&2; exit 1 ;;
    esac

    no_scheme="${url#http://}"
    no_scheme="${no_scheme#https://}"
    host="${no_scheme%%/*}"
    rest="${no_scheme#*/}"
    org="${rest%%/*}"
    repo="${rest#*/}"
    repo="${repo%%/*}"
    repo="${repo%.git}"

    if [ -z "$host" ] || [ -z "$org" ] || [ -z "$repo" ] || [ "$rest" = "$no_scheme" ]; then
        echo "INSTALLER_REPO_URL must include host, owner, and repo" >&2
        exit 1
    fi

    if [ "$host" = "github.com" ]; then
        PROVIDER="github"
        RELEASE_BASE_URL="https://github.com"
        RELEASE_API_URL="https://api.github.com/repos/${org}/${repo}/releases?per_page=50"
    else
        PROVIDER="gitea"
        scheme="${url%%://*}"
        RELEASE_BASE_URL="${scheme}://${host}"
        RELEASE_API_URL="${RELEASE_BASE_URL}/api/v1/repos/${org}/${repo}/releases?limit=50"
    fi

    RELEASE_ORG="$org"
    RELEASE_REPO="$repo"
}

detect_arch() {
    arch="$(uname -m)"
    case "$arch" in
        x86_64) echo "amd64" ;;
        aarch64|arm64) echo "arm64" ;;
        *) echo "Unsupported architecture: $arch" >&2; exit 1 ;;
    esac
}

fetch_releases() {
    if [ "$PROVIDER" = "github" ]; then
        curl -4 -fsSL \
            -H 'Accept: application/vnd.github+json' \
            -H 'User-Agent: youeye-installer' \
            "$RELEASE_API_URL"
    else
        curl -4 -fsSL "$RELEASE_API_URL"
    fi
}

latest_installer_tag() {
    if [ -n "$INSTALLER_TAG" ]; then
        echo "$INSTALLER_TAG"
        return
    fi

    releases="$(fetch_releases)"
    tags="$(echo "$releases" | tr ',' '\n' | grep '"tag_name"' | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')"

    if [ -n "$INSTALLER_CHANNEL" ] && [ "$INSTALLER_CHANNEL" != "main" ]; then
        tag="$(echo "$tags" | grep "^installer-${INSTALLER_CHANNEL}-v" | head -1 || true)"
        if [ -n "$tag" ]; then
            echo "$tag"
            return
        fi
        echo "No installer release found for ${INSTALLER_CHANNEL}; falling back to main." >&2
    fi

    tag="$(echo "$tags" | grep '^installer-v' | head -1 || true)"
    if [ -z "$tag" ]; then
        echo "No installer release found in ${INSTALLER_REPO_URL}" >&2
        exit 1
    fi
    echo "$tag"
}

download_installer() {
    arch="$(detect_arch)"
    mkdir -p "$(dirname "$DEST")"

    if [ -n "$INSTALLER_URL" ]; then
        echo "Downloading youeye-installer from explicit URL..."
        curl -4 -fsSL "$INSTALLER_URL" -o "$DEST"
        chmod +x "$DEST"
        return
    fi

    tag="$(latest_installer_tag)"
    asset="youeye-installer-linux-${arch}"
    url="${RELEASE_BASE_URL}/${RELEASE_ORG}/${RELEASE_REPO}/releases/download/${tag}/${asset}"
    tmp="/tmp/youeye-installer-download-$$"

    echo "Downloading youeye-installer (${tag}, ${arch})..."
    if curl -4 -fsSL "$url" -o "$tmp" && [ -s "$tmp" ]; then
        mv "$tmp" "$DEST"
        chmod +x "$DEST"
        return
    fi

    rm -f "$tmp"
    fallback="${RELEASE_BASE_URL}/${RELEASE_ORG}/${RELEASE_REPO}/releases/download/${tag}/youeye-installer"
    echo "Installer asset ${asset} not found; trying legacy asset name." >&2
    curl -4 -fsSL "$fallback" -o "$DEST"
    chmod +x "$DEST"
}

parse_repo_url "$INSTALLER_REPO_URL"
download_installer

silent=false
for arg in "$@"; do
    case "$arg" in
        --silent)
            silent=true
            ;;
    esac
done

echo "Launching installer..."
if [ "$silent" = "true" ]; then
    exec "$DEST" "$@"
fi

exec "$DEST" "$@" < /dev/tty

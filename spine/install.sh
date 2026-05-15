#!/bin/sh
# YouEye Spine Installer
# Works on minimal Debian/Ubuntu systems (Proxmox LXC, etc.)
# Usage: curl -sSL https://git.byka.wtf/potemsla/YouEye/raw/branch/main/spine/install.sh | sh -s -- --branch sebastian
#
# Provider support:
#   --provider gitea   (default) Fetch releases from Gitea (git.byka.wtf)
#   --provider github  Fetch releases from GitHub
#
# Override URLs via environment or flags:
#   RELEASE_BASE_URL, RELEASE_ORG, RELEASE_REPO

set -e

# Defaults — Gitea (current production)
RELEASE_BASE_URL="${RELEASE_BASE_URL:-https://git.byka.wtf}"
RELEASE_API_URL="${RELEASE_API_URL:-}"
RELEASE_ORG="${RELEASE_ORG:-potemsla}"
RELEASE_REPO="${RELEASE_REPO:-YouEye}"
PROVIDER="${PROVIDER:-gitea}"

REPO="${RELEASE_BASE_URL}/${RELEASE_ORG}/${RELEASE_REPO}"
INSTALL_DIR="/usr/local/bin"
SERVICE_DIR="/etc/systemd/system"
SOCKET_DIR="/var/run/youeye"

# Component tag prefix for Spine releases in the monorepo
TAG_PREFIX="spine"

# Release branch support: install from a branch channel instead of main.
# Branch releases use tags like "spine-dev-v0.2.21.1".
#
# Usage (any of these work):
#   curl -sSL https://... | sh -s -- --branch sebastian
#   curl -sSL https://... | BRANCH=sebastian sh
#   export BRANCH=sebastian && curl -sSL https://... | sh
BRANCH="${BRANCH:-}"

# Parse command-line arguments (passed via `sh -s -- --branch <name>`)
while [ $# -gt 0 ]; do
    case "$1" in
        --branch|-b)
            BRANCH="$2"
            shift 2
            ;;
        --provider|-p)
            PROVIDER="$2"
            shift 2
            ;;
        *)
            shift
            ;;
    esac
done

# Apply provider-specific defaults if not overridden
if [ "$PROVIDER" = "github" ]; then
    # GitHub: API is at api.github.com, downloads at github.com
    RELEASE_BASE_URL="${RELEASE_BASE_URL:-https://github.com}"
    RELEASE_API_URL="${RELEASE_API_URL:-https://api.github.com/repos/${RELEASE_ORG}/${RELEASE_REPO}/releases?per_page=50}"
    REPO="${RELEASE_BASE_URL}/${RELEASE_ORG}/${RELEASE_REPO}"
else
    # Gitea: API is at {base}/api/v1
    RELEASE_API_URL="${RELEASE_API_URL:-${RELEASE_BASE_URL}/api/v1/repos/${RELEASE_ORG}/${RELEASE_REPO}/releases?limit=50}"
fi

# Colors (if terminal supports it)
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() {
    printf "${BLUE}[INFO]${NC} %s\n" "$1"
}

log_success() {
    printf "${GREEN}[OK]${NC} %s\n" "$1"
}

log_warn() {
    printf "${YELLOW}[WARN]${NC} %s\n" "$1"
}

log_error() {
    printf "${RED}[ERROR]${NC} %s\n" "$1"
}

# Check if running as root
if [ "$(id -u)" != "0" ]; then
    log_error "This script must be run as root"
    exit 1
fi

# Detect architecture
detect_arch() {
    ARCH=$(uname -m)
    case $ARCH in
        x86_64)
            echo "amd64"
            ;;
        aarch64)
            echo "arm64"
            ;;
        arm64)
            echo "arm64"
            ;;
        *)
            log_error "Unsupported architecture: $ARCH"
            exit 1
            ;;
    esac
}

# Detect OS
detect_os() {
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        echo "$ID"
    else
        log_error "Cannot detect OS. /etc/os-release not found."
        exit 1
    fi
}

# Install prerequisites
install_prerequisites() {
    log_info "Installing prerequisites..."

    OS=$(detect_os)
    case $OS in
        debian|ubuntu)
            apt-get update -qq
            apt-get install -y -qq curl ca-certificates
            ;;
        alpine)
            apk add --no-cache curl ca-certificates
            ;;
        *)
            log_warn "Unknown OS: $OS. Assuming curl is available."
            ;;
    esac

    log_success "Prerequisites installed"
}

# Check if curl exists, install if not
ensure_curl() {
    if ! command -v curl >/dev/null 2>&1; then
        log_info "curl not found, installing..."
        install_prerequisites
    fi
}

# Get latest release version, filtered by BRANCH if set.
# In the YouEye monorepo, Spine tags are prefixed: spine-v0.2.21, spine-dev-v0.2.21.1
# Works with both Gitea and GitHub APIs (JSON response format is compatible).
get_latest_version() {
    # Fetch releases from the configured API endpoint
    CURL_ARGS="-4 -sSL"
    if [ "$PROVIDER" = "github" ]; then
        CURL_ARGS="$CURL_ARGS -H 'Accept: application/vnd.github+json' -H 'User-Agent: youeye-spine'"
    fi
    RELEASES=$(eval curl $CURL_ARGS "\"$RELEASE_API_URL\"" 2>/dev/null)

    # Extract all tag names, one per line
    TAGS=$(echo "$RELEASES" | tr ',' '\n' | grep '"tag_name"' | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')

    # Filter to only Spine tags (starting with "spine-")
    SPINE_TAGS=$(echo "$TAGS" | grep "^${TAG_PREFIX}-" | sed "s/^${TAG_PREFIX}-//")

    if [ -n "$BRANCH" ] && [ "$BRANCH" != "main" ]; then
        # Branch mode: look for tags like "spine-dev-v0.2.21.1" → after prefix strip: "dev-v0.2.21.1"
        BRANCH_PREFIX="${BRANCH}-v"
        VERSION=$(echo "$SPINE_TAGS" | grep "^${BRANCH_PREFIX}" | head -1 | sed "s/^${BRANCH_PREFIX}//")

        if [ -n "$VERSION" ]; then
            echo "$VERSION"
            return
        fi

        log_warn "No ${BRANCH} branch release found for Spine, falling back to main"
    fi

    # Main releases: after prefix strip, tags starting with "v" + digit (e.g. "v0.2.21")
    VERSION=$(echo "$SPINE_TAGS" | grep '^v[0-9]' | head -1 | sed 's/^v//')

    if [ -z "$VERSION" ]; then
        echo "0.2.21"  # Fallback to known version
    else
        echo "$VERSION"
    fi
}

# Download spine binary
download_spine() {
    ARCH=$(detect_arch)
    VERSION=$(get_latest_version)

    log_info "Detected architecture: $ARCH"
    log_info "Latest version: $VERSION"

    ASSET_NAME="spine-linux-${ARCH}"

    # Ensure install directory exists
    mkdir -p "$INSTALL_DIR"

    # Use temp file to avoid piping issues when running via curl | sh
    TMP_FILE="/tmp/spine-download-$$"

    # Construct the download URL using the component-prefixed tag
    if [ -n "$BRANCH" ] && [ "$BRANCH" != "main" ]; then
        TAG="${TAG_PREFIX}-${BRANCH}-v${VERSION}"
    else
        TAG="${TAG_PREFIX}-v${VERSION}"
    fi
    DOWNLOAD_URL="${RELEASE_BASE_URL}/${RELEASE_ORG}/${RELEASE_REPO}/releases/download/${TAG}/${ASSET_NAME}"

    log_info "Downloading Spine from $DOWNLOAD_URL..."

    # Download to temp file first, then move
    if curl -4 -sSL -f "$DOWNLOAD_URL" -o "$TMP_FILE" && [ -s "$TMP_FILE" ]; then
        mv "$TMP_FILE" "${INSTALL_DIR}/youeye"
        log_success "Downloaded successfully"
    else
        rm -f "$TMP_FILE"
        # Fallback to raw branch (for development)
        log_warn "Release download failed, trying raw branch..."
        DOWNLOAD_URL="${REPO}/raw/branch/main/spine/spine-linux-${ARCH}"

        if curl -4 -sSL -f "$DOWNLOAD_URL" -o "$TMP_FILE" && [ -s "$TMP_FILE" ]; then
            mv "$TMP_FILE" "${INSTALL_DIR}/youeye"
            log_success "Downloaded from main branch"
        else
            rm -f "$TMP_FILE"
            log_error "Failed to download YouEye binary"
            log_error "Tried: $DOWNLOAD_URL"
            exit 1
        fi
    fi

    chmod +x "${INSTALL_DIR}/youeye"

    # Create backward-compatible 'spine' symlink
    ln -sf "${INSTALL_DIR}/youeye" "${INSTALL_DIR}/spine"

    log_success "YouEye installed to ${INSTALL_DIR}/youeye (spine symlink created)"
}

# Create systemd service
create_service() {
    log_info "Creating systemd service..."

    # Create socket directory
    mkdir -p "$SOCKET_DIR"

    # Migrate from old spine.service if it exists
    if [ -f "${SERVICE_DIR}/spine.service" ]; then
        log_info "Migrating from spine.service to youeye.service..."
        systemctl stop spine.service 2>/dev/null || true
        systemctl disable spine.service 2>/dev/null || true
        rm -f "${SERVICE_DIR}/spine.service"
    fi

    cat > "${SERVICE_DIR}/youeye.service" << 'EOF'
[Unit]
Description=YouEye Platform Management Service
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
ExecStartPre=/bin/mkdir -p /var/run/youeye
ExecStart=/usr/local/bin/youeye api serve
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable youeye.service
    systemctl start youeye.service

    log_success "YouEye service created and started"
}

# Write release branch and provider config to youeye.yaml
set_release_branch() {
    mkdir -p /var/lib/youeye/config
    CONFIG_FILE="/var/lib/youeye/config/youeye.yaml"

    if [ -n "$BRANCH" ] && [ "$BRANCH" != "main" ]; then
        log_info "Setting release branch to: $BRANCH"

        if [ -f "$CONFIG_FILE" ]; then
            # Update existing file: replace or append release_branch
            if grep -q "release_branch" "$CONFIG_FILE"; then
                sed -i "s/^release_branch:.*/release_branch: ${BRANCH}/" "$CONFIG_FILE"
            else
                echo "release_branch: ${BRANCH}" >> "$CONFIG_FILE"
            fi
        else
            cat > "$CONFIG_FILE" << EOFCFG
# YouEye Configuration
site_name: YouEye
release_branch: ${BRANCH}
setup_completed: false
subdomains:
  control: control
  auth: auth
  dns: dns
EOFCFG
        fi

        log_success "Release branch set to: $BRANCH"
    fi

    # If provider is not the default (gitea), persist it to the Spine config
    if [ "$PROVIDER" = "github" ]; then
        log_info "Persisting release provider: github"
        SPINE_CONFIG_DIR="/etc/youeye"
        mkdir -p "$SPINE_CONFIG_DIR"
        SPINE_CONFIG="$SPINE_CONFIG_DIR/config.yaml"

        if [ -f "$SPINE_CONFIG" ]; then
            # Append or update releases section
            if grep -q "^releases:" "$SPINE_CONFIG"; then
                log_info "releases section exists in $SPINE_CONFIG — update manually if needed"
            else
                cat >> "$SPINE_CONFIG" << EOFREL

releases:
  provider: "github"
  base_url: "${RELEASE_BASE_URL}"
  organization: "${RELEASE_ORG}"
EOFREL
            fi
        else
            cat > "$SPINE_CONFIG" << EOFREL
# Spine configuration — generated by installer
releases:
  provider: "github"
  base_url: "${RELEASE_BASE_URL}"
  organization: "${RELEASE_ORG}"
EOFREL
        fi

        log_success "Release provider set to: github (${RELEASE_BASE_URL}/${RELEASE_ORG})"
    fi
}

# Verify installation
verify_installation() {
    log_info "Verifying installation..."

    if "${INSTALL_DIR}/youeye" version >/dev/null 2>&1; then
        VERSION=$("${INSTALL_DIR}/youeye" version 2>&1 | head -1)
        log_success "YouEye installed successfully: $VERSION"
    else
        log_error "YouEye installation verification failed"
        exit 1
    fi

    # Check service status
    if systemctl is-active --quiet youeye.service; then
        log_success "YouEye service is running"
    else
        log_warn "YouEye service is not running. Start with: systemctl start youeye"
    fi
}

# Main installation flow
main() {
    echo ""
    echo "=================================="
    echo "  YouEye Spine Installer"
    echo "=================================="
    echo ""

    if [ -n "$BRANCH" ] && [ "$BRANCH" != "main" ]; then
        echo "  Release branch: $BRANCH"
    fi
    if [ "$PROVIDER" != "gitea" ]; then
        echo "  Provider: $PROVIDER"
    fi
    echo ""

    ensure_curl
    download_spine
    set_release_branch
    create_service
    verify_installation

    echo ""
    echo "=================================="
    echo "  Installation Complete!"
    echo "=================================="
    echo ""

    # If running in an interactive terminal, launch the TUI installer
    # which handles env detection, games during deploy, etc.
    if [ -t 0 ] && [ -t 1 ]; then
        log_info "Launching interactive installer..."
        exec "${INSTALL_DIR}/youeye" installer
    fi

    # Non-interactive fallback (piped install, CI, etc.)
    echo "Next steps:"
    echo "  1. Run 'youeye installer' for interactive setup with games"
    echo "  2. Run 'youeye deploy' for non-interactive deployment"
    echo ""
    echo "For help: youeye --help"
    echo "  (The 'spine' command also works as a backward-compatible alias)"
    echo ""
}

main

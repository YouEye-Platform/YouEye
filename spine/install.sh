#!/bin/sh
# YouEye Spine Installer
# Works on minimal Debian/Ubuntu systems (Proxmox LXC, etc.)
# Usage: curl -sSL https://git.byka.wtf/potemsla/YouEye/raw/branch/main/spine/install.sh | sh

set -e

REPO="https://git.byka.wtf/potemsla/YouEye"
INSTALL_DIR="/usr/local/bin"
SERVICE_DIR="/etc/systemd/system"
SOCKET_DIR="/var/run/spine"

# Component tag prefix for Spine releases in the monorepo
TAG_PREFIX="spine"

# Release branch support: set BRANCH=dev to install from a branch channel
# Default: "" (main releases). Branch releases use tags like "spine-dev-v0.2.21.1".
# Usage: BRANCH=dev curl -sSL https://... | sh
BRANCH="${BRANCH:-}"

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

# Get latest release version from Gitea, filtered by BRANCH if set.
# In the YouEye monorepo, Spine tags are prefixed: spine-v0.2.21, spine-dev-v0.2.21.1
get_latest_version() {
    # Use Gitea API to get releases (fetch up to 50, newest first)
    RELEASES=$(curl -4 -sSL "https://git.byka.wtf/api/v1/repos/potemsla/YouEye/releases?limit=50" 2>/dev/null)

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
    DOWNLOAD_URL="https://git.byka.wtf/potemsla/YouEye/releases/download/${TAG}/${ASSET_NAME}"

    log_info "Downloading Spine from $DOWNLOAD_URL..."

    # Download to temp file first, then move
    if curl -4 -sSL -f "$DOWNLOAD_URL" -o "$TMP_FILE" && [ -s "$TMP_FILE" ]; then
        mv "$TMP_FILE" "${INSTALL_DIR}/spine"
        log_success "Downloaded successfully"
    else
        rm -f "$TMP_FILE"
        # Fallback to raw branch (for development)
        log_warn "Release download failed, trying raw branch..."
        DOWNLOAD_URL="${REPO}/raw/branch/main/spine/spine-linux-${ARCH}"

        if curl -4 -sSL -f "$DOWNLOAD_URL" -o "$TMP_FILE" && [ -s "$TMP_FILE" ]; then
            mv "$TMP_FILE" "${INSTALL_DIR}/spine"
            log_success "Downloaded from main branch"
        else
            rm -f "$TMP_FILE"
            log_error "Failed to download Spine binary"
            log_error "Tried: $DOWNLOAD_URL"
            exit 1
        fi
    fi

    chmod +x "${INSTALL_DIR}/spine"
    log_success "Spine installed to ${INSTALL_DIR}/spine"
}

# Create systemd service
create_service() {
    log_info "Creating systemd service..."

    # Create socket directory
    mkdir -p "$SOCKET_DIR"

    cat > "${SERVICE_DIR}/spine.service" << 'EOF'
[Unit]
Description=YouEye Spine - System Management Service
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/spine api serve
ExecStartPre=/bin/mkdir -p /var/run/spine
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable spine.service
    systemctl start spine.service

    log_success "Spine service created and started"
}

# Write release branch to youeye.yaml if BRANCH is set
set_release_branch() {
    if [ -n "$BRANCH" ] && [ "$BRANCH" != "main" ]; then
        log_info "Setting release branch to: $BRANCH"
        mkdir -p /var/lib/youeye/config
        CONFIG_FILE="/var/lib/youeye/config/youeye.yaml"

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
}

# Verify installation
verify_installation() {
    log_info "Verifying installation..."

    if "${INSTALL_DIR}/spine" version >/dev/null 2>&1; then
        VERSION=$("${INSTALL_DIR}/spine" version 2>&1 | head -1)
        log_success "Spine installed successfully: $VERSION"
    else
        log_error "Spine installation verification failed"
        exit 1
    fi

    # Check service status
    if systemctl is-active --quiet spine.service; then
        log_success "Spine service is running"
    else
        log_warn "Spine service is not running. Start with: systemctl start spine"
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
        echo ""
    fi

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
    echo "Next steps:"
    echo "  1. Run 'spine status' to check system status"
    echo "  2. Run 'spine deploy' to install full YouEye stack"
    echo ""
    echo "For help: spine --help"
    echo ""
}

main

#!/bin/sh
# YouEye Installer — bootstrap
#
# Downloads the youeye-installer binary and launches the interactive TUI.
# Run on a Proxmox VE host (creates a Debian VM and installs YouEye inside it)
# or on a bare Debian/Ubuntu host (installs Spine + deploys YouEye directly).
#
# Usage:
#   curl -fsSL https://git.potemk.in/potemsla/YouEye/raw/branch/artem/installer/scripts/install.sh | sudo bash
#
# Overridable:
#   INSTALLER_TAG   release tag to pull the binary from (default: installer-artem-v0.1.0)
#   INSTALLER_URL   direct binary URL (overrides REPO_BASE/INSTALLER_TAG)
#   YOUEYE_NAMES_BUNDLE  path (on this Proxmox host) to a YouEye Names reuse
#                        bundle exported from a prior install. When set, the new
#                        VM reuses that address + certificate instead of
#                        provisioning a fresh one through Let's Encrypt. Run as:
#                        sudo YOUEYE_NAMES_BUNDLE=/root/test.bundle.json bash -c "$(curl -fsSL <this-url>)"
set -e

REPO_BASE="${REPO_BASE:-https://git.potemk.in/potemsla/YouEye}"
INSTALLER_TAG="${INSTALLER_TAG:-installer-artem-v0.1.0}"
INSTALLER_URL="${INSTALLER_URL:-${REPO_BASE}/releases/download/${INSTALLER_TAG}/youeye-installer}"
DEST="${DEST:-/usr/local/bin/youeye-installer}"

if [ "$(id -u)" != "0" ]; then
    echo "The YouEye installer must run as root (e.g. via sudo)." >&2
    exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
    echo "curl is required but not installed." >&2
    exit 1
fi

echo "Downloading youeye-installer (${INSTALLER_TAG})..."
curl -fsSL "$INSTALLER_URL" -o "$DEST"
chmod +x "$DEST"

# Redirect stdin from the controlling terminal so the TUI works even when this
# bootstrap is piped from `curl | bash` (the pipe is on stdin otherwise).
echo "Launching installer..."
exec "$DEST" < /dev/tty

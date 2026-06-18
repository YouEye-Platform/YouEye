#!/usr/bin/env bash
# YouEye — Proxmox VM Provisioner
# Creates a Debian VM on a Proxmox VE host (PVE 8/9) with the QEMU guest agent
# PRE-INSTALLED, so the host can drive the in-VM YouEye install non-interactively
# via `qm guest exec` (no SSH required — the agent runs as root in the guest).
#
# Run ON the Proxmox host. Non-interactive.
#
# Usage:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/youeye-platform/YouEye/main/installer/scripts/proxmox-vm.sh)"
#   VMID=9000 VMNAME=youeye-test CORES=2 MEMORY=2048 DISK_SIZE=20 bash proxmox-vm.sh
#
# Options (env var OR --flag):
#   VMID        --vmid       VM id            (default: next free via pvesh)
#   VMNAME      --name       VM name          (default: youeye)
#   CORES       --cores      vCPUs            (default: 2)
#   MEMORY      --memory     RAM in MB        (default: 2048)
#   DISK_SIZE   --disk       OS disk in GB    (default: 20)
#   STORAGE     --storage    disk storage     (default: local-lvm)
#   BRIDGE      --bridge     network bridge   (default: vmbr0)
#   DEBIAN      --debian     trixie|bookworm  (default: trixie, falls back to bookworm)
#   CIUSER      --ciuser     cloud-init user  (default: youeye)
#   CIPASS      --cipass     cloud-init pass  (default: youeye)
#   SSHKEYS     --sshkeys    pubkeys file     (default: /root/.ssh/authorized_keys if present)
#   CPUTYPE     --cpu        qemu cpu type    (default: x86-64-v2-AES)
#   RECREATE=1  --recreate   destroy an existing VM with this id first (testing)
#   NO_START=1  --no-start   create but do not start
#   KEEP_WORK_IMG=1          keep the per-VM working qcow2 after import (debug)

set -euo pipefail
export LIBGUESTFS_BACKEND="${LIBGUESTFS_BACKEND:-direct}"   # libguestfs on PVE kernels

# ── Colors / logging (matches spine/install.sh) ──
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
log_info()    { printf "${BLUE}[INFO]${NC} %s\n" "$1"; }
log_success() { printf "${GREEN}[OK]${NC} %s\n" "$1"; }
log_warn()    { printf "${YELLOW}[WARN]${NC} %s\n" "$1"; }
log_error()   { printf "${RED}[ERROR]${NC} %s\n" "$1"; }
trap 'log_error "provisioning failed at line $LINENO"; exit 1' ERR

# ── Defaults (env-overridable) ──
VMNAME="${VMNAME:-youeye}"
CORES="${CORES:-2}"
MEMORY="${MEMORY:-2048}"
DISK_SIZE="${DISK_SIZE:-20}"
STORAGE="${STORAGE:-local-lvm}"
BRIDGE="${BRIDGE:-vmbr0}"
DEBIAN="${DEBIAN:-trixie}"
CIUSER="${CIUSER:-youeye}"
CIPASS="${CIPASS:-youeye}"
CPUTYPE="${CPUTYPE:-x86-64-v2-AES}"
SSHKEYS="${SSHKEYS:-/root/.ssh/authorized_keys}"
AGENT_TIMEOUT="${AGENT_TIMEOUT:-300}"

# ── Flag parsing (override env) ──
while [ $# -gt 0 ]; do
  case "$1" in
    --vmid)     VMID="$2"; shift 2 ;;
    --name)     VMNAME="$2"; shift 2 ;;
    --cores)    CORES="$2"; shift 2 ;;
    --memory)   MEMORY="$2"; shift 2 ;;
    --disk)     DISK_SIZE="$2"; shift 2 ;;
    --storage)  STORAGE="$2"; shift 2 ;;
    --bridge)   BRIDGE="$2"; shift 2 ;;
    --debian)   DEBIAN="$2"; shift 2 ;;
    --ciuser)   CIUSER="$2"; shift 2 ;;
    --cipass)   CIPASS="$2"; shift 2 ;;
    --sshkeys)  SSHKEYS="$2"; shift 2 ;;
    --cpu)      CPUTYPE="$2"; shift 2 ;;
    --recreate) RECREATE=1; shift ;;
    --no-start) NO_START=1; shift ;;
    *) log_warn "ignoring unknown arg: $1"; shift ;;
  esac
done

# ── Guest-agent helpers ──
# Poll until the agent answers (or fail after $2 seconds).
wait_for_agent() {
  local vmid=$1 timeout=${2:-300} start; start=$(date +%s)
  log_info "waiting for guest agent on VM $vmid (timeout ${timeout}s)..."
  until qm agent "$vmid" ping >/dev/null 2>&1; do
    if [ $(( $(date +%s) - start )) -ge "$timeout" ]; then
      log_error "guest agent on VM $vmid not ready after ${timeout}s"; return 1
    fi
    sleep 3
  done
  log_success "guest agent on VM $vmid is up"
}

# Run a command in the guest; echo its stdout; return the guest exit code.
# Usage: vm_exec <vmid> <cmd> [args...]
vm_exec() {
  local vmid=$1; shift
  local json
  json=$(qm guest exec "$vmid" --timeout 60 -- "$@" 2>/dev/null) || { echo "qm guest exec failed (agent down?)" >&2; return 255; }
  python3 - "$json" <<'PY'
import sys, json
d = json.loads(sys.argv[1])
sys.stdout.write(d.get("out-data", ""))
e = d.get("err-data", "")
if e: sys.stderr.write(e)
sys.exit(int(d.get("exitcode", 0)))
PY
}

# Best-effort IPv4 of the VM via the agent.
get_vm_ip() {
  local vmid=$1 json
  json=$(qm guest cmd "$vmid" network-get-interfaces 2>/dev/null) || return 0
  python3 - "$json" <<'PY'
import sys, json
try: ifaces = json.loads(sys.argv[1])
except Exception: sys.exit(0)
for i in ifaces:
    if i.get("name") == "lo": continue
    for a in i.get("ip-addresses", []) or []:
        ip = a.get("ip-address", "")
        if a.get("ip-address-type") == "ipv4" and not ip.startswith("127."):
            print(ip); sys.exit(0)
PY
}

# ── Preflight ──
[ "$(id -u)" = 0 ] || { log_error "must run as root on the Proxmox host"; exit 1; }
for c in qm pvesh qemu-img wget openssl python3; do
  command -v "$c" >/dev/null 2>&1 || { log_error "required command not found: $c (is this a Proxmox host?)"; exit 1; }
done

if ! command -v virt-customize >/dev/null 2>&1; then
  log_warn "virt-customize not found — installing libguestfs-tools (one-time)..."
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y libguestfs-tools >/dev/null
  log_success "libguestfs-tools installed"
fi

VMID="${VMID:-$(pvesh get /cluster/nextid)}"
log_info "target VMID: $VMID"

# Replace an existing VM only when explicitly asked.
if qm status "$VMID" >/dev/null 2>&1; then
  if [ "${RECREATE:-0}" = 1 ]; then
    log_warn "VM $VMID already exists — destroying it (RECREATE)"
    qm stop "$VMID" >/dev/null 2>&1 || true
    for _ in $(seq 1 20); do qm status "$VMID" 2>/dev/null | grep -q stopped && break; sleep 1; done
    qm destroy "$VMID" --purge 1 --destroy-unreferenced-disks 1 >/dev/null
  else
    log_error "VM $VMID already exists (pass --recreate / RECREATE=1 to replace)"; exit 1
  fi
fi

# ── Image: download pristine (cached) ──
case "$DEBIAN" in
  trixie)   DVER=13 ;;
  bookworm) DVER=12 ;;
  *) log_error "unsupported DEBIAN='$DEBIAN' (use trixie or bookworm)"; exit 1 ;;
esac
IMG_DIR=/var/lib/vz/template/iso
mkdir -p "$IMG_DIR"

download_image() {  # $1=codename $2=version -> sets IMG_CACHE
  local cn=$1 ver=$2
  local file="debian-${ver}-genericcloud-amd64.qcow2"
  local url="https://cloud.debian.org/images/cloud/${cn}/latest/${file}"
  IMG_CACHE="${IMG_DIR}/${file}"
  if [ -s "$IMG_CACHE" ] && qemu-img info "$IMG_CACHE" >/dev/null 2>&1; then
    log_info "using cached image: $IMG_CACHE"; return 0
  fi
  log_info "downloading $url"
  if wget -qO "${IMG_CACHE}.part" "$url" && qemu-img info "${IMG_CACHE}.part" >/dev/null 2>&1; then
    mv "${IMG_CACHE}.part" "$IMG_CACHE"; return 0
  fi
  rm -f "${IMG_CACHE}.part"; return 1
}

if ! download_image "$DEBIAN" "$DVER"; then
  if [ "$DEBIAN" = trixie ]; then
    log_warn "Debian 13 (trixie) image unavailable — falling back to Debian 12 (bookworm)"
    download_image bookworm 12 || { log_error "image download failed"; exit 1; }
  else
    log_error "image download failed"; exit 1
  fi
fi
log_success "base image ready: $IMG_CACHE"

# ── Pre-bake the guest agent into a per-VM working copy ──
WORK_IMG="${IMG_DIR}/youeye-vm-${VMID}.qcow2"
cp --reflink=auto "$IMG_CACHE" "$WORK_IMG"
log_info "pre-baking qemu-guest-agent into the image (virt-customize)..."
virt-customize -a "$WORK_IMG" \
  --install qemu-guest-agent \
  --run-command 'systemctl enable qemu-guest-agent' >/dev/null
log_success "qemu-guest-agent baked into image"
# Grow the disk up front so cloud-init's growpart expands the FS on first boot.
qemu-img resize "$WORK_IMG" "${DISK_SIZE}G" >/dev/null

# ── Create the VM ──
log_info "creating VM $VMID ($VMNAME): ${CORES} vCPU / ${MEMORY} MB / ${DISK_SIZE} GB on ${STORAGE}, net ${BRIDGE}"
qm create "$VMID" \
  --name "$VMNAME" \
  --cores "$CORES" --memory "$MEMORY" --cpu "$CPUTYPE" \
  --net0 "virtio,bridge=${BRIDGE}" \
  --ostype l26 \
  --scsihw virtio-scsi-single \
  --serial0 socket --vga serial0 \
  --agent enabled=1 \
  --onboot 1 \
  --tags youeye >/dev/null

# Import the OS disk (PVE 8/9 one-step; auto qcow2->raw on lvm-thin)
log_info "importing OS disk into ${STORAGE}..."
qm set "$VMID" --scsi0 "${STORAGE}:0,import-from=${WORK_IMG},discard=on,ssd=1,iothread=1" >/dev/null
qm set "$VMID" --ide2 "${STORAGE}:cloudinit" >/dev/null
qm set "$VMID" --boot order=scsi0 >/dev/null

# ── Cloud-init ──
qm set "$VMID" --ciuser "$CIUSER" >/dev/null
qm set "$VMID" --cipassword "$(openssl passwd -6 "$CIPASS")" >/dev/null
if [ -n "$SSHKEYS" ] && [ -f "$SSHKEYS" ]; then
  qm set "$VMID" --sshkeys "$SSHKEYS" >/dev/null
  log_info "injected SSH keys from $SSHKEYS"
else
  log_warn "no SSH keys file at '$SSHKEYS' — console/password login only"
fi
qm set "$VMID" --ipconfig0 ip=dhcp >/dev/null
qm set "$VMID" --ciupgrade 0 >/dev/null
log_success "VM $VMID configured"

# Working image is no longer needed (data is in the imported volume).
[ "${KEEP_WORK_IMG:-0}" = 1 ] || rm -f "$WORK_IMG"

if [ "${NO_START:-0}" = 1 ]; then
  log_success "VM $VMID created (not started — NO_START set)"
  exit 0
fi

# ── Boot + verify the guest agent ──
log_info "starting VM $VMID..."
qm start "$VMID"

if wait_for_agent "$VMID" "$AGENT_TIMEOUT"; then
  log_info "verifying host -> guest command execution..."
  vm_exec "$VMID" bash -lc 'echo "host=$(hostname)"; echo "debian=$(cat /etc/debian_version 2>/dev/null)"; echo "agent=$(systemctl is-active qemu-guest-agent)"; echo "kernel=$(uname -r)"' \
    || log_warn "demo exec returned non-zero"
  VM_IP="$(get_vm_ip "$VMID")"
else
  log_warn "agent not confirmed in time — VM is running; check 'qm terminal $VMID'"
  VM_IP=""
fi

# ── Summary ──
echo
log_success "VM $VMID ($VMNAME) provisioned with a working QEMU guest agent"
cat <<EOF
  VMID     : $VMID
  Name     : $VMNAME
  Resources: ${CORES} vCPU / ${MEMORY} MB / ${DISK_SIZE} GB (${STORAGE})
  Network  : ${BRIDGE} (DHCP)  IP: ${VM_IP:-<pending DHCP>}
  Login    : user '${CIUSER}' (password set; SSH key injected if present)
  Run cmds : qm guest exec $VMID -- <command>
  Console  : qm terminal $VMID   (exit with Ctrl-O)
  Destroy  : qm stop $VMID && qm destroy $VMID --purge 1

Next: drive the in-VM YouEye install through the agent, e.g.
  qm guest exec $VMID -- bash -lc 'curl -fsSL <spine-install-url> | sh'
EOF

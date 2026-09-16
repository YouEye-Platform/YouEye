# Getting Started

YouEye has one installer and one installed-system model. The
`youeye-installer` binary supports:

- `install` when booted from the signed YouEye ISO on physical hardware or a
  VM;
- `proxmox` on a Proxmox VE host, where it selects and verifies that same ISO,
  provisions a Q35/OVMF VM, and waits for the installed appliance to become
  operationally healthy.

The appliance image is the release artifact. “YouEye Installer” is the product
and command name.

## Requirements

### Installed appliance

- x86-64 CPU with UEFI support;
- 2 vCPU minimum, 4 recommended;
- 4 GiB RAM minimum, 8 GiB recommended;
- one dedicated installation drive of at least 32 GiB, 128 GiB recommended;
- wired or otherwise boot-available IPv4 networking, using DHCP by default.

The installer erases the selected drive after an explicit target-specific
confirmation. It creates an ESP, independent Recovery, equal System A/B slots,
persistent State, and a Data partition using the remaining capacity.

### Proxmox mode

Run as root on a Proxmox VE host with `qm`, `pvesm`, `pvesh`, `sgdisk`,
`curl`, `openssl`, `sha256sum`, and Python 3. The host needs one active storage
pool supporting VM images, one supporting ISO images, and an available network
bridge.

## Install on Proxmox

Stable channel:

```bash
curl -fsSL https://raw.githubusercontent.com/YouEye-Platform/YouEye/main/installer/scripts/install.sh | sh
```

Run this canonical public command from the Proxmox root shell. It does not
depend on `sudo` being installed. Public Stable uses its embedded Stable anchor;
unprovisioned source builds fail closed and never reuse the Development key.

Development channel from an explicitly selected Forgejo-compatible provider:

```bash
curl -fsSL https://raw.githubusercontent.com/YouEye-Platform/YouEye/main/installer/scripts/install.sh | \
  sh -s -- --provider forgejo \
    --releases-api https://forge.example.test/api/v1/repos/example/YouEye/releases \
    --channel development
```

The bootstrap defaults to the official GitHub Stable release API, paginates the
selected GitHub, Forgejo, or custom HTTPS API, refuses cross-channel
fallback, requires API-provided release download URLs, verifies the detached
Ed25519 signature over the complete checksum set, and verifies the exact
installer binary digest before executing it. Public releases additionally
require the exact detached `release-lock.json`, whose digest is bound by signed
provenance, and matching source and component identities. Alternative providers are never
prefilled. Exact selection requires the release tag plus both Installer and ISO
SHA-256 digests without replacing signed verification.

Quick mode creates a 4-vCPU, 8-GiB Q35/OVMF VM with one 128-GiB installation
drive and DHCP. Advanced mode can select the VMID, name, storage pools, a
32-GiB-or-larger drive, bridge, static IPv4 settings, public SSH keys, release
provider and channel, or an exact release. Drives below 64 GiB receive a strong
capacity warning; the 32 GiB minimum leaves about 7 GiB for `YE-DATA`. Reinstall
accepts only a stopped, compatible, one-drive YouEye VM and
requires confirmation naming the exact target whose contents were inspected.

The host helper never writes guest partitions. It attaches verified installer
and non-secret answer media, then the booted ISO owns every destructive disk
operation. Completion is accepted only after the ISO emits its signed terminal
record, the installed system boots, first deployment is durable, and the
operational health profile passes.

## Install from ISO

Download these assets from one exact `appliance-v*` or `appliance-dev-v*`
release:

- `youeye-appliance-amd64.iso`;
- `SHA256SUMS`;
- `SHA256SUMS.sig`.

Use the channel trust anchor obtained through an independently authenticated
path. For the current Development identity, the DER SHA-256 fingerprint is:

```text
51d5cd19886aa2cb3f541a2e90525993bf1a483063bb689838b41f1fd43cfe94
```

Verify the checksum document and ISO before writing media:

```bash
openssl pkeyutl -verify -pubin -inkey appliance-development.pub -rawin \
  -in SHA256SUMS -sigfile SHA256SUMS.sig
grep -E '^[0-9a-f]{64}  youeye-appliance-amd64\.iso$' SHA256SUMS | sha256sum -c -
```

Write the ISO to the exact removable device using your preferred imaging tool,
then boot it in UEFI mode. Select the dedicated installation drive, review its
stable identity and discovered contents, configure networking and optional SSH
public keys, and confirm erasure. Remove the installer media only after the
completion screen says both written images and UEFI boot assets passed readback
verification.

## First login and health

The console shows the HTTPS setup address only after first deployment passes
its durable health gates. Open it and create the single initial YouEye ID owner.
There is no default appliance password. The interactive installer requires a
root password for local console recovery. SSH public keys and optional local
password SSH are configured separately, as described below.

On the appliance console, the authoritative operational check is:

```bash
youeye appliance health --profile=operational --json
```

A completed first deployment also has:

```text
/var/lib/youeye-state/first-deploy/complete
```

The operational profile must report healthy. All five required platform
containers—Control Panel (`youeye-control`), PostgreSQL, Caddy, Pi-hole, and
YouEye UI—must be running. `youeye-id.service` is a separately verified process
inside the Control Panel container; it is not a sixth container.

## Root SSH access

The Installer's **Root password SSH** option permits root password login only
from the directly connected IPv4 subnet. It uses the password chosen for the
local console. Leaving it off keeps SSH key-only, even when local console login
works. The **Development access** page name does not select the software release
channel. Public-key import supplies a separate way to authenticate and does not
enable password SSH. Routed networks and VPN clients may fall outside the
permitted subnet.

If SSH reports `Permission denied (publickey)`, inspect the applied policy from
the appliance's local root console before changing authentication settings:

```sh
cat /var/lib/youeye-state/bootstrap/development-access-status.json
systemctl status youeye-development-access.service --no-pager
passwd -S root
```

The status JSON contains requested/effective access, the detected subnet and a
non-secret failure explanation. `passwd -S` reports account state, not the
password or hash. Do not share `development-access.json` or `/etc/shadow`, which
contain password hashes. If password SSH was requested but is not effective,
investigate the reported policy, network or service failure first.

To inspect sshd's effective policy for the connecting client, replace the
example client address below with that client's actual IPv4 address:

```sh
/usr/sbin/sshd -T -C user=root,addr=192.0.2.10,host=client | \
  grep -E '^(permitrootlogin|passwordauthentication|pubkeyauthentication|authenticationmethods|authorizedkeysfile) '
```

To recover key access without enabling password login, bring your **public**
key to the console as a file and register it with the managed key command:

```sh
youeye appliance ssh-key add --file /path/to/your-public-key.pub
youeye appliance ssh-key list
```

Keep the private key on the client. Do not weaken global sshd settings or
reinstall the appliance merely to diagnose SSH authentication.

## Platform management

```bash
youeye status
youeye appliance health --profile=operational --json
youeye update self
youeye update control
youeye update system status
```

System-image updates write and read back only the inactive System slot, arm a
bounded boot trial, and preserve State, Recovery, and Data. Failed trials return
to the prior known-good slot. Recovery can select a slot once, verify or repair
signed boot assets, and export support evidence without mounting the active
system read-write.

## Retired installers

The mutable Debian/Ubuntu host installer, Debian-cloud Proxmox VM provider,
Proxmox LXC provider, and two-disk guest installer are retired. They did not
provide the signed one-drive appliance layout, independent Recovery, A/B system
updates, or sealed-image integrity guarantees. The temporary `appliance`
command, `proxmox.sh` entry point, and `--appliance-*` compatibility flags have
completed their migration window and are removed. Use `install`, `proxmox`,
and the canonical flag names.

## Next steps

- [Customize your dashboard](dashboard.md)
- [Explore native apps and the Market](apps.md)
- [Configure Settings](settings.md)
- [Administer the platform](control-panel.md)

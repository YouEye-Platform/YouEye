# Installing YouEye

There is one installer, `youeye-installer` (`installer/`). It has two modes:

- **`proxmox`**: run on a Proxmox VE host. It creates a VM, boots the YouEye ISO in it and waits until the installed
  box is healthy. The piped `install.sh` starts this mode.
- **`install`**: runs inside the booted YouEye ISO (physical machine or any VM) and writes the disk.

After the disk is written the box boots, deploys the platform on its own ("first deployment"), and opens the setup
page. The owner then claims the box and runs the setup wizard in a browser.

## Requirements

- x86-64 with UEFI. 2 vCPU and 4 GiB RAM minimum; 4 vCPU and 8 GiB recommended.
- One installation drive of at least 32 GiB; 128 GiB recommended. The installer erases it.
- Wired IPv4 networking. DHCP by default; static IPv4 is possible.
- Proxmox mode: root on the Proxmox host, with `python3`, `qm`, `pvesm`, `pvesh` and `sgdisk`
  (`installer/scripts/install.sh` checks these), a storage for VM disks, a storage for ISOs and a network bridge.

## Install on Proxmox (`install.sh`)

Run as root in the Proxmox host shell. `sudo` is not needed.

```sh
curl -fsSL https://releases.youeye.me/install.sh | sh                        # stable
curl -fsSL https://releases.youeye.me/install.sh | sh -s -- --channel beta   # beta
```

`install.sh` options (everything else is passed to the installer):

| Option | Default | Meaning |
|---|---|---|
| `--channel dev\|alpha\|beta\|stable` | `stable` | the channel the box installs from and keeps following |
| `--repository <https URL>` | `https://github.com/YouEye-Platform/YouEye` | the release repository; it never changes after install |
| `--release-tag youeye-v<name>` with `--core-manifest-sha256 <sha>` | none | install one exact release instead of the channel's current one; the two go together |

What it does:

1. Reads the channel index. For the official repository's `beta` and `stable` it tries
   `https://releases.youeye.me/v1/channels/<channel>.json` first, then
   `<repository>/releases/download/channel-<channel>/index.json`. It never calls a release-listing API.
2. Downloads that release's `core-release.json` and checks its SHA-256 against the index entry.
3. Downloads the `installer` member (`youeye-installer-linux-amd64`), checks its SHA-256 and size, and runs
   `youeye-installer proxmox … --repository … --channel … --release-tag … --core-manifest-sha256 …`.

A release host that answers HTTP 403, 429 or 5xx, or a network failure, is retried with backoff (30, 60, 120 s); a
404 is not retried (`install.sh`).
Downloads from GitHub may redirect only to GitHub's asset hosts; other repositories may not redirect to another
host. Nothing is signed: integrity comes from HTTPS and SHA-256 ([releases.md](releases.md)).

A development build installs from its own release, for example:

```sh
curl -fsSL <repository>/releases/download/<tag>/install.sh | sh -s -- --repository <repository> --channel dev
```

### Proxmox mode

Without `--silent` the installer opens a text interface with pages for the operation and VM, resources, storage,
network, software (channel), SSH keys and console access (an optional root password). **Quick** settings: 4 vCPU, 8 GiB RAM, a 128 GiB
drive, DHCP. Drives under 64 GiB get a capacity warning.

Installer flags for unattended runs (`installer/internal/installer/options.go`):

| Flag | Meaning |
|---|---|
| `--silent --yes` | no interface; confirm the installation |
| `--operation create\|reinstall` | new VM (default) or reinstall a stopped one-drive YouEye VM |
| `--erase-confirmed` | confirm erasing the drive on reinstall |
| `--vmid <id>`, `--hostname <name>` | VM ID and name |
| `--cpu <n>`, `--memory <MiB>`, `--target-disk-gb <GiB>` | resources (minimums: 2, 4096, 32) |
| `--target-storage <id>`, `--iso-storage <id>`, `--bridge <name>` | Proxmox storages and bridge |
| `--network-mode dhcp\|static`, `--address <cidr>`, `--gateway <ip>`, `--dns <ip>` | guest IPv4 |
| `--import-host-ssh-keys` (default on), `--ssh-keys-file <file>` | root SSH public keys for the box |

Example unattended test install:

```sh
curl -fsSL https://releases.youeye.me/install.sh | sh -s -- --channel beta --silent --yes \
  --vmid 360 --target-storage local-lvm --iso-storage local --cpu 4 --memory 8192 --target-disk-gb 64
```

The Proxmox host never writes the guest's partitions. It uploads the verified ISO and a non-secret answer medium,
boots the VM, and the ISO does every disk write. The installer waits up to 45 minutes for the install and 30
minutes for setup to become reachable. It reports success only when the box has finished first deployment, passed
its health checks, and blessed the current boot (`proxmoxDurableReadinessScript` in
`proxmox_appliance_host.go`).

The ISO is cached under `/var/cache/youeye-installer/` on the Proxmox host and uploaded to the ISO storage; neither
is removed afterwards.

## Install from the ISO

1. Download `core-release.json` and `youeye-appliance-amd64.iso` from one `youeye-v*` release.
2. Check the ISO against the `media` member:

   ```sh
   expected=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(next(m["artifact"]["sha256"] for m in d["members"] if m["role"] == "media"))' core-release.json)
   printf '%s  youeye-appliance-amd64.iso\n' "$expected" | sha256sum -c -
   ```

   Each release also has a `SHA256SUMS` file for people; nothing reads it.
3. Write the ISO to a USB drive, boot it in UEFI mode.
4. In the installer: pick the installation drive (it shows the drive's identity and what is on it), set networking,
   optional SSH public keys and, under console access, an optional root password, and confirm erasure. The installer downloads the same release's
   `core-release.json` over HTTPS and refuses to continue unless the ISO's image manifest matches its `appliance`
   member.
5. The completion screen says the written images and boot files passed read-back. Press Enter: the machine turns
   off. Then remove the USB drive and turn the machine on. Do not remove the drive before pressing Enter: the
   installer runs from it, and without it the machine cannot finish turning off. (Leaving the installer any other
   way, such as Esc on the first page, also turns the machine off.)

## What the installer writes

- The disk: ESP 1 GiB, Recovery 4 GiB, System A and B 6 GiB each, State 4 GiB, Data the rest
  ([architecture.md](architecture.md)).
- On State: `bootstrap/release-policy.json` (`repository`, `channel`, `core_manifest_sha256`),
  `bootstrap/core-release.json` (the exact bytes it installed from), the network profile, SSH keys and
  `bootstrap/console-access.json` (`youeye.console-access.v1`, mode 0600: the optional root password's yescrypt
  hash, `password_ssh` and an empty account list; Spine adds the admins' accounts later).

## Console and root access

- **Owner and admins:** they sign in on the console (Ctrl+Alt+F2, a normal login on TTY2) with their YouEye ID
  username and password, and get `sudo`. The Control Panel gives each admin a console account; nothing needs to be
  set up in the installer. TTY1 shows the box's status.
- **Root password** (the "Console access" page, advanced): off by default, so root is locked. Set one only for
  emergencies (for example when no admin can sign in). Only its yescrypt hash is stored.
- **Password SSH:** offered only with a root password, off by default. When on, passwords work for SSH only from the
  directly connected IPv4 subnet. It does not choose the release channel.
- **SSH keys:** public keys from the installer (and, in Proxmox mode, the Proxmox root keys unless turned off).
  Add more later on the console with `youeye appliance ssh-key add --key-file <file.pub>` (or `-` for standard
  input); list them with `youeye appliance ssh-key list`.
- **Network repair** on the box: `sudo youeye-installer network` on Ctrl+Alt+F2 (TTY1 offers it directly when a root
  password is set).
- **Forgotten owner password:** boot YouEye Recovery from the UEFI boot menu and choose **Reset owner password**.
  At the next boot TTY1 shows a one-time code; open `https://<box IP address>/settings/reset-owner` (the page answers only on the address, not the name) and enter it (valid 24 hours, once).

SSH problems: [troubleshooting.md](troubleshooting.md#ssh-permission-denied-publickey).

## First boot and first deployment

`youeye-first-deploy.service` runs `youeye boot first-deploy` (`spine/internal/boot/scripts/first-deploy.sh`). It
writes its progress to `/var/lib/youeye-state/first-deploy/progress.json`, which the console shows. In order:

1. **Network.** `youeye boot network` applies the saved wired profile and checks the network by fetching the
   channel index once (a 403 or 429 answer still proves the network works).
2. **Adopt Spine.** `youeye spine adopt` runs the installed release's Spine on this slot as a trial; first
   deployment then continues in that Spine ([spine.md](spine.md)).
3. **Converge the System release.** If the release's image is newer than the ISO's, it is written to the other slot
   and the box reboots into it, then continues.
4. **Deploy.** `youeye deploy` creates the ZFS-backed Incus storage and the `youeye-control` container and installs
   the Control Panel. The Control Panel then deploys PostgreSQL, Caddy, Pi-hole and the UI.
5. **Check health.** `youeye appliance health --profile=operational --json` must pass (saved as `health.json`), and
   the release is recorded as installed (`youeye update core initialize` and `first-boot`).
6. **Open setup.** `youeye boot setup-gate open` removes the nftables table that blocked ports 80 and 443, and the
   script checks that `https://127.0.0.1/` answers. It then writes `first-deploy/complete`.

A failed attempt is retried by systemd every 30 s, up to 8 attempts; then the stage is `needs_attention`
([troubleshooting.md](troubleshooting.md#first-deployment-stopped)). A fresh install takes about 10–15 minutes.

The console shows the status and, once ready, `Setup https://<box IP>`.

## Claiming the box

Open `https://<box IP>` (the certificate is self-signed at this point). On an IP address the sign-in page is the
**claim** page (`control-panel/src/app/login/page.tsx`, `components/auth/appliance-claim.tsx`):

- The owner enters a username, password (twice), first name, optional last name and email. The Control Panel
  creates that account in YouEye ID as the box owner (`POST /api/appliance/claim`).
- Only one claim succeeds. Afterwards the page offers **resume**: the owner signs in again with that account to
  continue setup.
- Claiming works only from an IP-address host, with a same-origin request and a CSRF cookie, and is rate-limited
  (10 attempts per 5 minutes per client).

## Setup wizard

After the claim the browser goes to the Control Panel's `/setup` page (`control-panel/src/app/setup/page.tsx`):

1. **Language.**
2. **Readiness.** Waits until the platform reports it is ready.
3. **New or restore.** Restore reads a backup and returns to sign-in when done.
4. **Title.** The box's name and its title design.
5. **Address and certificate.** One of: a YouEye Name (the default), your own domain through a DNS provider token,
   Let's Encrypt, a self-signed certificate, or an uploaded certificate (`TlsChoice` in
   `components/setup/SetupServerName.tsx`).
6. **Confirm.** For a new YouEye Name, the name is verified first.
7. **Provisioning.** Runs these steps and shows each one: save config, Caddy, DNS, AI (deploys Pointer), sign-in for
   the Control Panel, sign-in for the dashboard, finalize.
8. **Done.** Uploaded certificates get their upload step; every other choice waits for the Control Panel to restart
   with sign-in and opens `/setup-complete`, which explains DNS for the new address.

The platform config is `/var/lib/youeye/config/youeye.yaml`; `setup_completed: true` marks the end of setup.

## Checking a box

On the console or over SSH:

```sh
youeye status                                          # versions and update state
youeye appliance health --profile=operational --json   # the health gate first deployment uses
youeye doctor                                          # read-only diagnostics
youeye update core status                              # installed System release and any update in progress
```

More in [troubleshooting.md](troubleshooting.md).

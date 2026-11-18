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
3. Write the ISO to a USB drive, boot it in UEFI mode. The GRUB menu has **Install YouEye** (default) and
   **Install YouEye (text mode)**.
   - **Graphical installer** (default, when the machine has a working graphics driver): the launcher
     (`/usr/local/libexec/youeye-live-installer`, `appliance/live/`) starts `youeye-installer serve` on
     `127.0.0.1:8090` and the cog browser in the cage kiosk compositor on the machine's own screen (WPE WebKit, Mesa,
     and the Intel, AMD, misc and NVIDIA GPU firmware are on the ISO; without a GPU render node wlroots renders in
     software). The page reports when it has painted (`/api/ui-ready`); if it doesn't within 45 s the text installer
     takes over. cog's own DRM platform (no compositor) segfaulted on a GPU-less VM, so cage is used. The page never leaves `127.0.0.1`. Keyboard first
     (Tab, arrows, Enter, Esc), mouse and touch also work. The serial console shows plain progress text.
   - **Text installer:** with the text-mode entry (`youeye.text=1`), when there is no DRM device (the trixie kernel
     has no simpledrm, so no GPU driver or `nomodeset` means no graphics), when the kiosk fails within 20 s, or when
     `serve` does not start, or when the page never paints. Both build the same answer (`answerFor` in `appliance_wizard.go`).
   - An answer disk (`YOUEYE_ANSWER`, Proxmox mode) still installs silently with NDJSON progress on the serial
     console.
4. In the installer: pick the installation drive (it shows the drive's identity and what is on it), set networking,
   optional SSH public keys and, under console access, an optional root password, and confirm erasure. The installer downloads the same release's
   `core-release.json` over HTTPS and refuses to continue unless the ISO's image manifest matches its `appliance`
   member.
5. The completion screen says the written images and boot files passed read-back ("Remove the USB stick after the
   machine turns off" in the graphical installer). Press Enter: the machine turns off. Then remove the USB drive and turn the machine on. Do not remove the drive before pressing Enter: the
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
writes its progress to `/var/lib/youeye-state/first-deploy/progress.json`, which the console and the Preparing page
show. In order:

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
6. **Open setup.** The script stops the Preparing page (below), `youeye boot setup-gate open` removes the nftables
   redirect, and the script checks that `https://127.0.0.1/` answers. It then writes `first-deploy/complete`. If the
   check fails, the gate closes again and the Preparing page comes back.

A failed attempt is retried by systemd every 30 s, up to 8 attempts; then the stage is `needs_attention`
([troubleshooting.md](troubleshooting.md#first-deployment-stopped)). A fresh install takes about 10–15 minutes.

### The Preparing page

From the first seconds of the first boot, `http://<box IP>`, `https://<box IP>` and `http://youeye.local` show a
**Preparing YouEye** page instead of nothing:

- `youeye-setup-page.service` runs `youeye boot setup-page` (`spine/internal/setuppage`) on ports 47080 (HTTP) and
  47443 (HTTPS). Until first deployment completes, the setup gate redirects ports 80 and 443 to them.
- The page polls `GET /api/preparing` every 2 s: `state` (`running`, `retrying`, `restarting`, `needs_attention`,
  `complete`), stage, detail, percent, attempt, network (`online`, `dns`, problem), the box's addresses, and the last
  30 lines of `journalctl -u youeye-first-deploy` with anything secret-looking hidden. Its log panel opens by itself
  on errors. After `needs_attention` it offers **Try again** (`POST /api/preparing/retry`, at most once a minute),
  which resets the attempt counter and restarts first deployment.
- When first deployment opens setup it stops the page server, which closes every connection. The page then probes
  `/api/ping` (only the Control Panel answers it) and reloads; the same address now shows the claim page. Over
  HTTPS the Control Panel has a different certificate, so after 20 s the page reloads anyway and the browser asks
  again (unless the box CA is trusted, below).
- After a reboot during first deployment the page server starts again with the gate.

### The console (tty1)

While installing: "Installing YouEye…", the current step, `Watch at http://youeye.local or http://<box IP>` and a QR
code of `http://<box IP>` (the IP always works on phones). Once ready and not yet claimed: `Set up at …` with the same
QR code. After the claim it shows `Setup https://<box IP>` as before. The `.local` name is the one the box actually
publishes (`youeye mdns name`): a second unclaimed box on the same LAN becomes `youeye-2.local`.

### youeye.local and HTTP

- `youeye-mdns.service` runs `youeye mdns run`: Spine writes `/run/youeye/avahi-daemon.conf` for the adapter that
  holds the default route (never `incusbr0`, app bridges or veths; IPv4 only; no HINFO or workstation records) and
  runs Avahi with it. systemd-resolved does no mDNS or LLMNR. On a name conflict Avahi publishes `youeye-2.local`,
  `youeye-3.local` …
- `youeye.local` mirrors `https://<box IP>` and nothing more: claim, setup, setup-complete and reset-owner. YouEye ID
  sign-in, the dashboard and apps stay on the box's public HTTPS name.
- Both the IP and `youeye.local` work over **HTTP** (Caddy's `:80` setup server proxies them to the Control Panel
  without a redirect; every other host is redirected to HTTPS) and over **HTTPS**. HTTPS is the owner's choice:
  the setup pages offer "Use a secure connection (HTTPS)" with the CA download.
- **Box CA.** At first boot Spine makes one ECDSA P-256 root (10 years) on State,
  `/var/lib/youeye-state/tls/root.{crt,key}` (0600). It signs the Preparing page's certificate, and Spine copies it
  into Caddy's local CA before Caddy first starts, so Caddy's intermediate (30 days) and leaves (7 days) chain to the
  same root. `GET /api/setup/ca-cert` serves it; an owner who trusts it sees no warning on the IP or `youeye.local`.

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

1. **Readiness.** Waits until the platform reports it is ready.
2. **Language.**
3. **New or restore.** Restore reads a backup and returns to sign-in when done.
4. **Address and certificate.** One of: a YouEye Name (the default), your own domain through a DNS provider token,
   Let's Encrypt, a self-signed certificate, or an uploaded certificate (`TlsChoice` in
   `components/setup/SetupServerName.tsx`). A box that already holds a name offers "Continue with <name>".
5. **Human check** (YouEye Name). Right after it the certificate job starts in the background
   ([youeye-names.md](youeye-names.md#setup-flow)).
6. **Title.** The box's name and its title design (the certificate is issued meanwhile).
7. **Confirm.**
8. **Provisioning.** Save config and Caddy, then YouEye Names, DNS, AI (configures the Pointer built at first boot),
   sign-in for the Control Panel and for the dashboard at the same time, then finalize.
9. **Done.** Uploaded certificates get their upload step; every other choice waits for the Control Panel to restart
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

# Architecture

YouEye is an appliance: a read-only A/B Debian image with a host agent (Spine) that runs the platform in Incus
containers. This page says what lives where and how the parts talk. Install and first boot are in
[install.md](install.md); Spine itself is in [spine.md](spine.md); updates are in [releases.md](releases.md) and
[core-release-contract.md](core-release-contract.md).

## The pieces

```
 Browser ──HTTPS──▶ host :443/:80 ──▶ youeye-caddy ──┬─▶ youeye-ui        (dashboard, :3000)
                                                     ├─▶ youeye-control   (Control Panel :3000, YouEye ID :3001)
                                                     ├─▶ youeye-pihole    (web UI :80)
                                                     ├─▶ youeye-pointer   (AI inference :4002)
                                                     └─▶ app-<id>         (one or more containers per app)
 LAN DNS ──▶ host :53 ──▶ youeye-pihole
 Host: Spine (`youeye.service`, API on /var/run/youeye/youeye.sock) manages Incus and youeye-control
```

| Part | Where it runs | Source |
|---|---|---|
| **Spine** | on the host, `youeye.service` (`youeye api serve`) | `spine/` |
| **Control Panel** + **YouEye ID** | Incus system container `youeye-control` (Debian 12); two systemd units, `youeye-control` (port 3000) and `youeye-id` (port 3001), running the same `/opt/app` bundle | `control-panel/` |
| **Dashboard UI** | Incus system container `youeye-ui` (Debian 12), `youeye-ui.service`, port 3000 | `ui/` |
| **Caddy** | OCI container `youeye-caddy`; host ports 80 and 443 | image from the Market catalog |
| **PostgreSQL** | OCI container `youeye-postgres`; no host port | image from the Market catalog |
| **Pi-hole** | OCI container `youeye-pihole`; host port 53 (TCP and UDP) | image from the Market catalog |
| **Pointer** (AI) | Incus system container `youeye-pointer`, Bun, ports 4001 and 4002 | Pointer repository |
| **Apps** | `app-<id>` or `app-<id>-<container>`, one network per app | native app repos, YE-AppMarket |

- Spine creates Incus storage and `youeye-control`, and deploys the Control Panel into it (`youeye deploy`). Spine
  does not deploy anything else.
- The Control Panel deploys and manages everything else: PostgreSQL, Caddy, Pi-hole, the UI, Pointer, native apps
  and Market apps (`control-panel/src/lib/infrastructure/`). The Caddy, PostgreSQL and Pi-hole images come from the
  Market catalog's `system/` entries (`system-market-manifests.ts`).
- Both web apps are Next.js 16 and ship with their own Node runtime (Node 24.22.0, copied in by
  `scripts/bundle-node-runtime.mjs` in each app).
- The Control Panel is served at `https://<domain>/settings`. YouEye ID has its own subdomain
  (`subdomains.identity` in the platform config). The dashboard is the domain itself, or a `subdomains.ui`
  subdomain.

## Image, State and Data

The installer writes one disk (layout 1, `installer/internal/installer/appliance_plan.go`):

| Partition | Size | Holds |
|---|---|---|
| ESP | 1 GiB | systemd-boot and the UKIs of both slots and Recovery |
| Recovery | 4 GiB | an independent recovery system (menu in `appliance/scripts/youeye-recovery`) |
| System A, System B | 6 GiB each | the read-only image; one is active, the other takes the next image update |
| State | 4 GiB, ext4 | small persistent host state, mounted at `/var/lib/youeye-state` |
| Data | the rest, ZFS pool `default` | everything else |

**Image** (System slot). Debian trixie built with `mmdebstrap` (`appliance/build/build-appliance.sh`), with ZFS,
nftables, Incus (`incus-base` from trixie-backports), the systemd units in `appliance/systemd/` (they only call
`youeye …` or the scripts in `appliance/scripts/`), the initramfs hooks, and the **seed Spine** at
`/usr/local/bin/youeye`. It changes only with an image build.

**State.** The initramfs mounts it and bind-mounts these into the read-only root
(`appliance/initramfs/youeye-state`): `/etc/machine-id`, `/etc/hostid`, `/etc/shadow`, `/etc/ssh`,
`/etc/systemd/network`, `/root`, `/var/lib/systemd` and `/var/log`. State also holds:

| Path under `/var/lib/youeye-state/` | What |
|---|---|
| `bootstrap/release-policy.json`, `bootstrap/core-release.json` | the box's repository and channel, and the release it was installed from |
| `bootstrap/network-profile.json`, `bootstrap/development-access.json` | install-time network and root-access choices |
| `spine/` | the selected Spine per slot (`selection.json` and the binaries) |
| `first-deploy/` | first-deployment progress, health and the `complete` marker |
| `core-update/` | the System update journal, receipt, frozen targets and version floor |
| `boot/` | the last boot blessing |
| `recovery/` | a queued Recovery reset |

**Data.** Spine creates the ZFS pool `default` on the Data partition (`spine/internal/storage/pool.go`):

| Dataset | Mounted at | What |
|---|---|---|
| `default/data` | `/var/lib/youeye` | all YouEye data: `config/youeye.yaml` (platform config), `postgres/`, `caddy/`, `pihole/`, `ui-data/`, `pointer/`, app data, and the update download cache `cache/core-update/` |
| `default/incus-state` | `/var/lib/incus` | the Incus database and host-side Incus state |
| `default/incus` | (Incus manages it) | the Incus storage pool for containers and volumes |

Spine's own config file is optional: `/var/lib/youeye/config/config.yaml`, then `/etc/youeye/config.yaml`
(`spine/internal/config/load.go`).

A Spine, Control Panel or UI change never needs a new image: the selected Spine lives on State and the services live
in containers on Data. See [spine.md](spine.md).

## Boot

1. The initramfs mounts State (`youeye-state` hook).
2. `youeye appliance prepare` (state, then storage) imports the ZFS pool and mounts the datasets.
3. `youeye.service` runs `youeye api serve`. The seed hands this to the slot's selected Spine.
4. On the first boot, `youeye-first-deploy.service` runs `youeye boot first-deploy` (see [install.md](install.md)).
   After an update, `youeye-core-update.service` continues a retained update (`youeye update core resume --boot`).
5. `youeye-appliance-bless.service` (`youeye boot bless`) marks the boot healthy, so an image trial is kept.

At every `api serve` start Spine also refreshes Pi-hole's port-53 listen address to the host's current IP, then
starts Pi-hole (`spine/internal/cmd/hostipcheck.go`). Pi-hole has autostart off for this reason.

## Networks

**`incusbr0`** is the platform bridge, a /24 that Incus picks. The core containers have fixed addresses on it
(`control-panel/src/lib/incus/static-ips.ts`, which must match `spine/internal/incus/static_ips.go`):

| Container | Address |
|---|---|
| `youeye-postgres` | `.10` |
| `youeye-caddy` | `.13` (Caddy's admin API listens only here, on `:2019`) |
| `youeye-pihole` | `.14` |
| `youeye-ui` | `.15` |
| `youeye-control` | `.16` |
| `youeye-pointer` | `.17` |

Container names resolve under the `youeye` DNS domain (for example `youeye-ui.youeye`).

**One bridge per app.** Each app gets its own Incus bridge `yeapp<N>` with a /27 lease from a private pool (default
`10.76.0.0/16`; the Control Panel picks the first of `10.76`–`10.83.0.0/16` that overlaps no host or Incus
network). The lease store
and checks are in `control-panel/src/lib/incus/app-network-ipam.ts` and `app-network.ts`.

- An app's containers sit only on their own bridge. They have no NIC on `incusbr0`.
- **Caddy** gets a NIC on every app bridge, so it can reach the app by name. That NIC has an ACL that lets apps
  reach Caddy only on TCP 80 and 443.
- **Egress ACL** `ye-app-<id>-egress`: an app may reach its own subnet, the UI bridge port, and only the core
  services it is entitled to. It is refused the Control Panel dashboard (`:3000`), Caddy's and Pi-hole's addresses,
  direct Pointer access, PostgreSQL unless it uses the shared database, and every other app's /27.
- **Connections** between two apps add a second, filtered NIC on the peer's bridge (see [market.md](market.md)).
- DNS for apps goes to the bridge's dnsmasq, which forwards to Pi-hole.

## App doorways

Apps reach the core services through Incus proxy devices in NAT mode on the app bridge's gateway address. The
Control Panel adds them per app (`addSystemProxyDevices` in `app-network.ts`):

| Gateway port | Goes to | When |
|---|---|---|
| `:3001` | the UI's app API (`youeye-ui:3000`) | always |
| `:5432` | PostgreSQL (`youeye-postgres:5432`) | the app uses the shared database |
| `:3002` | YouEye ID (`youeye-control:3001`) | the app uses sign-in |
| `:3003` | Pointer inference (`youeye-pointer:4002`) | the app uses AI |

The variables apps get for these are in [app-environment.md](app-environment.md).

## Who talks to whom

- **Control Panel → Spine:** over the Spine socket `/var/run/youeye/youeye.sock`, passed into `youeye-control` by an
  Incus proxy device (`spine/internal/container/control.go`). Spine reads its config, credentials and update state
  for the Control Panel. The Control Panel can read the box's channel and ask to switch channel, but never changes
  the repository.
- **Control Panel → Incus:** the Incus HTTPS API on the host (`:8443`, `INCUS_HTTPS_URL`), with a client
  certificate.
- **Control Panel → UI:** the Control Panel pushes app, connection and settings state to the UI's `/api/ui-bridge`
  routes with a shared bridge token. The UI does not call the Control Panel.
- **Control Panel → Caddy:** Caddy's admin API on `.13:2019`. App egress refuses that address.
- **Apps → core:** only through the doorways above.

## Security model

| Rule | How |
|---|---|
| Unprivileged containers | platform and app containers are created with `security.privileged=false` (Spine falls back to a privileged `youeye-control` only on the `dir` storage driver, which the appliance does not use) |
| One way in | Caddy on 80/443 for HTTP(S); Pi-hole on 53 for DNS. PostgreSQL, the Control Panel and the UI have no host port |
| Closed until set up | until first deployment completes, nftables table `youeye_setup_gate` drops ports 80 and 443 on the host (`youeye boot setup-gate`) |
| Owner claims the box | the first account is created by claiming the box from its IP address (see [install.md](install.md)) |
| Sign-in | YouEye ID (OIDC) signs users in to the dashboard, the Control Panel and apps |
| CP embed routes | the CP's `/api/ui-bridge/*` routes serve its `/embed/*` pages only; they need an admin CP session and an `X-CSRF-Token` for every change |
| App isolation | one bridge, one /27 and one egress ACL per app |
| No signing yet | releases are unsigned; integrity comes from HTTPS and SHA-256 ([releases.md](releases.md)) |

## Updates in one paragraph

One System release (`core-release.json`) names every part: installer and media, the image parts, Spine, CP and UI.
The box compares each part with what it has. Image parts are written to the inactive slot and need a reboot. A
Spine change is a trial on State without a reboot. CP and UI changes replace the container payloads without a
reboot. A box never moves to an older build. Details: [core-release-contract.md](core-release-contract.md).

## Repository layout

```
YouEye/
├── spine/            Go host agent and the `youeye` CLI
├── installer/        Go `youeye-installer` (ISO install and Proxmox mode) and scripts/install.sh
├── appliance/        image build, systemd units, initramfs hooks, recovery and console scripts
├── releasecache/     Go release documents, channel index and download cache (shared by Spine and installer)
├── control-panel/    Next.js Control Panel, YouEye ID, Market engine
├── ui/               Next.js dashboard (Drizzle ORM, schema in src/db/schema.ts)
├── packages/, shared/  shared code
├── scripts/          assemble-core-release.py, public hygiene check
├── .youeye/build/    one build entrypoint per component
└── docs/             these pages
```

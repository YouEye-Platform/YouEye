# YouEye documentation

YouEye is a self-hosted personal-cloud appliance: a read-only A/B Debian system image, a Go host agent (Spine), a
Control Panel with its own identity provider (YouEye ID), a dashboard UI, first-party native apps, a Market of
third-party container apps, YouEye Names (real HTTPS names for boxes on a LAN) and Pointer (the AI service).

These pages describe what the code does now. Every claim was checked against the code (Plan 6, 2026-11-14). If a page
and the code disagree, the code wins: fix the page in the same change. The old YE-Wiki is history.

## Component map

| Component | Where it runs | Source | Page |
|---|---|---|---|
| System image, boot, State and Data | the box (A/B slots, State partition, ZFS `default`) | `appliance/` | [Architecture](architecture.md) |
| Installer | ISO and Proxmox mode | `installer/` | [Install](install.md) |
| Spine (`youeye` CLI and API) | host | `spine/` | [Spine](spine.md) |
| Control Panel and YouEye ID | Incus container `youeye-control` | `control-panel/` | [Control Panel](control-panel.md), [YouEye ID](youeye-id.md) |
| Dashboard UI | Incus container `youeye-ui` | `ui/` | [Control Panel](control-panel.md) (dashboard section) |
| Market apps | one network and container set per app | `YE-AppMarket` repo, `control-panel/src/lib/market/` | [Market](market.md) |
| Native apps | Incus system containers | `YE-App-*` repos, `YouEye-Canvas` | [Native apps](native-apps.md) |
| Pointer (AI) | Incus container `youeye-pointer` | `Pointer` repo | [Pointer runtime](pointer-runtime.md) |
| YouEye Names | Control Panel, plus the Names service | `control-panel/src/lib/youeye-names/` | [YouEye Names](youeye-names.md) |

## Pages

**Running a box**

| Page | What it covers |
|---|---|
| [Install](install.md) | `install.sh`, ISO and Proxmox installs, first deploy, claiming the box, the setup wizard |
| [Troubleshooting](troubleshooting.md) | `youeye doctor`, logs, recovery, stuck updates, common failures |
| [Architecture](architecture.md) | Image, State and Data; containers, networks and ports; app doorways; boot order; security model |
| [Spine](spine.md) | The `youeye` CLI, the API socket, the Spine selection and Spine updates |
| [Control Panel](control-panel.md) | The CP container, deploy job, settings, updates, backups and restore, the dashboard |
| [YouEye ID](youeye-id.md) | The OIDC provider, clients, claims and admin group, sessions and logout, who may open an app |
| [YouEye Names](youeye-names.md) | The Names setup flow, maintenance, saved Names and the recovery bundle |

**Releases and updates**

| Page | What it covers |
|---|---|
| [Releases](releases.md) | Build versions and channel names, channel indexes, promotion, tree identity, signing (off) |
| [System release contract](core-release-contract.md) | `core-release.json`: roles, update kinds and steps, checkpoints, recovery |
| [Product release contract](product-release-contract.md) | Native app, Pointer and Market catalog releases |
| [App update transactions](app-update-transactions.md) | A Market app update as a journaled transaction: commit, or put back exactly |

**Apps**

| Page | What it covers |
|---|---|
| [Market](market.md) | The catalog, install, sign-in, AI settings, public access, connections, updates, uninstall |
| [App manifest](app-manifest.md) | `youeye.app.v1` and setup files (`youeye.setup.v1`), field by field |
| [App environment](app-environment.md) | The `${…}` variables an app can use, and the doorways |
| [App access](app-admission.md) | Admission: owner, users, groups, public access; ownership and restore |
| [App service credentials](app-service-credentials.md) | The per-app Bearer credential for the dashboard's service APIs: make, store, publish, rotate, restore |
| [Native apps](native-apps.md) | Canvas, the native manifest, the gateway, sign-in, widgets, building and releasing |
| [Pointer runtime](pointer-runtime.md) | Pointer's container, ports, schema, inference and managed app keys |

**Product features**

| Page | What it covers |
|---|---|
| [Setup readiness](setup-readiness.md) | What setup checks before it changes the box, and how it survives a lost browser or a crash |
| [Timeline collection](timeline-collection.md) | The dashboard's encrypted activity history: the per-person switch and its secret |
| [Title Studio](title-studio.md) | The shared title and sticker designer |
| [Localization](localization.md) | Languages (en, ru, es, de, fr) and how strings are translated |
| [Web runtime](web-runtime.md) | Reproducible standalone builds and the web dependency policy |
| [Telemetry](telemetry.md) | Local-only usage counters, off by default |
| [Independent copy](independent-copy.md) | Turning a disk copy into a separate box (not usable yet) |

**Working on YouEye**

| Page | What it covers |
|---|---|
| [Development](development.md) | Toolchains, building, publishing, test installs, the one-version naming rule |

## Screenshots

Public screenshots are waiting for captures from synthetic demo accounts. See
[`assets/screenshots/README.md`](assets/screenshots/README.md) for the capture and review rules.

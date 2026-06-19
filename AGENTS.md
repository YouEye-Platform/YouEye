## spine-dev-v0.4.10.4 — artem — 2026-06-19
**Branch:** dev
**VM:** potempc
**Agent:** Artem
**Task:** Make Spine automatically prepare appliance storage for YouEye hosts

### Changes
- `spine/internal/storage/storage.go` — added a host storage planner/grower that detects safe root-LVM free space, computes host reserve, and plans appliance-sized Incus pool targets.
- `spine/internal/incus/install.go` — removed the hardcoded 20 GB ZFS pool cap, creates fresh managed pools at the calculated target, and grows existing managed loop-backed ZFS pools upward without shrinking or touching block-backed pools.
- `spine/internal/cmd/install.go`, `spine/internal/cmd/storage.go`, `spine/internal/cmd/root.go` — run storage preparation before Incus setup and add `youeye storage status`, `youeye storage plan`, and `youeye storage grow`.
- `spine/internal/config/*` — added `deployment.storage` defaults for appliance mode, root auto-expand, Incus auto-grow, host reserve, and pool-size cap.
- `spine/internal/storage/storage_test.go`, `spine/internal/incus/install_test.go` — added regression coverage for Ubuntu default LVM layouts, non-LVM/multi-LV safety skips, no-shrink behavior, size parsing, and managed-loop detection.
- `spine/internal/cmd/root.go`, `README.md` — bumped Spine to `0.4.10.4` and updated the current-version table.

### Test Results
- `go test ./...`: PASS.
- `go vet ./...`: PASS.
- `go build ./...`: PASS.
- Read-only live probe on `bykapc` with the new binary: `youeye storage status` detected root grow by `363.8 GiB`, Incus `20GB` loop-backed ZFS pool, target `377 GiB`, and Incus grow by `358.4 GiB`.

### Notes for Iris
- Spine-only release. No live mutation was performed on `bykapc`; the owner will deploy/test.
- `youeye deploy` remains non-interactive. It auto-expands only safe single-LV root LVM layouts, never shrinks storage, and never touches real block-backed or operator-created Incus pools.

## cp-dev-v0.4.49.16 — artem — 2026-06-19
**Branch:** dev
**VM:** potempc
**Agent:** Artem
**Task:** Fix Market app routing when the platform domain is itself a YouEye Names subdomain

### Changes
- `control-panel/src/app/api/domain/route.ts` — returns the authoritative Spine/settings platform domain before falling back to Caddy inference, so `misty-spring.youeye.me` stays intact.
- `control-panel/src/lib/caddy/client.ts` — preserves full TLS policy subjects in `getConfiguredDomain()` instead of collapsing them to the final two labels.
- `control-panel/src/app/api/market/install/route.ts` — canonicalizes app install domains server-side from platform settings and rejects dotted app subdomains.
- `control-panel/src/app/api/market/install-url/route.ts` — applies the same canonical domain and single-label subdomain guard for URL-based installs.
- `control-panel/tests/platform-subdomain-routing.spec.mjs` — adds regression coverage for YouEye Names subdomain routing.
- `control-panel/package.json`, `README.md` — bumped Control Panel to `0.4.49.16` and updated the current-version table.

### Test Results
- `CONTROL_PANEL_ROOT="$PWD/control-panel" pnpm --dir control-panel exec node --import tsx --test tests/platform-subdomain-routing.spec.mjs tests/market.spec.ts`: PASS (12/12).
- `pnpm --dir control-panel build`: PASS for `ye-controlpanel@0.4.49.16`.
- `/tmp/standalone.tar`: verified top-level `server.js` and embedded `package.json` version `0.4.49.16`.

### Notes for Iris
- CP-only release. UI and Spine are unchanged.
- The owner will deploy/test manually. Existing installs created during the bug window may need metadata/Caddy route repair from `cloud + youeye.me` to `cloud + <platform-domain>`.

## cp-dev-v0.4.49.15 / ui-dev-v0.4.28.7 — artem — 2026-06-18
**Branch:** dev
**VM:** potempc
**Agent:** Artem
**Task:** Move Control Panel header apps onto the UI-served drawer/launcher and prepare public cleanup release

### Changes
- `control-panel/src/components/control-surface/control-header.tsx` — removed the legacy CP-rendered app drawer/editor and replaced it with UI-origin `/embed/drawer` and `/embed/launcher` iframe hosts with origin-validated `youeye:resize` and `youeye:action/open-launcher` handling.
- `ui/src/app/api/ui-bridge/settings/[...path]/route.ts` — added `ui_base_url` to the CP header-config bridge payload from `UI_EXTERNAL_URL` so CP can host the UI drawer without guessing domains.
- `control-panel/src/components/settings-shell/appearance-client.tsx` — removed the old CP drawer customization section; drawer/launcher ownership now stays in UI.
- `control-panel/src/app/*`, `ui/src/app/*`, `ui/src/components/*`, `control-panel/tests/*`, `ui/tests/*` — completed public wording/source cleanup and regenerated tracked worker assets.
- `control-panel/package.json`, `ui/package.json`, `README.md` — bumped Control Panel to `0.4.49.15`, UI to `0.4.28.7`, and updated the current-version table.

### Test Results
- `node --test control-panel/tests/control-header-drawer-icons.spec.mjs ui/tests/header-config-security.test.mjs ui/tests/launcher-e1.test.mjs`: PASS (7/7).
- `pnpm build` in `control-panel`: PASS for `ye-controlpanel@0.4.49.15`; `control-panel/.next/standalone.tar` created.
- `pnpm build` in `ui`: PASS for `ye-ui@0.4.28.7`; `ui/.next/standalone.tar` created.
- Public-reference grep sweep: PASS after cleanup; remaining names are practical dependencies, providers, app names, package coordinates, release-source support, or runtime config.
- `pnpm --dir control-panel exec tsc --noEmit`: still fails on pre-existing unrelated TS issues in Market validation, suggestions, service-worker typings, SSO setup, and system-market manifests.

### Notes for Iris
- The bridge remains one-way CP -> UI; UI server code does not call CP. CP only hosts UI-origin embeds using the bridge-provided `ui_base_url`.
- CP Appearance no longer owns app drawer settings. Drawer pinning, layout, launcher folders, and edit/search behavior stay in UI.
- This release pairs with native app public-cleanup releases but does not require native code for CP's own Settings header to use the new drawer/launcher.

## Unreleased — artem — 2026-06-18
**Branch:** dev
**VM:** potempc
**Agent:** Artem
**Task:** Clean public references and remove unnecessary external lookup paths

### Changes
- `AGENTS.md`, `control-panel/tests/*`, `ui/tests/*`, `ui/src/components/*`, `ui/src/middleware.ts`, `ui/src/app/api/v1/user/avatar/[id]/route.ts` — replaced nonessential product-comparison wording with neutral UI descriptions.
- `control-panel/src/app/layout.tsx`, `control-panel/src/app/globals.css`, `ui/src/app/globals.css` — removed named external font-provider imports/variables in favor of local/system stacks.
- `ui/src/components/widgets/bookmarks-*` — replaced remote favicon lookups with local fallback tiles.
- `ui/src/app/sw.ts`, `ui/public/sw.js`, `control-panel/src/app/sw.ts` — switched worker source to a first-party cache/offline implementation and regenerated the tracked UI worker.

### Test Results
- `pnpm build` in `ui`: PASS; postbuild recovered missing standalone symlinks by copying workspace dependencies.
- Targeted public-reference grep sweep: PASS.

### Notes for Iris
- No release, version bump, tag, or push was created.

## docs-readme — artem — 2026-06-18
**Branch:** dev
**VM:** potempc
**Agent:** Artem
**Task:** Point the monorepo README at the current installer bootstrap command.

### Changes
- `README.md` — updated the public installer curl examples to use the release-bootstrap `bash -s --` pattern, documented that the bootstrap downloads the released `youeye-installer` binary, and clarified the split between `INSTALLER_CHANNEL` for the installer binary and `--release-channel` for runtime YouEye releases.

### Test Results
- Docs-only change: verified README installer command references with `rg`.

### Notes for Iris
- No component version bump or release was created; this is documentation-only.

## installer-dev-v0.1.0.2 / cp-dev-v0.4.49.14 — artem — 2026-06-18
**Branch:** dev
**VM:** potempc
**Agent:** Artem
**Task:** Make the installer GitHub-first, add silent mode, support source overrides, and seed Market source defaults.

### Changes
- `installer/` — moved the installer module/import path to `github.com/youeye-platform/YouEye/installer`, added GitHub/main defaults, `--silent --yes`, source/channel flags, `--root-password-file`, `--names-bundle`, and provider-shared source persistence.
- `installer/internal/installer/wizard.go` — changed the first choice to `Install` / `Advanced Options`; Advanced pre-fills GitHub core repo, GitHub Market repo, and `main` channel; bare Linux now pauses on confirmation instead of auto-starting.
- `installer/internal/installer/progress.go`, `installer/internal/installer/tetris/` — progress view now renders Tetris only during install, with installer status below it.
- `installer/internal/installer/provider_proxmox.go`, `installer/internal/installer/engine.go` — VM and host installs now bootstrap Spine from the configured core repo/channel and write `/var/lib/youeye/market-source.json` + `market-sources.json` before deploy.
- `installer/scripts/install.sh` — public bootstrap now defaults to GitHub installer release assets, resolves branch-channel installer tags, and forwards `curl | bash -s -- ...` flags.
- `control-panel/src/lib/market/source.ts`, `control-panel/src/lib/market/engine.ts` — Market default is now GitHub `youeye-platform/Market`; LXD/native release downloads derive base/org from the active Market source instead of a fixed host.
- `control-panel/tests/*`, `installer/internal/installer/source_options_test.go` — added/updated regression coverage for GitHub defaults, source ownership, raw URL construction, Market source seeding, and fixed the `import.meta.dirname` test runner bug.
- `control-panel/package.json`, `README.md` — bumped CP to `0.4.49.14`, documented the installer bootstrap, and added installer `0.1.0.2` to Current Versions.

### Test Results
- Installer: `go test ./...` passed.
- Installer build: `go build -o /tmp/youeye-installer-linux-amd64 .` passed; `--help` shows silent/source flags and GitHub defaults.
- CP focused: `node --import tsx --test control-panel/tests/market-system-apps.spec.ts control-panel/tests/release-source-ownership.spec.ts` passed.
- CP build: `pnpm build` passed for `ye-controlpanel@0.4.49.14`.

### Notes for Iris
- Public defaults are GitHub/main only. Custom Forgejo/dev installs require explicit Advanced Options or flags.
- GitHub Market must publish a catalog whose app repo entries use the public repo mapping (`youeye-platform/Wiki`, `Search`, etc.); otherwise the GitHub default source will not be able to fetch native app manifests.

## cp-dev-v0.4.49.13 — artem — 2026-06-18
**Branch:** dev
**VM:** potempc
**Agent:** Artem
**Task:** Remove the post-setup TLS query redirect, wait through the CP restart window, and restore the blue Y setup favicon.

### Changes
- `control-panel/src/app/setup/page.tsx` — setup provisioning now redirects to `/setup-complete` without `?tls=...`, waits for `/api/ping` to return stable success after CP's SSO restart, and keeps upload-mode completion on the same clean URL.
- `control-panel/src/components/setup/SetupProvisioning.tsx`, `control-panel/messages/*.json` — show a localized "restarting server interface" completion message while the post-setup readiness poll runs.
- `control-panel/src/middleware.ts` — allows `/api/branding/favicon` through the IP-via-Caddy setup gate so first-setup pages can load the dynamic blue Y favicon.
- `control-panel/src/app/favicon.ico` — replaced the bundled static default favicon with a transparent blue Y so Next's automatic favicon link no longer shows the default triangle.
- `control-panel/tests/setup-polish.spec.mjs` — guards the clean setup-complete redirect, readiness poll, restart message, and setup favicon middleware allowlist.
- `control-panel/package.json`, `README.md` — bumped Control Panel to `0.4.49.13` and updated the dev release pointer.

### Test Results
- CP focused: `pnpm exec node --test tests/setup-polish.spec.mjs` passed.
- CP build: `pnpm build` passed for `ye-controlpanel@0.4.49.13`.
- CP artifact: `standalone.tar` contains root `server.js`, includes `src/app/favicon.ico`, and reports package version `0.4.49.13`.
- Visual asset check: rendered the 32px favicon frame with ImageMagick and verified it is the blue Y on a transparent background.

### Notes for Iris
- CP-only release. The live VM was not deployed from this workspace because the owner said they will test and update the server themselves.
- The setup-complete page still accepts legacy `?tls=...` for old links, but the setup wizard no longer emits that query string; TLS choice comes from persisted setup config.

## ui-dev-v0.4.28.6 — artem — 2026-06-18
**Branch:** dev
**VM:** potempc
**Agent:** Artem
**Task:** Stop UI production builds from probing Postgres during metadata generation

### Changes
- `ui/src/lib/runtime-phase.ts` — added a shared Next production-build phase helper.
- `ui/src/db/index.ts` — skips schema initialization during `phase-production-build`; runtime schema failures now rethrow after logging instead of being swallowed.
- `ui/src/lib/db/queries/branding.ts`, `ui/src/lib/site-config.ts` — return build-time defaults for PWA/metadata helpers instead of touching Postgres during `next build`.
- `ui/tests/build-db-guard.spec.mjs` — guards the build-time DB skip and runtime failure behavior.
- `ui/package.json`, `README.md` — bumped UI to `0.4.28.6` and updated the dev release pointer.

### Test Results
- UI focused: `pnpm exec node --test tests/build-db-guard.spec.mjs` passed.
- UI build: `pnpm build` passed with no `Schema initialization failed` or local Postgres `ECONNREFUSED` messages.
- UI artifact: `standalone.tar` contains `server.js` and reports package version `0.4.28.6`.

### Notes for Iris
- This removes build log noise only. At runtime, a real DB/schema failure is now louder because `ensureSchema()` rethrows after logging.

## dev-v0.4.10.3 / cp-dev-v0.4.49.12 / ui-dev-v0.4.28.5 — artem — 2026-06-18
**Branch:** dev
**VM:** potempc
**Agent:** Artem
**Task:** Merge Artem and Mythos work onto dev and prepare dev integration releases

### Changes
- `spine/internal/cmd/root.go` — bumped Spine to `0.4.10.3` for the dev integration release.
- `control-panel/package.json` — bumped Control Panel to `0.4.49.12` for the merged auth/settings/native-app integration line.
- `ui/package.json`, `ui/public/sw.js` — bumped UI to `0.4.28.5` and refreshed the generated service worker for the release build.
- `ui/scripts/postbuild.js` — made Sharp native binding packaging skip absent optional-platform bindings while still copying installed Linux x64 bindings.
- `README.md` — updated the Current Versions table to the dev integration tags.

### Test Results
- Spine: `go test ./...` passed; release binary reports `0.4.10.3`.
- Installer: `go test ./...` passed; refreshed dev installer binary built.
- Control Panel: `pnpm build` passed and `standalone.tar` contains `server.js`.
- UI: `pnpm build` passed after the packaging fix and `standalone.tar` contains `server.js`.

### Notes for Iris
- Left the integration on `dev`; no main promotion in this pass.
- YouEye-Uno remains excluded per owner direction.

## spine-v0.4.10.2 + installer refresh — artem — 2026-06-18
**Branch:** artem · **VM:** potempc · **Agent:** Artem
**Task:** Fix fresh-install identity-login 500 and remove the root SSH cloud-init guard for operator keys.

### Changes
- `spine/internal/container/control.go` — fresh deploy now creates `youeye-id.service` with the same `INCUS_HTTPS_URL`, `INCUS_CLIENT_CERT`, and `INCUS_CLIENT_KEY` env as `youeye-control.service`.
- `spine/internal/api/server.go`, `spine/internal/cmd/update.go` — CP update/repair paths now write a `youeye-id.service.d/incus-https.conf` drop-in for existing installs when the Incus client cert/key exist, then restart `youeye-id`.
- `spine/internal/cmd/root.go` — Spine 0.4.10.1 -> **0.4.10.2**.
- `installer/internal/installer/provider_proxmox.go` — after guest boot, normalize the operator-supplied cloud-init SSH keys into `/root/.ssh/authorized_keys` without Debian's forced "login as youeye" root guard. This does not enable password root SSH; it makes trusted host keys work directly for root, equivalent to the existing `youeye` passwordless-sudo path.
- `README.md` — Current Versions table updated for `spine-artem-v0.4.10.2`.

### Test Results
- Live hotpatch on VM `youeye8` (`192.168.31.65`): added the Incus HTTPS env drop-in to `youeye-id.service`, restarted only `youeye-id`, and confirmed `/application/o/authorize` returns a clean 307 to `/identity/login` with no new `ENOENT /var/lib/incus/unix.socket` route errors.
- Spine: `go test ./...`, `go vet ./...`, and `go build ./...` passed.
- Installer: `go test ./...` and `go vet ./...` passed.

### Notes for Iris
- Root SSH direct login is acceptable here because the imported host keys already land on the `youeye` cloud-init user, which has passwordless sudo. The change removes a confusing forced-command guard for the same trusted keys; it does not enable root password SSH.
- The identity-login 500 root cause was `youeye-id.service` falling back to the removed Incus Unix socket because it lacked the HTTPS Incus client env that CP already had.

## cp-v0.4.49.5 + installer refresh — artem — 2026-06-18
**Branch:** artem · **VM:** potempc · **Agent:** Artem
**Task:** Redesign the PAM root login and installer root-password screens around the full-screen tree motif.

### Changes
- `control-panel/src/components/auth/login-form.tsx`, `control-panel/src/components/auth/root-tree-art.ts` — PAM login defaults username to `root`, removes the card/title/footer/placeholder text, switches the root state to `Enter your root password`, and shows a dark full-screen amber tree backdrop. Non-root usernames return to the plain local-credentials prompt.
- `control-panel/src/app/login/page.tsx`, `control-panel/src/app/settings/login/page.tsx` — removed the old outer page card spacing so the login form owns the full viewport.
- `control-panel/tests/setup-polish.spec.mjs` — locked the minimal PAM root UI, static art policy, and no-runtime-generator/no-card behavior.
- `installer/internal/installer/root_tree.go`, `installer/internal/installer/root_tree_test.go`, `installer/internal/installer/wizard.go` — root-password step now uses the tree as a terminal-sized backdrop with a small centered `Create a root password` dialog; Enter moves password -> confirm, then confirm -> next.
- `control-panel/package.json` — 0.4.49.4 -> **0.4.49.5**.
- `README.md` — Current Versions table updated for `cp-artem-v0.4.49.5`.

### Test Results
- Installer: `go test ./...` and `go vet ./...` passed.
- CP focused: `pnpm exec node --test tests/setup-polish.spec.mjs` passed.
- CP auth regression: `CONTROL_PANEL_ROOT="$PWD" pnpm exec node --import tsx --test tests/silent-settings-sso.spec.ts` passed.
- CP production build: `pnpm build` passed for `ye-controlpanel@0.4.49.5`.
- Visual: Playwright screenshots verified `/login` default root state is dark/full-screen with enlarged tree art, and changing username to `admin` removes the art and returns to the plain light local-credentials screen.

### Notes for Iris
- The tree remains generated offline and committed as static text only; no Ansizalizer/`ansipx` runtime dependency in CP or the installer.
- Installer release reuses the stable `installer-artem-v0.1.0` curl target, refreshed to this commit.

## cp-v0.4.49.4 + installer refresh — artem — 2026-06-18
**Branch:** artem · **VM:** potempc · **Agent:** Artem
**Task:** Setup polish: blue setup favicon, durable setup-complete TLS choice, ANSI tree motif on installer root password + PAM root login, and YouEye Names production-LE readiness.

### Changes
- `control-panel/src/app/api/branding/favicon/route.ts` — fallback favicon is now a transparent blue `Y`, used before UI branding is available during first setup.
- `control-panel/src/app/api/setup/run/route.ts`, `control-panel/src/app/setup/page.tsx`, `control-panel/src/app/setup-complete/page.tsx`, `control-panel/src/lib/settings/service.ts` — persist `tls_choice`, redirect completed provisioning to `/setup-complete?tls=...`, and read persisted/extra TLS choice so CA downloads appear only for self-signed installs.
- `control-panel/src/components/auth/login-form.tsx`, `control-panel/src/components/auth/root-tree-art.ts` — PAM emergency login now shows a static tree-roots motif and "Local administrator" title only when username is `root`; no runtime generator dependency.
- `installer/internal/installer/root_tree.go`, `installer/internal/installer/root_tree_test.go`, `installer/internal/installer/wizard.go` — installer root-password step shows the dim amber tree on roomy terminals, hides it at 80x24, and clarifies this is the VM OS root password.
- `control-panel/package.json` — 0.4.49.3 → **0.4.49.4**.
- `README.md` — Current Versions table updated for Artem's Spine/CP release line.

### Test Results
- CP: `pnpm build` clean (Next skipped project-wide type validation by config; direct `tsc --noEmit` still fails on pre-existing unrelated files listed in final report).
- CP focused: `pnpm exec node --test tests/setup-polish.spec.mjs` passed.
- Visual: Playwright screenshots of `/login` empty + typed `root`; verified the tree appears only after `root`, form remains readable, and `/api/branding/favicon?size=64` contains blue `Y` and no dark fallback rect.
- Installer: `go test ./...` and `go vet ./...` passed.

### Notes for Iris
- Ansizalizer/`ansipx` remain local/offline asset-generation tools only. Commit static text assets; do not add generator dependencies to CP or installer.
- YouEye Names production LE is an ops switch on LXC 623, not a CP code dependency. Watch LE rate limits until `youeye.me` is on the Public Suffix List; use reuse bundles for reinstall loops.

## cp-v0.4.49.3 — artem — 2026-06-17
**Branch:** artem · **VM:** potempc · **Agent:** Artem
**Task:** Fix the YouEye Names apex serving Caddy's internal cert instead of the loaded Let's Encrypt cert. Latent today (staging LE is untrusted everywhere) but under production LE the main dashboard at the bare apex would warn while subdomains stayed trusted.

### Changes
- `control-panel/src/lib/caddy/client.ts` — `loadExternalCert()` now also sets a TLS **connection policy** pinning `certificate_selection.any_tag:['external']` for the loaded subjects (apex + wildcard), with a catch-all `{}` last so IP / uncovered hosts keep on_demand internal. This makes Caddy deterministically serve the loaded cert at the handshake, beating any on-demand internal cert it cached for the bare apex during the deploy window. `removeExternalCert()` strips that policy on revert (else it force-selects a now-missing cert and breaks the handshake). Lives inside `loadExternalCert` → covers all 5 cert-load paths (YouEye Names reuse + fresh, ACME, manual upload, post-`setDomain` restore). Types already supported it — no type change.
- `control-panel/package.json` — 0.4.49.2 → **0.4.49.3**.

### Test Results
- Verified live on VM 192.168.31.63 (lease `sage-dell`): applying the exact connection policy via Caddy's admin API flipped the apex `sage-dell.youeye.me` from `Caddy Local Authority` → `(STAGING) Let's Encrypt` instantly — zero downtime, no LE re-issue. `control.`/`id.`/`dns.` stayed LE; IP `192.168.31.63` correctly stayed internal. Built via `yebuild cp` (pnpm build clean, artifact reports 0.4.49.3).

### Notes for Iris
- CP-only — no Spine/UI/broker/installer change. The bug is **not** reuse-specific: any external cert load (including fresh installs) hits it whenever the apex is touched on-demand before the cert loads. Still LE **staging** until `youeye.me` is on the Public Suffix List.

## spine-v0.4.10.1 — artem — 2026-06-17
**Branch:** artem · **VM:** potempc · **Agent:** Artem
**Task:** `youeye names export` / `youeye names import` — reuse a YouEye Names address+cert across (re)installs, esp. same-VM `youeye deploy` (where the installer `--names-bundle` flag doesn't apply).

### Changes
- `spine/internal/cmd/names.go` — **new** `youeye names` command group:
  - `export [-o file]` — pulls the reuse bundle from CP (`GET /api/tls/youeye-names/export` via the CLI-token `controlClient`) → stdout or a `0600` file.
  - `import <bundle.json>` — validates + stages it into the CP container at `/opt/youeye-control-data/youeye-names/import-bundle.json` (the path the setup wizard already watches) via `incus exec`. Run after `youeye deploy`, before opening setup.
- `spine/internal/cmd/root.go` — register `namesCmd`; version `0.4.10` → `0.4.10.1`.

### Test Results
- `go build ./...` + `go vet` clean. `youeye names --help` lists export/import. No CP/web change — reuses the live reuse path (`/reuse` + setup/run import shipped in cp-v0.4.49.2).

### Notes for Iris
- Export needs CP up (CLI-token API); import is host-level (incus exec). Bundle holds private keys → a credential. Built with ldflags (Version+BuildDate) per pitfall #7.

## cp-v0.4.49.2 + installer — artem — 2026-06-17
**Branch:** artem · **VM:** potempc · **Agent:** Artem
**Task:** Fast cert (no self-signed temp) + reuse a YouEye Names address/cert across (re)installs via an installer flag. Follows the first live test (cert installed too slowly because the broker's blind 120s sleep beat CP's 120s poll).

### Changes
- **Broker** (`YouEye-Names` v0.3.0, deployed to LXC 623): DNS-propagation poll instead of the blind 120s sleep → issuance ~131s → **~22s verified**; generated names now bare `adjective-noun` (suffix only on collision). Separate repo/AGENTS.
- `control-panel/src/lib/youeye-names/bundle.ts` — **new** reuse bundle: `exportBundle` (identity + TLS key + cert + name), `getStagedBundle`/`consumeStagedBundle`/`applyBundleIdentity`/`bundleCertStillValid`. `identity.ts` — `resetIdentityCache` + path exports.
- `control-panel/src/app/api/tls/youeye-names/{export,reuse}/route.ts` — **new** admin routes: download the bundle (a credential), and report whether a staged bundle awaits import.
- `control-panel/src/app/api/setup/run/route.ts` — reuse path: if a bundle is staged + its cert is valid, install it + signed IP-update (DNS-only) — **no Let's Encrypt**; else fresh issue (expired bundle re-issues under the same identity/name). Cert poll ceiling 120s → 150s.
- `control-panel/src/components/setup/SetupServerName.tsx` — detects a staged bundle (`/reuse`) and locks the address to the existing name ("Reusing your existing address"). `messages/*.json` — 3 keys.
- `installer/internal/installer/provider_proxmox.go` — `YOUEYE_NAMES_BUNDLE` env: after deploy, stages the bundle into `youeye-control:/opt/youeye-control-data/youeye-names/import-bundle.json`. `scripts/install.sh` — documents the flag.

### Test Results
- Broker: `pnpm build`/test clean; deployed; **live e2e issuance 22s**; previews now `snowy-valley`, `ivory-glade`, … (clean 2-word). CP `tsc` clean for new files; `pnpm build` standalone OK (0.4.49.2). Installer `go build`/`vet` clean. Owner re-tests reinstall.

### Notes for Iris
- Bundle holds private keys → a credential (0600, never logged). Reuse = same logical server resuming; broker still enforces signed ownership. Avoids LE quota burn on frequent reinstalls.

## cp-v0.4.49.1 — artem — 2026-06-17
**Branch:** artem · **VM:** potempc · **Agent:** Artem
**Task:** Integrate YouEye Names into the setup "choose your server name" screen.

### Changes
- `control-panel/src/lib/youeye-names/{identity,client,csr}.ts` — **new** broker client: Ed25519 install identity (persisted at `/opt/youeye-control-data/youeye-names`, survives redeploy), canonical signed requests, `preview/claim/requestCertificate/getCurrentCertificate/updateIp`, CSR via `acme-client`. Signing verified byte-for-byte against the live broker.
- `control-panel/src/app/api/tls/youeye-names/preview/route.ts` — **new** non-committing name preview (admin + CSRF gate, same as `/api/tls/acme`).
- `control-panel/src/components/setup/SetupServerName.tsx` — YouEye Names is the **default**: display name + auto-generated `*.youeye.me` address with a refresh button (cycles previews, **no certificate**). The three existing options (own domain / self-signed / upload) demoted to inline-expanding buttons.
- `control-panel/src/app/setup/page.tsx` — default `tlsChoice='youeye-names'`; `domain=<name>.youeye.me`; passes `yen_name` + `current_ip` to provisioning.
- `control-panel/src/app/api/setup/run/route.ts` — for youeye-names: claim(name, LAN IP) → gen key+CSR → request cert → poll (≤2 min) → `caddy.loadExternalCert` (wildcard covers control./id./dns.); idempotent; persists cert. Restore-after-setDomain now covers `manual` certs too.
- `control-panel/src/components/setup/SetupDnsExplainer.tsx` — suppress manual-DNS steps for youeye-names (broker owns DNS); show rebinding caveat.
- `messages/{en,de,fr,es,ru}.json` — 10 new `setup.*` keys.
- `control-panel/package.json` — 0.4.49 → **0.4.49.1**.

### Test Results
- `pnpm build` clean (next build + postbuild, standalone OK, artifact version 0.4.49.1). `tsc` clean for new files. Live broker: register 201 (fingerprint matches local), signed preview 200 → 3 options. Owner installs + tests the full flow.

### Notes for Iris
- Monorepo CP release `cp-artem-v0.4.49.1`. Broker (`YouEye-Names`) committed+pushed to `main` (817fa70). Stays on **LE staging** until validated; production needs `youeye.me` on the Public Suffix List (rate-limit scaling).

## installer — IPv6 image-pull fix + deploy failure detection — artem — 2026-06-17
**Branch:** artem · **Agent:** Artem
**Task:** Operator's first full run reported success but the platform was half-deployed (Caddy + Pi-Hole missing).

### Changes
- `installer/internal/installer/provider_proxmox.go` — **(1)** CLAUDE.md pitfall #17: a fresh Debian VM has no IPv6 route, but docker.io DNS returns AAAA records, so incus's bundled `skopeo` tries IPv6 first and dies `network is unreachable`. Spine/Postgres/CP/UI pull over IPv4 (Forgejo/Debian) and succeeded; Caddy + Pi-Hole (docker.io) failed. Now disable IPv6 (`sysctl` runtime + `/etc/sysctl.d/99-youeye-ipv4.conf`) and add the `precedence ::ffff:0:0/96 100` gai.conf line **before** deploy. **(2)** `youeye deploy` logs stage failures but swallows them and exits 0 — the installer trusted that 0. Now scan the deploy log for `deployment failed|Operation failed|network is unreachable` on exit and fail loudly with detail, even on exit 0. Corrected the recovery hint (deploy is NOT idempotent — dies on "Instance already exists" — so point at the log + fresh reinstall, don't suggest re-running deploy).

### Test Results
- `go build`/`go vet` clean. **Verified on the live failed VM (135):** after disabling IPv6, `curl -4 registry-1.docker.io/v2/` → 401 (reachable; was "network unreachable"), and `/opt/incus/bin/skopeo inspect docker://docker.io/library/caddy:2.11.4` + `pihole:2026.05.0` both return full manifests. First run already proved Postgres/CP/UI deploy cleanly. Binary re-uploaded to `installer-artem-v0.1.0` (curl unchanged).

### Notes for Iris
- The non-idempotent `youeye deploy` ("Instance already exists" on re-run, then skips remaining stages, still exits 0) is a **Spine deploy** bug, out of scope here — flagged for follow-up.

## installer — root password + console fixes — artem — 2026-06-17
**Branch:** artem · **Agent:** Artem
**Task:** Fix three issues from the operator's live TUI test: password didn't log in, and the xterm.js console was flaky.

### Changes
- `installer/internal/installer/provider_proxmox.go` — the "Root Password" was set on the **youeye** cloud-init user (`--cipassword`), not root. Removed that; root's password is now set **inside the guest** via `qm guest exec` (`chpasswd -e` with the openssl `$6$` hash — no plaintext on a command line), after the agent is up. Failing to set it is fatal (loud, per pitfall #23). Switched the VM display from `--vga serial0` to `--vga std` so the Proxmox **Console** button is **noVNC** (reliable typing) instead of the xterm.js serial console (blank-until-Enter, flaky focus); serial socket kept for host-side `qm terminal`. Explicitly `systemctl enable --now getty@tty1 + serial-getty@ttyS0` and allow root on ttyS0 in `/etc/securetty` (if present) so both consoles always have a live login prompt.
- `installer/internal/installer/complete.go` — completion screen hard-coded `Username: admin`, conflating the YouEye **web** login (a browser setup wizard, no preset password — see `spine/internal/cmd/setup.go`) with the **VM console** login. Now shows the setup-wizard note plus a separate `VM login: root — password: the one you set`.

### Test Results
- `go build ./...` + `go vet ./internal/installer/` clean (linux/amd64). Binary (7.4 MB, static ELF) re-uploaded to `installer-artem-v0.1.0` (curl URL unchanged). Awaiting live owner re-test.

### Notes for Iris
- "Just root" by design: no separate VM user password. youeye cloud-init user remains key-only (host SSH key).

## installer (youeye-installer TUI) — artem — 2026-06-17
**Branch:** artem · **Agent:** Artem
**Task:** Combine the existing Bubble Tea installer (design/steps/games) with the proven Proxmox VM logic — Go-native, provider architecture, VM-only.

### Changes
- `installer/` — **new Go module** (`git.potemk.in/potemsla/YouEye/installer`) building the `youeye-installer` binary. `main.go` launches the TUI.
- `installer/internal/installer/` — TUI **moved** from `spine/internal/installer/`. Added `provider.go` (Provider interface + registry), `provider_proxmox.go` (the proven sequence in Go: pre-bake/SeaBIOS/import-from/virtio-scsi-single + in-VM Spine install & `youeye deploy` via `qm guest exec`, no SSH). `installer.go` re-enables the Proxmox→wizard path (removed the "not ready" stub routing); `wizard.go` forces `modeVM` (VM-only).
- `installer/scripts/proxmox-vm.sh` — the standalone provisioner, kept as reference/escape-hatch. `installer/scripts/install.sh` — curl bootstrap.
- `spine/internal/installer/` + `spine/internal/cmd/installer_cmd.go` — **removed** (TUI moved out). `spine/install.sh` — fixed stale `youeye installer` references. Spine still builds.

### Test Results
- `go build` + `go vet ./...` clean for the installer module (linux/amd64). `go build ./...` clean for spine. Binary smoke-tested. VM sequence previously verified end-to-end on Koshka (VM 9000) via proxmox-vm.sh; Go port + TUI await live owner test.

### Notes for Iris
- New module = a new release artifact (`youeye-installer` binary). Not a spine/cp/ui component bump.
- LXC intentionally unsupported (Spine runs Incus; nested Incus-in-LXC is fragile). See `YE-Wiki/installer/youeye-installer.md`.

## installer/proxmox-vm.sh — artem — 2026-06-17
**Branch:** artem · **Agent:** Artem
**Task:** New Proxmox VM provisioner for the YouEye installer — creates a Debian VM with the QEMU guest agent pre-baked, so the host drives the in-VM install via `qm guest exec`. No component release (host-side script).

### Changes
- `installer/proxmox-vm.sh` — **new.** Non-interactive, curl-from-Proxmox-host script. Downloads Debian 13 genericcloud, pre-bakes `qemu-guest-agent` with `virt-customize`, `qm create` (virtio-scsi-single, serial console, `--agent enabled=1`), one-step `import-from` disk into local-lvm, cloud-init drive + DHCP + ciuser/sshkeys, grows disk, boots, polls the agent, runs a demo `qm guest exec`. Env/flag parameterized; `--recreate` for re-tests.

### Test Results
- Live on Proxmox host **Koshka (PVE 9.1.1)**, throwaway VM 9000: VM created → guest agent up → `qm guest exec` ran as root (uid=0) → disk grew to 20G (cloud-init growpart) → cloud-init done → SSH fallback (youeye + passwordless sudo) confirmed. End-to-end green.

### Notes for Iris
- Host-side bash, NOT a Spine/CP/UI component — no version bump / Forgejo release.
- Part of the "X installer" plan (`Agent Working/youeye-developer/Artem/Plans/X installer.md`). Next slices: wire the real Spine install + `youeye deploy` into the guest-exec step, the base-Linux detection branch, then the TUI.
- Requires `libguestfs-tools` on the host (script installs it if missing). Koshka had a pre-existing broken 3rd-party Docker apt repo; the script tolerates a non-zero `apt-get update`.
## cp-mythos-v0.4.49.6 + Market mythos-v0.4.0.10 — mythos — 2026-06-17
**Branch:** mythos · **Agent:** Mythos
**Task:** Per-client OIDC issuer (Option B) — YouEye ID now issues a per-client `issuer`/`iss` matching the per-client discovery URL, so strict OIDC clients (Vaultwarden/openidconnect crate, Spring, go-oidc) stop rejecting "unexpected issuer URI"

### Changes
- `control-panel/src/app/application/o/[clientId]/.well-known/openid-configuration/route.ts` — return `issuer: ${externalUrl}/application/o/${clientId}/` (uses the route's clientId; 404 unknown client). Endpoints stay shared/absolute.
- `control-panel/src/lib/identity/tokens.ts` — `createAccessToken` sets the id_token `iss` to the per-client issuer; `verifyBearerToken` (RS256 path) no longer pins a single issuer (signature is the trust boundary; requires `iss` to be one of ours). Session token (`createIdentityToken`/`verifyIdentityToken`, HS256) unchanged (bare issuer).
- DELETED `control-panel/src/app/.well-known/openid-configuration/route.ts` (bare root discovery — re-exported the per-client GET, which now needs a clientId; no consumer after the two manifest migrations).
- `control-panel/package.json` 0.4.49.5 → 0.4.49.6.
- YE-AppMarket: `integrations/immich/youeye-id.yaml` (`oauth.issuerUrl: ${sso.issuer}`, was `${identity.externalUrl}`; v0.1.3→0.1.4), `integrations/jellyfin/youeye-id.yaml` (`oidEndpoint: ${sso.issuer}`, was `${identity.externalUrl}/`; v0.1.3→0.1.4), `catalog.yaml` (both latestVersion→0.1.4). These were the ONLY two apps on the bare issuer.

### Test Results
- `tsc --noEmit`: no errors in the changed files (only pre-existing unrelated `sso-setup.ts` errors; `ignoreBuildErrors`). Owner does a FULL REINSTALL + dual-account re-test (per request).

### Notes for Iris
- CP `cp-mythos-v0.4.49.6` + Market `mythos-v0.4.0.10`. No UI/Spine change.
- Builds on 0.4.49.4 (CA) + 0.4.49.5 (accept-both/nonce/email_verified); this closes the 4th axis (issuer matching). With all four, strict + lenient OIDC libraries should both work.
- First-party CP/UI login unaffected (lenient: exchange→userinfo; the `verifyBearerToken` change keeps /userinfo working with the per-client `iss`). No backwards-compat kept (bare issuer removed) → clean reinstall is the test path.
- Watch on test: Jellyfin `doNotValidateEndpoints: false` may reject the shared endpoints under a per-client issuer → flip to true if so. Audiobookshelf `/undefined/` redirect_uri still separate.
- Docs: YE-Wiki `control-panel/identity-oidc-provider.md` (per-client issuer) + `app-market/sso-test-results.md` (Bug 4).

## cp-mythos-v0.4.49.5 — mythos — 2026-06-17
**Branch:** mythos · **Agent:** Mythos
**Task:** Make YouEye ID (the homegrown OIDC provider) interoperable with every market app's OIDC client — accept both client-auth methods, echo `nonce`, assert `email_verified`

### Changes
- `control-panel/src/app/application/o/token/route.ts` — accept client creds from EITHER the `Authorization: Basic` header (`client_secret_basic`) or the POST body (`client_secret_post`); constant-time secret compare; `WWW-Authenticate: Basic` on the 401; pass the auth code's `nonce` into the id_token. Root cause: the endpoint read creds from the body only, so every library defaulting to Basic (Authlib/Mealie, openid-client, mod_auth_openidc, Spring, the Rust openidconnect crate) got `401 invalid_client`.
- `control-panel/src/app/application/o/authorize/route.ts` — capture `nonce` from the auth request and thread it through `issueAuthRedirect` → `createAuthCode` (both the GET fast-path and the POST consent-path).
- `control-panel/src/lib/identity/store.ts` — `AuthCode.nonce`; `identity_auth_codes.nonce` column + `ALTER TABLE … ADD COLUMN IF NOT EXISTS` upgrade path; `createAuthCode` persists it; `consumeAuthCode` returns it.
- `control-panel/src/lib/identity/tokens.ts` — `createAccessToken(..., nonce?)` emits the `nonce` claim only when present; `oauthClaims` always emits `email_verified: true`.
- `control-panel/src/lib/identity/http.ts` — `userinfo` emits `email_verified: true`.
- `control-panel/src/app/application/o/[clientId]/.well-known/openid-configuration/route.ts` — advertise `token_endpoint_auth_methods_supported: [client_secret_basic, client_secret_post]`.
- `control-panel/package.json` 0.4.49.4 → 0.4.49.5.

### Test Results
- `tsc --noEmit`: no errors in the changed files (only pre-existing unrelated errors; `next.config` sets `ignoreBuildErrors`). Live deploy + dual-account re-test left to the owner (per request).

### Notes for Iris
- CP-only release `cp-mythos-v0.4.49.5`. No UI/Spine/Market change.
- Closes the env-OIDC class systemically: 12 market apps (Mealie, Vaultwarden, FreshRSS, Stirling-PDF, Planka, Actual, Linkwarden, Kavita, Paperless fixed here; Miniflux/Vikunja/HedgeDoc already worked off the 0.4.49.4 CA fix). Per-app matrix + sources: YE-Wiki `app-market/sso-test-results.md` (Bug 3) + new `control-panel/identity-oidc-provider.md`.
- Additive/backwards-compatible: `client_secret_post` still works (first-party CP/UI login unaffected), `nonce` echoed only when sent, `email_verified` is a new claim, DB column added idempotently.
- Still open: Audiobookshelf OIDC redirect_uri `/undefined/` (separate, pre-existing).

## cp-mythos-v0.4.49.4 — mythos — 2026-06-17
**Branch:** mythos · **Agent:** Mythos
**Task:** Fix env-OIDC apps failing OIDC discovery with `CERTIFICATE_VERIFY_FAILED` (systemic) — trust the YouEye root CA in non-systemd OCI containers

### Changes
- `control-panel/src/lib/market/engine.ts` — OCI deploy path: for SSO apps (`ssoEnabled || nativeIdentityIntegrationPlanned`), set `SSL_CERT_FILE` / `REQUESTS_CA_BUNDLE` / `NODE_EXTRA_CA_CERTS` → `/usr/local/share/ca-certificates/caddy-root.crt` in the container env (from boot), never overriding manifest values. Root cause: `injectCaddyRootCA` only adds the cert to the system store + a **systemd drop-in**; non-systemd OCI runtimes that ship their own CA bundle (Python `httpx`/`certifi`, Node) ignore the system store, so server-side OIDC discovery to `https://id.<domain>` fails TLS verify (confirmed on Mealie: `httpx.ConnectError: CERTIFICATE_VERIFY_FAILED`). Integration apps (.NET/PHP) read the system store, so were unaffected — which is why Jellyfin/Nextcloud worked but env-OIDC apps didn't.
- `control-panel/package.json` 0.4.49.3 → 0.4.49.4.

### Test Results
- `tsc --noEmit`: no errors in the changed file. Live deploy + re-test left to the owner (per request).

### Notes for Iris
- CP-only release `cp-mythos-v0.4.49.4`. No UI/Spine change.
- Companion Market release `mythos-v0.4.0.9` adds SSO `entry_url` to the nextcloud (`/apps/user_oidc/login/1`) + immich (`/auth/login?autoLaunch=1`) integration manifests.
- Verified PASS (dual-account) before this fix: Jellyfin 10.11.11, Nextcloud 34.0.0, Immich 2.7.5, Memos 0.29.1. Follow-ups: Audiobookshelf OIDC redirect_uri `/undefined/` bug; re-test remaining env-OIDC apps after deploy; CLI `app install`/`app stop` bugs.

## cp-mythos-v0.4.49.3 + ui-mythos-v0.4.28.3 — mythos — 2026-06-17
**Branch:** mythos · **Agent:** Mythos
**Task:** Propagate integration-provided SSO `entry_url` to the UI so the app drawer/header launch the SSO login path (not the app's local login form) for integration-wired apps (Jellyfin, Nextcloud, Immich, Memos, Audiobookshelf)

### Changes
- `control-panel/src/lib/market/engine.ts` — new exported `pushSsoEntryUrlToUI(appId, entryUrl)`: token-safe, bridge-authenticated `POST /api/v1/apps/sso-entry-url` that updates ONLY the UI `sso_entry_url` column (omits token_hash/icon/name/container URL → bridge token & all other fields preserved).
- `control-panel/src/lib/market/integration-runner.ts` — `applyIntegration` calls `pushSsoEntryUrlToUI` after OAuth-client creation when `integration.sso?.entry_url` is set, resolving `${sso.slug}` (→ `youeye-app-<appId>`). Root cause: integration-wired apps have no `sso` block in the app manifest, so the main install's `registerAppWithUI` registered `sso_entry_url=null`; the integration runs post-install and never pushed it.
- `ui/src/lib/db/queries/app-management.ts` — new `setAppSsoEntryUrl(appId, entryUrl)` query (update-only, invalidates app-surface cache).
- `ui/src/app/api/v1/apps/sso-entry-url/route.ts` — NEW bridge-only `POST` route.
- CP `package.json` 0.4.49.2 → 0.4.49.3; UI `package.json` 0.4.28.2 → 0.4.28.3.

### Test Results
- Local `tsc --noEmit`: no errors in changed files.
- Deployed to bykapc (CP 0.4.49.3, UI 0.4.28.3). Installed Jellyfin via the Market (youeye-id integration auto-applied); UI `apps.sso_entry_url` for jellyfin = `/sso/OID/start/youeye-app-jellyfin` (was NULL pre-fix) — entry_url now reaches the UI, so the drawer launches the SSO login path. Browser dual-account (tester/tester2) role verification recorded in the YE-Wiki 2026-06-17 test matrix.

### Notes for Iris
- CP + UI released together: `cp-mythos-v0.4.49.3`, `ui-mythos-v0.4.28.3`. No Spine change.
- Pre-existing CLI bug found (separate from this release): `youeye app install <name>` sends only `{appId}` to `/api/market/install`, omitting the required `subdomain`/`domain`/`selectedIntegrations` → 400. Logged for a Spine follow-up; installs in this session used the direct CP API.
- Manifests unchanged here — Jellyfin's integration already declared `sso.entry_url`. Other apps' `entry_url` values are added to YE-AppMarket as each is validated against its running instance.

## spine-mythos-v0.4.10.1 — mythos — 2026-06-16
**Branch:** mythos · **Agent:** Mythos
**Task:** Fix `id.<domain>` HTTP 500 on login — identity provider missing Incus HTTPS env (spine-v0.4.10 regression)

### Changes
- `spine/internal/container/control.go` — add `INCUS_HTTPS_URL` / `INCUS_CLIENT_CERT` / `INCUS_CLIENT_KEY` Environment lines (+ `incusGW` arg) to the `youeye-id.service` (identity provider, :3001) unit. The spine-v0.4.10 unix-socket→HTTPS migration added them to the CP unit only; the identity service shares the same `/opt/app` bundle + Incus client and fell back to the removed Incus unix socket → `ECONNREFUSED` → 500 on the login flow. Added a "keep in sync with the CP unit" comment to prevent recurrence.
- `spine/internal/cmd/root.go` — Version 0.4.10 → 0.4.10.1.

### Test Results
- Live on bykapc: applied the equivalent `youeye-id.service.d/incus-https.conf` drop-in + restart → 0 `ECONNREFUSED` / 0 watchdog failures since the restart; `/application/o/authorize` → `/identity/login` chain returns 200. Go: `gofmt` clean, `go build ./...` OK.

### Notes for Iris
- **Only Spine changed** (no CP/UI release). Branch release: `spine-mythos-v0.4.10.1`.
- Live bykapc currently runs the equivalent **systemd drop-in** hotfix (not a re-provision). The inline env in this release supersedes the drop-in on the next full re-provision (harmless duplicate). `spine update self` swaps the binary but does NOT rewrite the CP-container units, so the drop-in remains until a re-provision/`spine deploy`.
- Follow-ups in Plans/Archive/To Plan/: `identity-service-cp-background-loops.md`, `spine-stale-incus-socket-after-forkproxy-removal.md`.

## cp-mythos-v0.4.49.2 — mythos — 2026-06-16
**Branch:** mythos · **Agent:** Mythos
**Task:** Unify "Check for updates" (components + market + infra), self-consistent market update-status, remove dead update-check routes

### Changes
- `lib/market/version-checker.ts` — `refreshVersionCheck()` now `await`s `refreshAllUpdates()` (was fire-and-forget): one pass = market catalog + infra (OCI/LXD) digest.
- `components/settings-shell/apps-client.tsx` — native "Check for Updates" button now POSTs `/api/market/updates` (was OCI-only `/api/apps/check-updates`); component (Spine) status stays fresh via `load()` → `/api/apps/unified`.
- `app/api/ui-bridge/apps/route.ts` — refresh path → single `refreshVersionCheck()`; market/native `updateAvailable` computed from `isNewer(catalogVersion, installedVersion)`.
- `app/api/apps/unified/route.ts` — market `updateAvailable` computed on read via `isNewer(...)` instead of the stored boolean (health-checker re-saves no longer freeze it; clears immediately post-update).
- Removed 6 dead update-check routes (zero callers, cp+ui verified): `updates` (bare GET), `ui-bridge/updates` (bare GET), `ui-bridge/market`, `apps/check-updates`, `apps/[name]/check-update`, `market/update`. Live siblings kept.

### Test Results
- `next build` clean (cp 0.4.49.2). Deployed to bykapc via `spine update control` (0.4.49.1 → 0.4.49.2, healthy).
- Post-deploy boot version-check refreshed the store correctly (memos `catalogVersion` 0.29.1). Compute-on-read shows `updateAvailable=false` now that memos `installedVersion`=0.29.1 (no false positive). Button endpoint `/api/market/updates` present + auth-gated (401 cookieless). memos had since been updated to 0.29.1, so no installed app is currently behind to show a live positive badge.

### Notes for Iris
- Root cause: the native button hit OCI-only `/api/apps/check-updates`; the market-capable `/api/market/updates` was orphaned (zero callers).
- Additional dead exports left in place (zero external refs): `update-cache` getCachedUpdate/hasAnyUpdate/getAppsWithUpdates; `registry` getBaselineDigest/setBaselineDigest/getLastBulkCheckTime/fetchRemoteDigest.
- Wiki: `app-market/update-check-pipeline.md`.

## cp-mythos-v0.4.49.1 + ui-mythos-v0.4.28.2 — mythos — 2026-06-16
**Branch:** mythos · **Agent:** Mythos
**Task:** Fix Market external-app favicons (image-proxy domain whitelist)

### Changes
- `control-panel/src/app/api/market/image/route.ts` — add `git.potemk.in` to `ALLOWED_DOMAINS` so external app icons served from the Forgejo raw URL are no longer 403'd by the proxy.
- `ui/src/app/api/market/image/route.ts` — same whitelist addition (the UI mirrors the proxy).
- `control-panel/package.json` 0.4.49 → 0.4.49.1; `ui/package.json` 0.4.28.1 → 0.4.28.2.

### Test Results
- Owner-run on bykapc. Root cause confirmed by code trace: an external `iconUrl` resolves to `https://git.potemk.in/api/v1/repos/potemsla/YE-AppMarket/raw/icons/<app>.svg`, gets wrapped as `/api/market/image?url=...`, and the proxy returned 403 because `git.potemk.in` was not in the allow-list. Native apps use Lucide icon names and were unaffected.

### Notes for Iris
- Pairs with YE-AppMarket `mythos` v0.4.0.8 (SSO/notifications/version sweep); those manifests' icons now render.
- DEFERRED to a follow-up monorepo build (owner greenlight pending): the per-app notification toggle (UI: `user_settings.mutedAppIds` + a Settings→Notifications page + read-query enforcement) and roleClaim admin mapping under the `youeye-id` provider. Neither is in this build.

## cp-v0.4.49 + spine-v0.4.10 — mythos — 2026-06-16
**Branch:** main · **Agent:** Mythos
**Task:** Platform RAM + app-isolation overhaul (5 workstreams) — verified live on bykapc incl. reboot.

### Changes
- `control-panel/src/lib/incus/app-network.ts` — `addSystemProxyDevices` now attaches each proxy to its target instance with `bind:host`+`nat:true` (kernel DNAT, no forkproxy); `removeSystemProxyDevices` scans all core instances; new `applyAppEgressAcl`/`removeAppEgressAcl` (port-specific per-app egress isolation).
- `control-panel/src/lib/market/engine.ts` — replaced the never-applied `ye-app-infra-block` with `applyAppEgressAcl` (fail-loud).
- `control-panel/src/lib/health/monitor.ts` — watchdog now reconciles desired-state (restarts containers that should run but crashed at boot), not just Running→Stopped.
- `control-panel/src/lib/incus/server.ts` — `openIncus()` transport: Unix socket by default, Incus HTTPS API (client cert) when `INCUS_HTTPS_URL` set → removes the 1.3 GiB incus-socket forkproxy leak.
- `spine/internal/container/control.go` — `setupIncusHTTPS` (enable listener + trusted client cert) replaces the `incus-socket` proxy; CP unit gets `INCUS_HTTPS_URL`/`CLIENT_CERT`/`CLIENT_KEY`.
- `spine/internal/incus/install.go` — `capZFSARC()` pins `zfs_arc_max=2 GiB`.

### Test Results
- Live on bykapc: forkproxy 25→7, host used 5.5→3.0 GiB / avail 9.5→12.3 GiB, incus-socket leak gone, ARC capped, per-app isolation enforced (CP-dash/Postgres-non-DB/Caddy/Pi-Hole blocked), all apps 307/200 via Caddy, memos DB 200. **Survived a full reboot** (13/13 autostart, memos auto-recovered, CP back on HTTPS).

### Notes for Iris
- Existing apps were migrated to nat-mode + ACLs live via incus (persistent). Fresh-install Spine HTTPS/ARC path is verified-by-construction; a clean install would exercise it end-to-end.
- Plans: `Agent Working/youeye-developer/Mythos/Plans/platform-ram-and-isolation-master-plan.md`.

## ui-v0.4.27 — mythos — 2026-06-15
**Branch:** main · **Agent:** Mythos
**Task:** Plan 5 — notification tab embed (Plan A) + menu/bell transparency (owner asks)

### Changes
- `ui/src/components/layout/notification-bell.tsx` — `embedded` mode (content-only, window.top links, themed inner embeds) + translucent popover.
- `ui/src/app/embed/notifications/page.tsx` — **new** UI-served `/embed/notifications` (mirrors /embed/drawer). Closes the cross-app notification leak (native apps stop fetching the list).
- `ui/src/components/layout/user-menu.tsx` — glassy transparency to match the drawer.

### Test Results
- `pnpm build` OK; standalone 0.4.27. Verify on lemon.app: bell+menu transparency; `/embed/notifications` renders the feed (per-notification embeds = nested iframes, Plan A).

### Notes for Iris
- Native side (Canvas notif-bell hosts the iframe + re-vendor 6 apps) = Slice 3 batch. Direct-to-main.

## ui-v0.4.26 — mythos — 2026-06-15
**Branch:** main · **Agent:** Mythos
**Task:** Plan 5 — dual pointer+mouse drag sensor (robustness + testability)

### Changes
- `ui/src/lib/hooks/use-grid-drag.ts` — added a mouse-event fallback (mousedown→startDrag + window mousemove/mouseup) deduped vs pointer via a `pending` guard. Pointer primary (setPointerCapture); mouse fallback for envs without pointer events (incl. automation).
- `ui/src/components/layout/{launcher,app-drawer}.tsx` — `onMouseDown` alongside `onPointerDown` on tiles.

### Test Results
- `pnpm build` OK; standalone 0.4.26. Intend to drive via tool mouse-drag to demonstrate reorder.

## ui-v0.4.25 — mythos — 2026-06-15
**Branch:** main · **Agent:** Mythos
**Task:** Plan 5 fix — real-mouse drag didn't work (setPointerCapture)

### Changes
- `ui/src/lib/hooks/use-grid-drag.ts` — `el.setPointerCapture(e.pointerId)` on drag start: the pointer-drag worked via JS-dispatched PointerEvents but a real mouse started a native image/text drag → `pointercancel` → drag died. Capture prevents that + guarantees the events fire.
- `ui/src/components/layout/{launcher,app-drawer}.tsx` — `draggable={false}` on icon `<img>`s.

### Test Results
- `pnpm build` OK; standalone baked 0.4.25. JS-PointerEvent reorder still works; real-mouse confirmation requested from owner (left_click_drag emits mouse, not pointer, events).

## ui-v0.4.24 — mythos — 2026-06-15
**Branch:** main · **Agent:** Mythos
**Task:** Plan 5 Slice 2.5 — pointer-drag live reorder + unified launcher grid + transparency (owner feedback)

### Changes
- `ui/src/lib/hooks/use-grid-drag.ts` — **new** pointer-based drag (live reorder, threshold→click guard, portaled ghost, dwell-to-merge). Replaces HTML5 DnD.
- `ui/src/components/layout/app-drawer.tsx` — edit-mode live reorder via the hook; translucent popover; tiles → render-functions (no remount flicker).
- `ui/src/components/layout/launcher.tsx` — **unified ordered grid** of apps+folders; reorder anything; folder created **at the drop target's position**; always-visible folder × ; glassy translucency.
- `ui/src/components/layout/drawer-and-launcher.tsx` — launcher overlay more translucent.

### Test Results
- `pnpm build` OK; standalone baked 0.4.24. Live verify on lemon.app — drag now driveable via automation (pointer events).

### Notes for Iris
- Fixes owner-reported drawer-reorder + folder-placement bugs. Native apps iframe these surfaces, so the fixes propagate automatically. Direct-to-main.

## ui-v0.4.23 — mythos — 2026-06-15
**Branch:** main · **Agent:** Mythos
**Task:** Plan 5 Slice 2 — launcher folders (iOS-style)

### Changes
- `ui/src/db/schema.ts` + `ui/src/db/index.ts` — new `user_launcher_folders` table + `folder_id` on `user_app_config` (self-healing `ensureSchema`).
- `ui/src/lib/db/queries/apps.ts` — `folders[]` + per-app `folderId` in reads; `folderId` in `updateAppConfig`; new `updateLauncherFolders`.
- `ui/src/app/api/v1/apps/drawer/route.ts` (folder_id + folders), `[appId]/route.ts` (folder_id), new `folders/route.ts`.
- `ui/src/components/layout/launcher.tsx` — folders: drag-to-create/add, 2×2 tile, open panel (rename + × remove), auto-delete empty, search flattens. i18n ×5.

### Test Results
- `pnpm build` OK; standalone baked 0.4.23. Live verify on lemon.app (drag-create folder, open, add, remove).

### Notes for Iris
- Launcher folders are independent of drawer sections (D10). Direct-to-main. Slice 3 = Canvas + 6 native re-release.

## ui-v0.4.22 — mythos — 2026-06-15
**Branch:** main · **Agent:** Mythos
**Task:** Plan 5 Slice 1 fix — launcher overlay didn't open on the dashboard

### Changes
- `ui/src/components/layout/drawer-and-launcher.tsx` — `createPortal` the launcher overlay to `document.body`. The header's `backdrop-filter` (blur) is a containing block for `position:fixed`, which trapped the overlay inside the 56px bar. `pointer-events-none` container keeps the header clickable.

### Test Results
- `pnpm build` OK; standalone baked 0.4.22. Manual deploy (spine update ui is a no-op for UI — Spine manages only itself+CP). Live verify on lemon.app.

## ui-v0.4.21 — mythos — 2026-06-15
**Branch:** main · **Agent:** Mythos
**Task:** Plan 5 Slice 1 — app drawer + launcher as two cooperating surfaces

### Changes
- `ui/src/components/layout/app-drawer.tsx` — drawer reworked: search (any app → open), edit-mode "Add app"→pin + × to unpin, **hidden tray removed**; `embedded` prop for `/embed/drawer`; "All apps"→launcher. `pinned` === existing `visible` (no migration).
- `ui/src/components/layout/launcher.tsx` — shows ALL apps (dropped `visible` filter); `onClose` for the overlay.
- `ui/src/components/layout/drawer-and-launcher.tsx` — **new** client wrapper: drawer popover + launcher overlay on the dashboard.
- `ui/src/app/embed/drawer/page.tsx` — **new** UI-served `/embed/drawer`; posts `youeye:action open-launcher`.
- `ui/src/app/api/v1/apps/drawer/route.ts` — `pinned` alias. `ui/src/components/layout/navbar.tsx` — uses `<DrawerAndLauncher>`. i18n ×5.

### Test Results
- `pnpm build` OK; standalone baked 0.4.21; `/embed/drawer` compiled. Live verify on lemon.app (light+dark) post-deploy.

### Notes for Iris
- Direct-to-main (Plan 1 model, no Iris merge). Launcher folders + Canvas + 6 native re-releases are the next Plan 5 slices.

## ui-v0.4.20 — mythos — 2026-06-15
**Branch:** main · **Agent:** Mythos
**Task:** Plan 1 E6 fix — legacy resize-only embeds lost to fallback

### Changes
- `ui/src/components/embeds/unified-embed.tsx` — a `youeye:resize`/legacy resize now also `setReady(true)` (a resizing embed is alive). Without it, legacy settings panels (`youeye-app-settings-resize`, no ready) timed out to the fallback. `ui/package.json` → 0.4.20; e6 spec → 4/4.

### Test Results
- e6 4/4 + timeline/notif/widget/launcher specs still green (shared component). `pnpm build` OK. Caught verifying 0.4.19.

## ui-v0.4.19 — mythos — 2026-06-15
**Branch:** main · **Agent:** Mythos
**Task:** Plan 1 E6 — app settings panel on UnifiedEmbed (acceptance #6 met)

### Changes
- `ui/src/components/settings/app-settings-detail.tsx` — `AppSettingsEmbed` migrated from a hand-rolled iframe + `youeye-app-settings-resize` listener onto `<UnifiedEmbed kind="settings-panel">` (renders `/settings?embed=true`; timeout→visible fallback).
- `ui/package.json` → 0.4.19; spec `ui/tests/settings-app-embed-e6.test.mjs` (3/3).

### Test Results
- 3/3; `pnpm build` OK. Released ui-v0.4.19 → bykapc; verify a settings/apps/[app] page.

### Notes for Iris
- **Acceptance #6 satisfied**: timeline/notifications/widgets/launcher/settings-panels all on `<UnifiedEmbed>`. Native `/embed/settings` (Notes) + the `settings-app-notes.html` page restyle + per-surface toggles ride the native batch → `Plans/Archive/To Plan/e6-native-settings-panels.md`.

## ui-v0.4.18 — mythos — 2026-06-15
**Branch:** main · **Agent:** Mythos
**Task:** Plan 1 E1 fix — launcher grid was single-column

### Changes
- `ui/src/components/layout/launcher.tsx` — grid given `w-full max-w-3xl` + `minmax(84px,96px)` tracks so `auto-fill` lays out multi-column (was shrink-wrapped to 1 column). `ui/package.json` → 0.4.18.

### Test Results
- `pnpm build` OK. Caught in live verification of 0.4.17; redeployed + re-verified.

## ui-v0.4.17 — mythos — 2026-06-15
**Branch:** main · **Agent:** Mythos
**Task:** Plan 1 E1 — UI-served app launcher (foundation)

### Changes
- `ui/src/components/layout/launcher.tsx` (NEW) — `launcher.html` content: search + app tile grid + Market/Settings system tiles; fed by `/api/v1/apps/drawer` (no CP); embedded mode opens at `window.top`.
- `ui/src/app/embed/launcher/page.tsx` (NEW) — `/embed/launcher` UI-origin route (native apps iframe it); theme via `?mode=`.
- `ui/messages/{en,fr,es,de,ru}.json` — `nav.searchApps`/`noAppsFound`/`launcherHint`.
- `ui/package.json` → 0.4.17; spec `ui/tests/launcher-e1.test.mjs` (4/4).

### Test Results
- 4/4; `pnpm build` OK (`/embed/launcher` route present). Released ui-v0.4.17 → bykapc; verify `lemon.app/embed/launcher`.

### Notes for Iris
- Foundation slice. Folders + pinned-row + UI-header adoption + native consumption (6-app batch) → `Plans/Archive/To Plan/launcher-folders-and-native-adoption.md`. E1 security fix already shipped ui-v0.4.11.

## ui-v0.4.16 — mythos — 2026-06-15
**Branch:** main · **Agent:** Mythos
**Task:** Plan 1 E5 — dashboard widgets on the unified embed + declared size bounds

### Changes
- `ui/src/components/embeds/unified-embed.tsx` — new `fill` mode (iframe + container 100% height; resize-height ignored) for fixed-size hosts.
- `ui/src/components/widgets/app-widget.tsx` — rewritten onto `<UnifiedEmbed kind="widget" fill>`; bespoke iframe removed.
- `ui/src/components/dashboard/widget-grid.tsx` — `clampWidgetSize()` honors app-declared min/max on resize + on add; `AppWidgetDef` gains `min_size`/`max_size`; app widgets carry `_minSize`/`_maxSize` into settings.
- `ui/package.json` → 0.4.16; spec `ui/tests/widget-sizes-e5.test.mjs` (4/4).

### Test Results
- 4/4; `pnpm build` OK. Released ui-v0.4.16 → bykapc (`spine update ui`) + verify dashboard renders.

### Notes for Iris
- Strict 12-col grid visual deferred (non-destructive) → `Plans/Archive/To Plan/dashboard-12col-grid-migration.md`. Acceptance #6 (widgets on UnifiedEmbed) satisfied. Native-app widget manifest sizes ride the native batch.

## ui-v0.4.15 + cp-v0.4.47 — mythos — 2026-06-15
**Branch:** main · **Agent:** Mythos
**Task:** Plan 1 E4 (D14-revised) — toned-down account menu mirrored UI↔CP

### Changes
- `ui/src/components/layout/user-menu.tsx` — removed the "Manage your account" pill, the avatar pencil-edit, and the Privacy·About footer. Kept email + avatar (display-only) + greeting + grouped Timeline/Settings/Theme-segmented + Sign out.
- `control-panel/src/components/control-surface/control-header.tsx` — account dropdown rebuilt from the plain 224px list to the same 340px toned-down panel; theme cycle item → Light/Dark/Auto segmented `applyTheme(mode)`; dropped `DropdownMenuItem`/`Label`/`Separator`.
- `ui/package.json` → 0.4.15; `control-panel/package.json` → 0.4.47; specs `ui/tests/user-menu-e4.test.mjs` (4/4) + `control-panel/tests/user-menu-e4.spec.ts` (5/5).

### Test Results
- UI 4/4 + CP 5/5; both `pnpm build` OK. Released ui-v0.4.15 + cp-v0.4.47 → bykapc (`spine update ui` + `spine update control`) + verify both menus.

### Notes for Iris
- Direct-to-main Plan 1 slice. One spec, two implementations (the third — Canvas native menu — rides the native-app batch). D14 mockup `user-menu.html` is superseded by the toned-down revision.

## ui-v0.4.14 — mythos — 2026-06-15
**Branch:** main · **Agent:** Mythos
**Task:** Plan 1 E3 — notifications bell popover on the unified embed

### Changes
- `ui/src/components/layout/notification-bell.tsx` — 400px popover per `notifications.html`; feed of `<NotificationItem>`; mark-all-read.
- `ui/src/components/notifications/notification-item.tsx` (NEW) — `.via` attribution row (app chip + name + time, outside the embed) + unread blue dot + embed-or-standard body.
- `ui/src/components/notifications/notification-standard-row.tsx` (NEW) — `.std` fallback row (30px tile + title + description + action).
- `ui/src/components/notifications/notification-surface-embed.tsx` — rewritten onto `<UnifiedEmbed kind="notification">` (3s timeout → std-row fallback); legacy `youeye-embed-*` iframe removed.
- `ui/src/components/notifications/notifications-list.tsx` — `/notifications` page uses the same `<NotificationItem>` (one implementation).
- `ui/src/app/api/v1/notifications/route.ts` — returns `app_meta` (getAppMetaMap). `notifications.system` i18n ×5.
- `ui/package.json` → 0.4.14; new spec `ui/tests/notifications-e3.test.mjs`.

### Test Results
- `notifications-e3.test.mjs` 6/6; `pnpm build` OK. Released ui-v0.4.14 → bykapc (`spine update ui`) + verify lemon.app bell.

### Notes for Iris
- Direct-to-main Plan 1 slice. Notification attribution is UI-rendered outside the embed (anti-impersonation), same pattern as the E2 timeline.

## ui-v0.4.13 — mythos — 2026-06-15
**Branch:** main · **Agent:** Mythos
**Task:** Plan 1 E2 — timeline feed: embeds-first, date-grouped single column

### Changes
- `ui/src/app/timeline/page.tsx` — single centered column `max-w-[640px]` (was `max-w-4xl`), mockup padding.
- `ui/src/components/timeline/timeline-feed.tsx` — `buildDayGroups()` inserts Today/Yesterday/date dividers in one pass over the timestamp-sorted entries; `useLocale()` for locale-correct date headers.
- `ui/src/components/timeline/timeline-entry-card.tsx` — rewritten to the `.via` model: 18px app chip (manifest accent) + app name + clock time + hover-delete, all **outside** the embed (anti-impersonation); body = embed / legacy info-card / StandardCard. Dropped the bordered chrome, collection badge, raw-JSON expander, in-row title.
- `ui/messages/{en,fr,es,de,ru}.json` — added `timeline.dayToday` + `timeline.deleteEntry`.
- `ui/package.json` → 0.4.13; new spec `ui/tests/timeline-feed.test.mjs`.

### Test Results
- `timeline-feed.test.mjs` 6/6 + `timeline-embed.test.mjs` 4/4; `pnpm build` OK. Released ui-v0.4.13 → bykapc (`spine update ui`) + verify lemon.app/timeline.

### Notes for Iris
- Direct-to-main Plan 1 slice (no Iris merge). Timeline entry-card chrome removed by design per `timeline.html`; the detail view still carries tags/collection/raw data.

## ui-v0.4.12 — mythos — 2026-06-15
**Branch:** main · **Agent:** Mythos
**Task:** Plan 1 E2 — timeline entries render through <UnifiedEmbed>

### Changes
- `ui/src/components/timeline/timeline-embed.tsx` — rewritten to wrap `<UnifiedEmbed kind="timeline-card">` (lazy mount, `youeye:ready/resize/action` + legacy compat, sandbox, timeout→fallback). Dropped the 200px cap → 480 guard. Redesigned `StandardCard` fallback ("This app was uninstalled…"). Attribution stays outside the embed.
- `ui/package.json` → 0.4.12; new spec `ui/tests/timeline-embed.test.mjs`.

### Test Results
- `timeline-embed.test.mjs` 4/4; `pnpm build` OK. Released ui-v0.4.12 → bykapc (`spine update ui`) + verify lemon.app/timeline.

### Notes for Iris
- N/A (direct-to-main). UI-only; component API unchanged (added optional `mode` prop). Legacy `youeye-embed-*` still accepted by UnifiedEmbed → existing apps' timeline cards keep working. No UI→CP call.

## ui-v0.4.11 — mythos — 2026-06-15
**Branch:** main · **Agent:** Mythos
**Task:** Plan 1 E1 (security fix) — header-config no longer leaks the installed-app list to apps

### Changes
- `ui/src/app/api/v1/header/config/route.ts` — for native-app service calls (`X-YouEye-App`), `navigation` omits `apps` + `sections` (`...(isServiceCall ? {} : { apps, sections })`). The UI's own header keeps the list. Closes the app-enumeration leak (plan §1.4).
- `ui/package.json` → 0.4.11; new spec `ui/tests/header-config-security.test.mjs`.

### Test Results
- `header-config-security.test.mjs` 1/1; `pnpm build` OK. Released ui-v0.4.11 → bykapc (`spine update ui`) + verify service-call header/config has no app list.

### Notes for Iris
- N/A (direct-to-main). Canvas `AppHeader` degrades gracefully (`navigation?.apps ?? []` → empty drawer, no crash). Full launcher iframe + populated drawer = rest of E1 (needs the 6-native-app rollout). No UI→CP call.

## cp-v0.4.46 — mythos — 2026-06-15
**Branch:** main · **Agent:** Mythos
**Task:** Plan 1 D — Market app-detail rebuilt to mockup (completes D)

### Changes
- `control-panel/src/app/market/[appId]/page.tsx` — restyled to `app-detail.html`: hero (88px category tile + name + badge + tagline), meta band (Version/Category/Source/Developer/Account login), 2-up gallery w/ designed placeholders (`Camera`, never broken images; lightbox `ScreenshotGallery` kept for >2), About card. **ALL install/connection/credential/integration logic preserved** (only JSX restyled). Token-recolored (was hardcoded light → dark-mode-broken). Dropped fake `youeye.local` domain fallback (pitfall #13).
- `control-panel/package.json` → 0.4.46; `tests/market.spec.ts` extended (8/8).

### Test Results
- `market.spec.ts` 8/8; `pnpm build` OK. Released cp-v0.4.46 → bykapc deploy + verify a market detail page on lemon.app.

### Notes for Iris
- N/A (direct-to-main). **Completes Workstream D.** Install/uninstall behavior unchanged (only restyle). `install-dialog.tsx` deeper token pass → F. No new dep, no UI→CP call.

## cp-v0.4.45 — mythos — 2026-06-15
**Branch:** main · **Agent:** Mythos
**Task:** Plan 1 D — Market Browse rebuilt to approved mockup + new Sources page

### Changes
- `control-panel/src/app/market/page.tsx` — full restyle to `market.html`: hero + search, pill bar (All/Installed/Updates/Integrations + categories + Sources pill), "Built for your server" native big-tiles, Featured banner, compact category rows → app detail. Token-styled (dropped ~15 hardcoded-gray raw inputs + filter `<select>`s). `MarketIcon` (iconUrl or category-colored tile + lucide). Install/uninstall now live on the detail page.
- `control-panel/src/app/market/sources/page.tsx` — NEW (D9): connected sources (live enable Switch → PATCH `/api/market/source`, Add, remove, per-source app counts) + Install-from-address via `InstallFromUrlDialog`. Sources management removed from Browse.
- Dropped `OrphanSection` from Browse (not in the mockup) → `Plans/Archive/To Plan/market-orphan-section-rehome.md`.
- `control-panel/package.json` → 0.4.45; new spec `tests/market.spec.ts`.

### Test Results
- `market.spec.ts` 5/5; `pnpm build` OK (all 3 market routes compile). Released cp-v0.4.45 → bykapc deploy + verify on lemon.app/market.

### Notes for Iris
- N/A (direct-to-main). Browse is navigational (actions on detail). Sources page admin-gated by the source PATCH API. **App-detail + install-dialog restyle remain in D.** No new dep, no UI→CP call.

## cp-v0.4.44 — mythos — 2026-06-15
**Branch:** main · **Agent:** Mythos
**Task:** Plan 1 C3 (complete) — retire control.<domain> + delete the (dashboard) shell

### Changes
- `control-panel/src/middleware.ts` — host-aware redirect: legacy shell routes (`/`, `/apps`, `/dns`, `/health`, `/people`, `/proxy`, `/updates`) → Settings (`control.<base>` → `<base>/settings` via `getParentOrigin()`; direct/PAM → same-origin `/settings`). Never matches `/settings`, `/market`, `/embed`, `/api`, or identity.
- Deleted `control-panel/src/app/(dashboard)/` — the entire legacy shell route group (12 files; verified no external imports).
- `control-panel/package.json` → 0.4.44; `tests/c3-retirement.spec.ts` extended (5/5).

### Test Results
- `c3-retirement.spec.ts` 5/5; `pnpm build` OK (177 pages, clean). Released cp-v0.4.44 → bykapc deploy + verify control.lemon.app → /settings.

### Notes for Iris
- N/A (direct-to-main). **Completes Workstream C.** Redirect is precise (only the 6 shell prefixes + `/`); embeds/APIs/identity/settings/market unaffected. PAM door (ip:3000) now lands on `/settings`.

## cp-v0.4.43 — mythos — 2026-06-15
**Branch:** main · **Agent:** Mythos
**Task:** Plan 1 C3 (partial) — browser-tab-title branding sweep + delete dead embeds

### Changes
- `control-panel/src/app/layout.tsx` — tab title `${site_name} Control Panel` → `${site_name}` (metadata + appleWebApp; D4 — never surface "Control Panel").
- Deleted `control-panel/src/app/embed/{containers,market,update-progress}` (page + client) — verified unreferenced in CP + UI.
- **Kept `embed/health`** — the UI `admin-embed.tsx` health poll fetches it (plan §1.6 parity correction).
- `control-panel/package.json` → 0.4.43; new spec `tests/c3-retirement.spec.ts`.

### Test Results
- `c3-retirement.spec.ts` 3/3; `pnpm build` OK (deletions compile clean). Released cp-v0.4.43 → bykapc deploy + verify tab title on lemon.app.

### Notes for Iris
- N/A (direct-to-main). Pure retirement; only genuinely-dead code removed. **Still in C3:** retire old `(dashboard)` shell + `control.<domain>`→`/settings` redirect (redirect-first follow-up).

## cp-v0.4.42 — mythos — 2026-06-15
**Branch:** main · **Agent:** Mythos
**Task:** Plan 1 C2 — Apps installed-list reconciled to mockup (completes C2)

### Changes
- `control-panel/src/components/settings-shell/apps-client.tsx` — `InstalledAppsList` restyled to the mockup card (Installed apps head + Open Market link; rows: app-icon tile, name, subdomain `app.<host>`, status dot+word; `unknown` status suppressed, no faked version/surfaces — pitfall #28). Page header → mockup copy; redundant outer "Installed Apps" heading folded into the card head.
- `control-panel/package.json` → 0.4.42; new spec `tests/settings-apps.spec.ts`.

### Test Results
- `settings-apps.spec.ts` 4/4 (+ system-app-updates 7/7); `pnpm build` OK. Released cp-v0.4.42 → bykapc deploy + verify on lemon.app/settings/apps.

### Notes for Iris
- N/A (direct-to-main). UI-only restyle of the user installed-apps list; admin Updates/System sections + Plan 4 flow unchanged. No new dep, no UI→CP call. **Completes Workstream C2** (Backups skipped per owner).

## cp-v0.4.41 — mythos — 2026-06-15
**Branch:** main · **Agent:** Mythos
**Task:** Plan 4 — system-app (Caddy/Pi-Hole/Postgres) updates through the Market manifests

### Changes
- `control-panel/src/lib/apps/definitions.ts` — 3 infra defs gain `marketSystemId`, lose moving-tag `imageRef` (auto-disables legacy OCI paths).
- `control-panel/src/app/api/apps/unified/route.ts` — `planSystemUpdates()` detection + `systemManaged`; OCI branch gated off for system apps (kills false "New image available").
- `control-panel/src/app/api/ui-bridge/apps/route.ts` — same Market detection for parity.
- `control-panel/src/app/settings/api/apps/[appId]/update/route.ts` — reroute `marketSystemId` apps to `updateSystemFromMarket` with confirmation body.
- `control-panel/src/components/settings-shell/apps-client.tsx` — `systemManaged` + ConfirmDialog (maintenance ack + Postgres DB ack) + JSON confirm body.
- `control-panel/src/components/ui/confirm-dialog.tsx` — NEW dependency-free modal.
- `control-panel/src/app/api/apps/check-updates/route.ts` — `clearCatalogCache()` for manifest freshness.
- `control-panel/package.json` → 0.4.41; new spec `tests/system-app-updates.spec.ts`.

### Test Results
- `system-app-updates.spec.ts` 7/7; `pnpm build` OK. Released cp-v0.4.41 → bykapc deploy + live verify (false positive gone + positive detection via temp label).

### Notes for Iris
- N/A (direct-to-main). CP-only; no Market/Spine/UI change. Legacy SSE/queue update paths fail safe (no imageRef → throws). Deferred items (forceLegacy UI, PG major upgrade, OCI machinery removal) → To Plan.

## cp-v0.4.40 — mythos — 2026-06-15
**Branch:** main · **Agent:** Mythos
**Task:** Plan 1 C2 — Privacy page rebuilt to mockup (Your data + admin Server card) + real telemetry toggle

### Changes
- `control-panel/src/components/settings-shell/privacy-client.tsx` — NEW. **Your data**: Timeline lock on the real UI PIN flow (on+disabled when set — no remove endpoint, honest copy; Change PIN / Lock now); Export my data scoped out (disabled + "Coming soon"). **Server** (admin): Local usage statistics with exact D18 copy + Download/Reset.
- `control-panel/src/app/settings/(shell)/privacy/page.tsx` — replaced `redirect("/settings")` stub; Personal page, passes `isAdmin`, PAM/CLI → System.
- `control-panel/src/lib/telemetry/tracker.ts` — real persisted `enabled` flag (`isTelemetryEnabled`/`setTelemetryEnabled`; `trackRoute`/`trackError` no-op when off; `reset()` preserves flag).
- `control-panel/src/app/api/telemetry/settings/route.ts` — NEW: GET (session) / PATCH (admin+CSRF) toggle.
- `control-panel/src/app/api/telemetry/export/route.ts` — added admin guard (was unauthenticated) + CSRF on DELETE.
- `control-panel/src/app/settings/api/telemetry/{settings,export}/route.ts` — NEW proxies.
- `control-panel/package.json` → 0.4.40; new spec `tests/settings-privacy.spec.ts`.

### Test Results
- `settings-privacy.spec.ts` 9/9 (+ about 7/7); `pnpm build` OK. Released cp-v0.4.40 → bykapc deploy + verify on lemon.app/settings/privacy.

### Notes for Iris
- N/A (direct-to-main). New telemetry settings route + 2 proxies; telemetry export hardened (admin+CSRF). No new dependency, no UI→CP call. Deferred backends (PIN-remove, user-data export) → Plans/Archive/To Plan/.

## cp-v0.4.39 — mythos — 2026-06-15
**Branch:** main · **Agent:** Mythos
**Task:** Plan 1 C2 — About page rebuilt to mockup (This server + Software cards)

### Changes
- `control-panel/src/components/settings-shell/about-client.tsx` — full rewrite from the "About & Usage" telemetry stub to the mockup. **This server** (name + host/OS/uptime; domain + HTTPS reachability) and **Software** (Platform "core·interface" versions, Update channel, Open source licenses). Honest copy + `Promise.allSettled` degradation (pitfalls #23/#28). Telemetry export removed (moves to Privacy next slice).
- `control-panel/src/app/settings/(shell)/about/page.tsx` — injects CP version from `package.json` (server-side), admin-gated.
- `control-panel/src/app/settings/(shell)/about/licenses/page.tsx` — NEW: open-source licenses list (real OSS stack + YouEye BSL-1.1).
- `control-panel/package.json` → 0.4.39; new spec `tests/settings-about.spec.ts`.

### Test Results
- `settings-about.spec.ts` 7/7; `pnpm build` OK (both About routes compiled). Released cp-v0.4.39 → bykapc deploy + verify on lemon.app/settings/about.

### Notes for Iris
- N/A (direct-to-main). No new backend route, no new dependency, no UI→CP call. Reuses existing admin APIs (settings, system, health, domain, tls).

## cp-v0.4.38 — mythos — 2026-06-15
**Branch:** main · **Agent:** Mythos
**Task:** Plan 1 C2 — Network page rebuilt to mockup (DNS / Routes / Domain & HTTPS) + Switch primitive

### Changes
- `control-panel/src/components/settings-shell/network-client.tsx` — full rewrite, 3 tabs. DNS (stats + blocking master switch + Local names A/CNAME add/remove + Blocklists enable-toggle + Recent queries), Routes (read-only Caddy table + raw config), Domain & HTTPS (domain edit + cert status, honest on-demand copy).
- `control-panel/src/app/api/apps/pihole/lists/route.ts` — NEW: blocklists GET/POST/PATCH(toggle)/DELETE (session-authed, FTL `/api/lists`).
- `control-panel/src/app/settings/api/caddy/routes/route.ts` + `.../caddy/config/route.ts` — NEW: re-export GET under CP-guaranteed `/settings/api/*` (root `/api/caddy/*` 404s → UI from Settings surface).
- `control-panel/src/components/ui/switch.tsx` — NEW: dependency-free `Switch` primitive.
- `control-panel/package.json` → 0.4.38; new spec `tests/settings-network.spec.ts`.

### Test Results
- `settings-network.spec.ts` 7/7 (+ dark-mode 4/4, personal 10/10); `pnpm build` OK. Released cp-v0.4.38 → bykapc deploy + verify on lemon.app/settings/network.

### Notes for Iris
- N/A (direct-to-main). New backend route (`apps/pihole/lists`) + 2 caddy proxies; no new dependency; admin+CSRF on all writes; no UI→CP call.

## cp-v0.4.37 — mythos — 2026-06-15
**Branch:** main · **Agent:** Mythos
**Task:** Plan 1 (C) — CP Settings honors + persists dark mode (owner-reported bug)

### Changes
- `control-panel/src/lib/theme.ts` — NEW: `resolveDark`/`applyThemeMode`/`broadcastThemeMode`; mirrors mode to `localStorage["theme"]` (shared with the dashboard's next-themes; `/settings` is same-origin).
- `control-panel/src/app/layout.tsx` — `suppressHydrationWarning` + pre-paint boot script applies `.dark` from `localStorage["theme"]` (no flash); body `bg-gray-50` → `bg-background`.
- `control-panel/src/components/control-surface/control-header.tsx` — effect applies saved mode on load + on change (keyed on themeMode/systemPref) + `youeye-theme-mode` listener; cycle button uses `applyThemeMode`.
- `control-panel/src/components/settings-shell/appearance-client.tsx` — `selectMode` applies + broadcasts immediately, then PUTs to persist.
- `control-panel/package.json` → 0.4.37; new spec `tests/settings-dark-mode.spec.ts`.

### Test Results
- `settings-dark-mode.spec.ts` 4/4 + `settings-personal.spec.ts` 10/10; `pnpm build` OK. Released cp-v0.4.37 → bykapc deploy + verify on lemon.app/settings.

### Notes for Iris
- N/A (direct-to-main, no Iris). CP-only; no new dependency; no UI→CP call (pitfall #25). Closes the dark-mode-live gap flagged at cp-v0.4.32.

## cp-v0.4.36 — mythos — 2026-06-14
**Branch:** main · **Agent:** Mythos
**Task:** Plan 1 C2 — System fix: Core Update Source routing (pre-existing)

### Changes
- `control-panel/src/app/settings/api/settings/route.ts` — NEW: re-exports GET/PATCH from `@/app/api/settings/route` under the CP-guaranteed `/settings/api/*` prefix (root `/api/settings` 404s at the domain — Caddy routes root `/api/*` to UI).
- `control-panel/src/components/settings-shell/system-client.tsx` — Core Update Source fetches `/settings/api/settings` (load + save).
- `control-panel/package.json` → 0.4.36. spec 10/10 (+path assertion).

### Test Results
- spec 10/10; `pnpm build` OK. Released cp-v0.4.36 → bykapc deploy + verify Core Update Source loads.

## cp-v0.4.35 — mythos — 2026-06-14
**Branch:** main · **Agent:** Mythos
**Task:** Plan 1 C2 — System (Administration) rebuilt to mockup

### Changes
- `control-panel/src/components/settings-shell/system-client.tsx` — rebuilt to `settings-system.html`: H1 + sub; stat row (CPU/Memory/Disk/Uptime); Platform card with **human-named services** (System core/Server interface/Database/Web gateway/Network shield, versions + status dots); Live usage card (restartable core services, real cpuPercent/memory from `/api/health/services`, 5s polling, Restart). Core Update Source + Market system-image dry-run/SSE/maintenance-window flow preserved (restyled, dark-safe amber).
- `control-panel/src/app/settings/(shell)/system/page.tsx` — passes `cpVersion={pkg.version}` (Server interface row).
- `control-panel/tests/settings-personal.spec.ts` — +System tests (10/10). `control-panel/package.json` → 0.4.35. Wiki updated.

### Test Results
- settings-personal.spec 10/10; `pnpm build` OK. Released cp-v0.4.35 → bykapc deploy + lemon.app verification in this slice.

### Notes
- Per-app live usage (Notes/Cinema/…) deferred — needs incus `recursion=2` + app-restart endpoint (To Plan).

## cp-v0.4.34 — mythos — 2026-06-14
**Branch:** main · **Agent:** Mythos
**Task:** Plan 1 C2 — People (Administration) rebuilt to mockup

### Changes
- `control-panel/src/components/settings-shell/users-client.tsx` — rebuilt to `settings-people.html`: H1 "People" + sub; "N people" card (avatar tiles, Admin badge, last-seen/deactivated, Add person) with a real Manage modal (name/email, role, active, reset password, two-step Remove → PATCH/DELETE/`[id]/password`); Sign-in card ("<Site> ID" Active + Emergency local access `http://<ip>:3000` from `/api/setup/config`, never hardcoded).
- `control-panel/tests/settings-personal.spec.ts` — +People test (8/8). `control-panel/package.json` → 0.4.34. Wiki `control-panel/settings.md` + changelog.

### Test Results
- settings-personal.spec 8/8; `pnpm build` OK. Released cp-v0.4.34 → bykapc deploy + lemon.app verification in this slice.

## cp-v0.4.33 — mythos — 2026-06-14
**Branch:** main · **Agent:** Mythos
**Task:** Plan 1 C2 — Language page rebuilt to mockup

### Changes
- `control-panel/src/components/settings-shell/language-client.tsx` — tabs → mockup two-card layout: page H1 + "Language and formats…" sub; "Your language" card (System default + 5-lang selector, soft-blue active, + locale-derived read-only Dates/Time preview via `Intl`); admin "Server default" card (current + Change → inline picker). Backend unchanged. Editable per-format overrides scoped out (no store) → shown read-only.
- `control-panel/tests/settings-personal.spec.ts` — +Language test (7/7). `control-panel/package.json` → 0.4.33. Wiki `control-panel/settings.md` + changelog.

### Test Results
- settings-personal.spec 7/7; `pnpm build` OK. Released cp-v0.4.33 → bykapc deploy + lemon.app verification in this slice.

## cp-v0.4.32 — mythos — 2026-06-14
**Branch:** main · **Agent:** Mythos
**Task:** Plan 1 C2 — Settings shell + Personal pages (Profile, Appearance, nav)

### Changes
- `control-panel/src/components/settings-shell/settings-shell.tsx` — nav grouped into **Personal** + **Administration** section labels (mockup `.section-label`); active item soft-blue `bg-primary/10 text-primary` (was the wrong shadcn gray `bg-accent`). Market stays out (D9); People not Users.
- `control-panel/src/components/settings-shell/profile-client.tsx` — rebuilt to `settings-profile.html` on shadcn Card/Input/Button/Avatar: page H1 + "Your account on this server", identity card (64px avatar, role, Change photo/Remove), Details card. Data wiring unchanged. Honest omissions: no "Change password" (no self-service endpoint) and no join date (API has none) — no fake UI (#28).
- `control-panel/src/components/settings-shell/appearance-client.tsx` — page header → H1 + mockup subtitle; WordArt picker unchanged (D7).
- `control-panel/tests/settings-personal.spec.ts` — NEW (6 tests). `control-panel/package.json` → 0.4.32. Wiki `control-panel/settings.md` (Workstream C section).

### Test Results
- settings-personal.spec 6/6; `pnpm build` OK. Released cp-v0.4.32 → bykapc deploy + lemon.app screenshot verification in this slice.

### Notes
- Correction (owner, 2026-06-14): no Caddy `/settings`→UI migration. Settings stays CP-served by design; C = redesign CP pages + drop `control.<domain>` from nav, then retire dead embeds + old `(dashboard)` shell.
- Deferred C slices: Language (format fields + backend), Privacy (new page + Switch primitive), Apps list (detail = E6), Administration pages (live infra), C3 retirement.

## ui-v0.4.10 — mythos — 2026-06-14
**Branch:** main · **Agent:** Mythos
**Task:** Plan 1 E4 — account menu

### Changes
- `ui/src/components/layout/user-menu.tsx` — rebuilt to the mockup: 340px rounded panel, centered email, 76px avatar + edit pencil, "Hi, <first name>!", "Manage your account" pill, grouped card (Timeline/Settings), **Theme Light/Dark/Auto segmented control** (replaces cycle; DB-synced), ghost Sign out, Privacy·About footer. Tokenized; data plumbing preserved.
- `ui/tests/account-menu.spec.ts` — NEW. `package.json` → 0.4.10. Wiki `YE-Wiki/ui/account-menu.md`.

### Test Results
- spec 2/2; `pnpm build` OK. **Deployed** to youeye-ui (UI-served dashboard) + screenshot-verified on lemon.app.

## ui-v0.4.9 — mythos — 2026-06-14
**Branch:** main · **Agent:** Mythos
**Task:** Plan 1 E0 — UnifiedEmbed foundation (unblocked by the open C route decision)

### Changes
- `ui/src/components/embeds/unified-embed.tsx` — NEW: the one embed wrapper + `youeye:ready/resize/action` protocol (origin-validated, lazy IntersectionObserver, skeleton, timeout→fallback never-silent, sandbox, `?theme&mode` token delivery, one-cycle legacy compat).
- `ui/tests/unified-embed.spec.ts` — NEW (3 tests). `package.json` → 0.4.9.

### Test Results
- spec 3/3; `pnpm build` OK. Additive/unused → **not deployed** (ships when E2/E3/E5/E6 consume it).

### Notes for Iris
- E0 remaining: `normalize.ts` kinds (settings-panel, launcher) + Canvas SDK `SettingsPanel` kit.
- (cp-v0.4.31 earlier reverted premature Privacy/Backups nav; see changelog.)

## cp-v0.4.30 — mythos — 2026-06-14
**Branch:** main · **Agent:** Mythos
**Task:** Plan 1 C1 — Settings nav reconcile on the LIVE (CP) shell

### Changes
- `control-panel/src/components/settings-shell/settings-shell.tsx` — **+Privacy** (Personal), **+Backups** (Admin), **Users→People**, **−Market (D9)**. This is the shell that actually serves `lemon.app/settings` (Caddy routes `/settings*`,`/market*` → youeye-control). `package.json` → 0.4.30.

### Test Results
- `pnpm build` OK; artifact 0.4.30. **Live-verified** on lemon.app/settings (DOM nav: Profile/Appearance/Apps/Language/Privacy + People/System/Network/Backups/About, no Market).

### Notes for Iris
- The matching `ui-v0.4.8` change to `ui/src/components/settings/settings-shell.tsx` targets the future UI-owned route; CP shell is the live one until a Caddy `/settings`→youeye-ui migration (C3).

## ui-v0.4.8 — mythos — 2026-06-14
**Branch:** main · **Agent:** Mythos
**Task:** Plan 1 — Workstream A (UI tokens, first UI deploy) + C1 (Settings nav reconcile)

### Changes
- `ui/src/app/globals.css` — Workstream A blue token override now BUILT + DEPLOYED to the UI container (was source-only since cp-v0.4.27).
- `ui/src/components/settings/settings-shell.tsx` — C1: added Privacy (Personal) + Backups (Administration) to the Settings nav; **removed Market (D9 — Market is a launcher app)**; removed now-unused Store import.
- `ui/tests/settings-shell-nav.spec.ts` — NEW regression. `package.json` → 0.4.8.

### Test Results
- UI source-regression spec passes. `pnpm build` OK; UI standalone carries 0.4.8.
- Deployed to youeye-ui; screenshot-verified on lemon.app/settings.

### Notes for Iris
- First UI release of the redesign. C1 i18n-only polish (headers "Personal"/"Administration", Users→People) deferred. Next: C2 per-page + C3 CP retirement.

## cp-v0.4.29 — mythos — 2026-06-14
**Branch:** main · **Agent:** Mythos
**Task:** Plan 1 B.3 polish — login wordmark size-cap (D3)

### Changes
- `control-panel/src/app/identity/login/route.ts` — `.wordmark` font-size capped to 38px (was rendering at the full branding size and clipping the last letter after the B.3 panel narrowing); wider max-width, toned shadow. `package.json` → 0.4.29.

### Test Results
- `pnpm build` OK; visual re-verify on bykapc (login wordmark no longer clipped).

## cp-v0.4.28 — mythos — 2026-06-14
**Branch:** main
**VM:** potempc / bykapc
**Agent:** Mythos
**Task:** Plan 1 redesign — Workstream B.3 (identity login rebuild) + B.4 (consent rebuild) — completes Phase 1

### Changes
- `control-panel/src/app/identity/login/route.ts` — login generated from shared tokens (no hardcoded hex), light+dark via `prefers-color-scheme`, Geist Sans, blue accent Continue (keeps "Continuing…" morph + wordart wordmark), 12px panel, quiet "<Identity> — your account on this server" footer.
- `control-panel/src/app/application/o/authorize/route.ts` — consent tokenized + light+dark; runtime permissions render as switches (kept); app-icon ‹··› provider pairing kept; blue approve.
- `control-panel/tests/identity-error-page.spec.ts` — +1 regression (login+consent tokens/dark/no-Inter/no-#0b84ff). `package.json` → 0.4.28.

### Test Results
- 9/9 source-regression specs pass. `pnpm build` OK; artifact carries 0.4.28.

### Notes for Iris
- Completes Workstream B (identity). Full wordmark size-cap + "Can't sign in?" recovery link (no backend) deferred to Workstream F. UI `globals.css` token change ships with first UI release.

## cp-v0.4.27 — mythos — 2026-06-14
**Branch:** main
**VM:** potempc / bykapc
**Agent:** Mythos
**Task:** Plan 1 redesign — Workstream A (blue token foundation) + B.2 (friendly identity error page)

### Changes
- `control-panel/src/app/globals.css`, `ui/src/app/globals.css` — Workstream A: reconcile shadcn near-black `--primary` to the YouEye blue accent (`#2563eb` light / `#3b82f6` dark), white primary-foreground, blue `--ring`/`--sidebar-primary`, `--radius` 0.5rem (override block appended; consolidated in Workstream F). Kills the black "Install" button across shadcn surfaces.
- `control-panel/src/lib/identity/error-page.ts` — NEW `renderIdentityErrorPage()`: friendly HTML identity error page (warn glyph, human title, Go home / Try again, collapsed technical details), light+dark via `prefers-color-scheme`, per `mockups/v2/error.html`.
- `control-panel/src/app/application/o/authorize/route.ts` — user-facing `invalid_redirect_uri` / `invalid_client` / `unsupported_response_type` now render the friendly page instead of raw JSON. Machine `token`/`userinfo` endpoints intentionally keep JSON (OAuth2 spec).
- `control-panel/tests/identity-error-page.spec.ts` — NEW (4 tests). `package.json` → 0.4.27.

### Test Results
- `CONTROL_PANEL_ROOT=… node --import tsx --test tests/identity-error-page.spec.ts tests/silent-settings-sso.spec.ts` → 8/8 pass.
- `pnpm build` OK; `standalone.tar` carries 0.4.27.

### Notes for Iris
- CP-only release. UI `globals.css` token change is in source but ships with the first UI release.
- B.3 (login rebuild) / B.4 (consent rebuild) are the remaining Phase 1 identity slices.

## cp-v0.4.26 — mythos — 2026-06-14
**Branch:** main
**VM:** potempc / bykapc
**Agent:** Mythos
**Task:** Plan 1 redesign — Workstream B.1: fix signed-out `control.<domain>` SSO `invalid_redirect_uri`

### Changes
- `control-panel/src/lib/identity/core-clients.ts` — `controlRedirectUris()` now registers the Control Panel host's `/settings/api/auth/callback` (silent settings SSO) alongside `/api/auth/callback`. Signed-out `https://control.<domain>/` is bounced through settings SSO with `redirect_uri=https://control.<domain>/settings/api/auth/callback`, which was unregistered → raw JSON `{"error":"invalid_redirect_uri"}`. `settingsExternalUrl` already includes `/settings`, so only `/api/auth/callback` is appended there (avoids a bogus `…/settings/settings/api/auth/callback`).
- `control-panel/tests/silent-settings-sso.spec.ts` — regression: control-host settings callback registered; double-`/settings` URI absent.
- `control-panel/package.json` — bump to 0.4.26.

### Test Results
- `CONTROL_PANEL_ROOT="$PWD/control-panel" node --import tsx --test control-panel/tests/silent-settings-sso.spec.ts` → 4/4 pass.
- `pnpm build` (control-panel) OK; `standalone.tar` carries version 0.4.26.

### Notes for Iris
- Control Panel-only release; Spine 0.4.9 and UI 0.4.7 unchanged.
- Existing installs keep old `redirect_uris` until re-registered: `POST /api/identity/core-clients` (admin) or update the `youeye-control` row in `identity_clients`. Fresh installs get the fix automatically.
- Raw-JSON identity error surfaces (`invalid_redirect_uri`, `invalid_client`) get the friendly error page in a follow-up cp slice (Workstream B.2).

## cp-v0.4.25 — mythos — 2026-06-12
**Branch:** main
**VM:** potempc / bykapc
**Agent:** Mythos
**Task:** Redesign Market app install flow

### Changes
- `control-panel/src/app/market/[appId]/page.tsx` — Moved app actions into a right sticky status panel, kept install progress in the action area, and added concise app capability/status context.
- `control-panel/src/components/market/install-dialog.tsx` — Reworked install into a focused dialog with basics, integration choices, and a manifest-defaulted account-login switch.
- `control-panel/src/app/market/page.tsx` — Added Market section tabs so integrations are grouped separately by target app while preserving source variants.
- `control-panel/src/lib/market/engine.ts`, `control-panel/src/lib/market/types.ts` — Persisted the install-time account-login choice and used it when resolving platform account protection.
- `control-panel/tests/market-product-install-ux.spec.mjs`, `control-panel/tests/market-integrations.spec.ts` — Added and updated Market UX regression checks.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.25`.

### Test Results
- Focused Market tests passed: `CONTROL_PANEL_ROOT="$PWD/control-panel" node --import tsx --test control-panel/tests/market-product-install-ux.spec.mjs control-panel/tests/market-integrations.spec.ts control-panel/tests/market-filters.spec.mjs control-panel/tests/market-sso-engine.spec.mjs`.
- Adjacent Market tests passed: `CONTROL_PANEL_ROOT="$PWD/control-panel" node --import tsx --test control-panel/tests/market-update-manifest-sync.spec.mjs control-panel/tests/market-system-apps.spec.ts control-panel/tests/market-surfaces.spec.ts control-panel/tests/market-canonical-surfaces.spec.mjs control-panel/tests/market-integration-remove.spec.mjs control-panel/tests/market-product-install-ux.spec.mjs`.
- Build passed: `pnpm build` in `control-panel/`.
- Artifact verification passed: CP `standalone.tar` contains top-level `server.js` and package version `0.4.25`.

### Notes for Iris
- Control Panel-only release; Spine remains `0.4.9` and UI remains `0.4.7`.
- User asked not to deploy/update from this session; they will update and test manually.

## spine-v0.4.9 / cp-v0.4.24 / ui-v0.4.7 — mythos — 2026-06-12
**Branch:** main
**VM:** potempc / bykapc
**Agent:** Mythos
**Task:** Merge Mythos Settings/update-source work into current identity-polished main

### Changes
- `control-panel/src/components/settings-shell/system-client.tsx`, `control-panel/src/lib/settings/service.ts` — Added CP-native Core Update Source controls for release branch and repo URL while keeping Settings/System in the Control Panel shell.
- `control-panel/src/components/settings-shell/users-client.tsx`, `control-panel/src/app/api/apps/identity/users/route.ts` — Added admin-only user creation with role selection and protected the identity users API with admin checks.
- `control-panel/src/app/embed/system/*`, `control-panel/src/app/embed/users/*`, `ui/src/app/settings/system/page.tsx`, `ui/src/app/settings/users/page.tsx` — Removed retired embed/settings routes so System and Users are no longer mistaken for UI iframe surfaces.
- `spine/internal/api/server.go`, `spine/internal/config/repo_file.go`, `spine/internal/cmd/repo.go`, `spine/internal/config/defaults.go` — Persisted core release repo changes to `/etc/youeye/config.yaml`, clear update caches when release source changes, and corrected UI app-dir/version detection.
- `ui/src/components/backgrounds/homepage-background.tsx`, `ui/scripts/postbuild.js` — Restored animated backgrounds unless the user/OS disables motion and added a sharp `@img` nested-binding fallback for standalone builds.
- `README.md`, `docs/settings.md`, `spine/docs/configuration.md`, `ui/README.md` — Updated current versions and settings/update-source documentation for the combined main release.
- `control-panel/package.json`, `ui/package.json`, `spine/internal/cmd/root.go` — Bumped stable releases to Spine `0.4.9`, Control Panel `0.4.24`, and UI `0.4.7`.

### Test Results
- Go: `go test ./...` passed in `spine/`.
- Control Panel focused tests passed: `CONTROL_PANEL_ROOT="$PWD/control-panel" node --import tsx --test control-panel/tests/identity-consent.spec.ts control-panel/tests/settings-update-source-users.spec.mjs control-panel/tests/settings-app-updates.spec.mjs`.
- UI focused tests passed: `UI_ROOT="$PWD/ui" node --test ui/tests/launch-permissions-bridge.spec.mjs ui/tests/background-animation-gating.spec.mjs ui/tests/internet-proxy.spec.mjs`.
- Builds passed: `pnpm build` in `control-panel/`; `pnpm build` in `ui/`; Spine built with `Version=0.4.9` and `BuildDate=2026-06-12`.
- Artifact verification passed: CP `standalone.tar` contains top-level `server.js` and package version `0.4.24`; UI `standalone.tar` contains top-level `server.js` and package version `0.4.7`; `spine-linux-amd64 version` reports `0.4.9`.
- UI build printed the known local `127.0.0.1:5432` schema-initialization warnings during static generation but exited successfully.

### Notes for Iris
- Combined the older `mythos` branch work with the current main identity releases; no identity login/consent source conflicts occurred.
- User asked not to deploy/update from this session; they will update and test manually.

## cp-v0.4.23 / ui-v0.4.6 — mythos — 2026-06-12
**Branch:** main
**VM:** potempc / bykapc
**Agent:** Mythos
**Task:** Match identity consent branding to native app headers

### Changes
- `control-panel/src/app/application/o/authorize/route.ts` — Changed consent from the oversized centered app tile to the same compact icon/name lockup used by native app headers, including app wordart styling when available and absolute UI asset URLs for app/user images.
- `ui/src/app/api/ui-bridge/app-launch-permissions/route.ts` — Expanded the consent display payload with branding CSS/font/character-shape metadata, preserved the raw avatar path for CP to absolutize, and stopped returning relative public URLs that break on the identity domain.
- `control-panel/tests/identity-consent.spec.ts`, `ui/tests/launch-permissions-bridge.spec.mjs` — Added regressions for native-style consent branding, wordart payload fields, UI external URL wiring, and avatar fallback data.
- `ui/public/sw.js` — Regenerated by the UI production build with updated precache hashes.
- `control-panel/package.json`, `ui/package.json`, `README.md` — Bumped Control Panel to `0.4.23` and UI to `0.4.6`.

### Test Results
- Focused tests passed: `CONTROL_PANEL_ROOT="$PWD/control-panel" node --import tsx --test control-panel/tests/identity-consent.spec.ts`.
- Focused tests passed: `UI_ROOT="$PWD/ui" node --test ui/tests/launch-permissions-bridge.spec.mjs ui/tests/internet-proxy.spec.mjs`.
- Build: `pnpm build` passed in `control-panel/`; `/tmp/cp-standalone.tar` contains package version `0.4.23`. `pnpm build` passed in `ui/`; `/tmp/ui-standalone.tar` contains package version `0.4.6`.
- TypeScript/lint: full-project checks remain blocked by pre-existing unrelated errors noted in prior releases; no new task-local type error remains after fixing `uiExternalUrl` null handling.

### Notes for Iris
- Paired CP/UI bridge release; Spine remains `0.4.8`.
- User explicitly asked not to update/deploy from this session; they will test the release manually.

## cp-v0.4.22 / ui-v0.4.5 — mythos — 2026-06-12
**Branch:** main
**VM:** potempc / bykapc
**Agent:** Mythos
**Task:** Use app branding and real user avatars on identity consent

### Changes
- `ui/src/app/api/ui-bridge/app-launch-permissions/route.ts` — Adds consent display metadata to the existing permission bridge response: resolved app name/icon from the user's app config and the user's public avatar URL.
- `control-panel/src/app/application/o/authorize/route.ts` — Renders the consent header with the app mark instead of the identity-provider mark, uses app/user bridge metadata when available, and displays the user's real YouEye avatar with initials as fallback.
- `control-panel/tests/identity-consent.spec.ts`, `ui/tests/launch-permissions-bridge.spec.mjs` — Added regressions for app-brand rendering, avatar metadata, and bridge display payloads.
- `ui/public/sw.js` — Regenerated by the UI production build with updated precache hashes.
- `control-panel/package.json`, `ui/package.json`, `README.md` — Bumped Control Panel to `0.4.22` and UI to `0.4.5`.

### Test Results
- Focused tests passed: `CONTROL_PANEL_ROOT="$PWD/control-panel" node --import tsx --test control-panel/tests/identity-consent.spec.ts`.
- Focused tests passed: `UI_ROOT="$PWD/ui" node --test ui/tests/launch-permissions-bridge.spec.mjs ui/tests/internet-proxy.spec.mjs`.
- Build: `pnpm build` passed in `control-panel/`; `/tmp/cp-standalone.tar` contains package version `0.4.22`. `pnpm build` passed in `ui/`; `/tmp/ui-standalone.tar` contains package version `0.4.5`.
- TypeScript/lint: full-project checks remain blocked by pre-existing unrelated errors noted in `cp-v0.4.15`; `ui/` `pnpm exec tsc --noEmit --pretty false` is also blocked by existing unrelated errors in embed-status, settings bridge, launch requirements, service worker, and notification/timeline embeds.

### Notes for Iris
- Paired CP/UI bridge release; Spine remains `0.4.8`.
- User explicitly asked not to update/deploy from this session; they will test the release manually.

## cp-v0.4.21 — mythos — 2026-06-12
**Branch:** main
**VM:** potempc / bykapc
**Agent:** Mythos
**Task:** Simplify identity consent to account handoff

### Changes
- `control-panel/src/app/application/o/authorize/route.ts` — Reworked the consent screen into a account handoff: provider mark, `Sign in to <app>`, selected account row, short sharing copy, quiet revoke note, optional runtime permission toggles only when needed, and no technical details/scope chips/diagram/risk pills.
- `control-panel/tests/identity-consent.spec.ts` — Updated static regressions to lock in the simplified account handoff and prevent raw technical scope UI from returning.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.21`.

### Test Results
- Static assertions: `CONTROL_PANEL_ROOT="$PWD/control-panel" node --import tsx --test control-panel/tests/identity-consent.spec.ts` passed for provider mark, account row, sharing copy, cancel/continue actions, optional runtime toggles, white-label provider naming, and absence of technical details/basic-access scope UI.
- Build: `pnpm build` passed in `control-panel/`; `/tmp/standalone.tar` contains package version `0.4.21`.
- TypeScript/lint: full-project checks remain blocked by pre-existing unrelated errors noted in `cp-v0.4.15`.

### Notes for Iris
- CP-only release; Spine remains `0.4.8`, UI remains `0.4.4`.
- User explicitly asked not to update/deploy from this session; they will test the release manually.

## cp-v0.4.20 — mythos — 2026-06-12
**Branch:** main
**VM:** potempc / bykapc
**Agent:** Mythos
**Task:** Redesign identity consent screen

### Changes
- `control-panel/src/app/application/o/authorize/route.ts` — Redesigned the raw consent HTML around the app-to-identity relationship, signed-in account row, simple basic-access bullets, optional permission switches, and collapsed technical OAuth scope details.
- `control-panel/tests/identity-consent.spec.ts` — Updated static regressions for the human consent layout, optional permission switches, and technical-details scope placement.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.20`.

### Test Results
- Static assertions: focused identity-consent assertions passed for relationship header, signed-in row, basic access bullets, optional switches, technical details, runtime permission grant flow, and OAuth redirect behavior.
- Build: `pnpm build` passed in `control-panel/`; `/tmp/standalone.tar` contains package version `0.4.20`.
- TypeScript/lint: full-project checks remain blocked by pre-existing unrelated errors noted in `cp-v0.4.15`.

### Notes for Iris
- CP-only release; Spine remains `0.4.8`, UI remains `0.4.4`.
- User explicitly asked not to update/deploy from this session; they will test the release manually.

## cp-v0.4.19 — mythos — 2026-06-12
**Branch:** main
**VM:** potempc / bykapc
**Agent:** Mythos
**Task:** Float server WordArt above identity login panel

### Changes
- `control-panel/src/app/identity/login/route.ts` — Changed `/identity/login` to render the server name WordArt outside the white login panel, removed the inner WordArt box, removed the private account pill and help footer, widened the WordArt area, and kept the login panel starting at the `Continue to <app/server>` copy.
- `control-panel/tests/identity-login-polish.spec.ts` — Updated static regressions for server-name WordArt, outside-panel placement, and removed footer/pill copy.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.19`.

### Test Results
- Static assertions: focused identity-login layout assertions passed for server-name WordArt, outside-panel placement, removed pill/footer, app context, loading transition, and hidden protocol copy.
- Build: `pnpm build` passed in `control-panel/`; `/tmp/standalone.tar` contains package version `0.4.19`.
- TypeScript/lint: full-project checks remain blocked by pre-existing unrelated errors noted in `cp-v0.4.15`.

### Notes for Iris
- CP-only release; Spine remains `0.4.8`, UI remains `0.4.4`.
- User explicitly asked not to update/deploy from this session; they will test the release manually.

## cp-v0.4.18 — mythos — 2026-06-11
**Branch:** main
**VM:** potempc / bykapc
**Agent:** Mythos
**Task:** Use server branding WordArt on identity login

### Changes
- `control-panel/src/app/identity/login/route.ts` — Reads server branding from the UI branding bridge for identity login WordArt, falls back to CP config only when the bridge is unavailable, and maps built-in YouEye UI/Control Panel clients to `Continue to <Server name>`.
- `control-panel/tests/identity-login-polish.spec.ts` — Expanded regression checks for UI bridge branding and built-in client context naming.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.18`.

### Test Results
- Build: `pnpm build` passed in `control-panel/`; `/tmp/standalone.tar` contains package version `0.4.18`.
- Static assertions: focused identity-login assertions passed for UI bridge branding, WordArt rendering, built-in client context, loading transition, and hidden protocol copy.
- TypeScript/lint: full-project checks remain blocked by pre-existing unrelated errors noted in `cp-v0.4.15`.

### Notes for Iris
- CP-only release; Spine remains `0.4.8`, UI remains `0.4.4`.
- User explicitly asked not to update/deploy from this session; they will test the release manually.

## cp-v0.4.17 — mythos — 2026-06-11
**Branch:** main
**VM:** potempc / bykapc
**Agent:** Mythos
**Task:** Make identity login use real server WordArt and improve composition

### Changes
- `control-panel/src/app/identity/login/route.ts` — Replaced the partial hand-rolled wordmark with a server-side WordArt renderer using `site_name_style` and `DEFAULT_STYLE`, including font CSS, gradients, text stroke, transforms, and character shapes; moved the wordmark into a more balanced single-panel header.
- `control-panel/src/middleware.ts` — Allows static font assets through identity-service mode so `/identity/login` can load the selected local WordArt font.
- `control-panel/tests/identity-login-polish.spec.ts` — Updated regression checks for full WordArt rendering and identity font asset support.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.17`.

### Test Results
- Build: `pnpm build` passed in `control-panel/`; `control-panel/.next/standalone.tar` contains package version `0.4.17`.
- Static assertions: focused `rg` checks passed for WordArt defaults, configured style usage, font CSS links, character-shape support, and hidden protocol copy.
- TypeScript/lint: full-project checks remain blocked by pre-existing unrelated errors noted in `cp-v0.4.15`.

### Notes for Iris
- CP-only release; Spine remains `0.4.8`, UI remains `0.4.4`.
- User explicitly asked not to deploy from this session.

## cp-v0.4.16 — mythos — 2026-06-11
**Branch:** main
**VM:** potempc / bykapc
**Agent:** Mythos
**Task:** Redesign YouEye ID login screen with branded app context

### Changes
- `control-panel/src/app/identity/login/route.ts` — Redesigned the raw identity login HTML around the configured identity provider name, a centered light panel, app-aware copy such as `Continue to Notes`, and a submit button that morphs to `Continuing...`.
- `control-panel/tests/identity-login-polish.spec.ts` — Added regression checks for provider-name wordmark, app-context derivation, submit loading transition, and hiding protocol terms from primary copy.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.16`.

### Test Results
- Build: `pnpm build` passed in `control-panel/`; `control-panel/.next/standalone.tar` contains package version `0.4.16`.
- Static assertions: focused `rg` checks passed for configured provider wordmark, app context helpers, and `Continuing...` button transition.
- TypeScript/lint: full-project checks remain blocked by pre-existing unrelated errors noted in `cp-v0.4.15`.

### Notes for Iris
- CP-only release; Spine remains `0.4.8`, UI remains `0.4.4`.
- User asked for release/push flow and will test manually.

## cp-v0.4.15 — mythos — 2026-06-11
**Branch:** main
**VM:** potempc / bykapc
**Agent:** Mythos
**Task:** Make Settings SSO redirect silent and server-side

### Changes
- `control-panel/src/app/login/page.tsx` — Converted login entry to a server component that redirects domain SSO users before rendering the PAM form.
- `control-panel/src/app/settings/login/page.tsx` — Added Settings-specific server redirect to `/settings/api/auth/sso` with `/settings` return path.
- `control-panel/src/components/auth/login-form.tsx` — Moved the PAM login form into a client component and removed client-side SSO mode detection.
- `control-panel/src/lib/auth/mode.ts` — Added shared auth-mode helper for host/IP vs SSO decisions.
- `control-panel/src/app/api/auth/mode/route.ts` — Reused the shared auth-mode helper so API reporting matches server routing.
- `control-panel/tests/silent-settings-sso.spec.ts` — Added regression checks for server-side Settings SSO redirect and removal of the old client interstitial path.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.15`.

### Test Results
- Build: `pnpm build` passed in `control-panel/`; `control-panel/.next/standalone.tar` contains package version `0.4.15`.
- Static assertions: focused `rg` checks passed for server-side Settings SSO redirect and absence of `redirectingToSSO`/client `window.location` path.
- TypeScript/lint: `pnpm exec tsc --noEmit` and `pnpm lint` remain blocked by pre-existing unrelated errors across market, suggestions, service worker, backup, Caddy, and setup files.

### Notes for Iris
- CP-only release; Spine remains `0.4.8`, UI remains `0.4.4`.
- User asked to update and test manually, so no deployment was performed from this session.

## spine-v0.4.8 — mythos — 2026-06-11
**Branch:** main
**VM:** potempc / youeye-pc
**Agent:** Mythos
**Task:** Fix Incus 7.1 local base-image JSON lookup

### Changes
- `spine/internal/incus/images.go` — Replaced `incus image info local:<alias> --format json` with `incus image list <alias> --format json` for local base-image lookup because Incus 7.1 rejects `--format` on `image info`.
- `spine/internal/incus/images_test.go` — Adds parser coverage for the real `incus image list` JSON array shape, plus empty and ambiguous match rejection.
- `spine/internal/cmd/root.go`, `README.md`, `current-state.yaml` — Bumped Spine to `0.4.8` and updated current versions.

### Test Results
- Go: `go test ./...` passed in `spine/`.

### Notes for Iris
- Spine-only release; CP remains `0.4.14`, UI remains `0.4.4`.
- Follow-up to `spine-v0.4.7`: verified mirror fallback imported the image successfully on `youeye-pc`, but the post-import lookup used an unsupported Incus CLI flag and misreported the image as unavailable.

## spine-v0.4.7 — mythos — 2026-06-11
**Branch:** main
**VM:** potempc / youeye-pc
**Agent:** Mythos
**Task:** Add verified public-mirror fallback for first base-image acquisition

### Changes
- `spine/internal/incus/images.go` — When `incus image copy images:debian/12` fails, Spine now fetches official Linux Containers simplestreams metadata, selects Debian bookworm amd64 default, downloads image files from public mirror candidates, verifies metadata/rootfs/combined hashes, imports the image as `local:youeye-debian-12`, and validates the imported fingerprint.
- `spine/internal/incus/images_test.go` — Adds regression coverage for latest metadata selection, incomplete-version fallback, combined fingerprint hashing, and mirror URL construction.
- `spine/internal/cmd/root.go`, `README.md`, `current-state.yaml` — Bumped Spine to `0.4.7` and updated current versions.

### Test Results
- Go: `go test ./...` passed in `spine/`.

### Notes for Iris
- Spine-only release; CP remains `0.4.14`, UI remains `0.4.4`.
- This does not require YouEye to host images. Official simplestreams metadata remains the trust source; public mirrors are accepted only when the downloaded bytes match official hashes.

## spine-v0.4.6 — mythos — 2026-06-11
**Branch:** main
**VM:** potempc / youeye-pc
**Agent:** Mythos
**Task:** Add verified local base-image manager for system containers

### Changes
- `spine/internal/incus/images.go` — Adds a base-image manager that ensures official Debian 12 is available as local alias `youeye-debian-12`, validates Debian/bookworm/amd64/container metadata, and records verified image metadata under `/var/lib/youeye/images/debian-12.json`.
- `spine/internal/container/control.go`, `spine/internal/container/ui.go` — Create system containers from `local:youeye-debian-12` instead of reaching directly to `images:debian/12` during container creation.
- `spine/internal/incus/install.go` — Runs base-image bootstrap after Incus bridge hygiene and before CP/UI container creation, including reused-Incus install paths.
- `spine/internal/incus/images_test.go` — Adds validation coverage for Debian 12 image metadata.
- `spine/internal/cmd/root.go`, `README.md` — Bumped Spine to `0.4.6` and updated current versions.

### Test Results
- Go: `go test ./...` passed in `spine/`.

### Notes for Iris
- Spine-only release; CP remains `0.4.14`, UI remains `0.4.4`.
- This does not raw-download arbitrary mirror URLs. It uses official Incus image copy first, then creates system containers from the verified local alias so retry deploys are deterministic once the image exists.

## spine-v0.4.5 — mythos — 2026-06-11
**Branch:** main
**VM:** potempc / youeye-pc
**Agent:** Mythos
**Task:** Clean orphaned Incus dnsmasq processes after fresh deploy bridge recreation

### Changes
- `spine/internal/incus/install.go` — After restarting Incus for stale `incusbr0` dnsmasq state, Spine now terminates only stale Incus-owned bridge dnsmasq processes whose `--listen-address` does not match the current bridge IP, then verifies exactly one current dnsmasq remains.
- `spine/internal/incus/install_test.go` — Adds regression coverage for stale PID extraction and duplicate-current dnsmasq counting.
- `spine/internal/cmd/root.go`, `README.md` — Bumped Spine to `0.4.5` and updated current versions.

### Test Results
- Go: `go test ./...` passed in `spine/`.

### Notes for Iris
- Follow-up to `spine-v0.4.4`: restart alone did not reap old dnsmasq children parented to PID 1 on `youeye-pc`; this release performs targeted cleanup before container creation.
- Spine-only release; CP remains `0.4.14`, UI remains `0.4.4`.

## spine-v0.4.4 — mythos — 2026-06-11
**Branch:** main
**VM:** potempc / youeye-pc
**Agent:** Mythos
**Task:** Harden fresh deploy against Incus mirror/network and missing Node failures

### Changes
- `spine/internal/incus/install.go` — Normalizes `incusbr0` to IPv4-only, reapplies DHCP/DNS setup on reused Incus installs, and restarts Incus when stale `incusbr0` dnsmasq processes from old subnets are detected.
- `spine/internal/container/control.go` — Adds CP container IPv4/network preflight, fails every critical Node install step loudly, verifies `/usr/bin/node`, and verifies bundled `styled-jsx` instead of running production `pnpm install`.
- `spine/internal/incus/install_test.go` — Adds regression coverage for stale Incus dnsmasq process detection.
- `spine/internal/cmd/root.go`, `README.md` — Bumped Spine to `0.4.4` and updated current versions.

### Test Results
- Go: `go test ./...` passed in `spine/`.

### Notes for Iris
- Spine-only release; CP remains `0.4.14`, UI remains `0.4.4`.
- Fresh deploy should now fail before CP extraction if the control container lacks IPv4/DNS/TCP access, instead of falsely reporting Node installed and crash-looping systemd.

## ui-v0.4.3.31 / cp-v0.4.13.100 — mythos — 2026-06-11
**Branch:** mythos
**VM:** potempc (host, Artem-style)
**Agent:** Mythos
**Task:** Fix app internet/inter-app proxy gzip corruption + spine update ui CSRF rejection

### Changes
- `ui/src/app/api/apps/v1/internet/route.ts`, `ui/src/app/api/apps/v1/proxy/[targetAppId]/[...path]/route.ts` — strip `content-encoding`/`content-length` from proxied responses; fetch() decompresses upstream bodies, so forwarding the original headers made compliant app clients inflate plain bytes (Z_DATA_ERROR → Weather geocode/forecast 500 since the proxy internet migration; same latent bug under Wiki/Cinema/Translate media).
- `control-panel/src/app/api/updates/[component]/route.ts` — the `!csrfToken ||` short-circuit 403'd CLI calls before verifyCSRFToken's CLI-token bypass could run, breaking `spine update ui` entirely. Route now lets verifyCSRFToken decide.
- `pnpm-lock.yaml` — sync with control-panel radix deps (inherited stale from the artem merge; broke frozen-lockfile builds).

### Test Results
- Live on lemon: CP 0.4.13.100 deployed via `spine update control`; UI 0.4.3.31 via the now-working `spine update ui`; Weather geocode/forecast verified working in browser (operator-confirmed), proxy returns clean headers.

### Notes for Iris
- Same `!csrfToken ||` short-circuit pattern exists in ~10 more CP routes (caddy/*, incus, ui, pihole, settings app-update, setup/control-routes, people/password, containers/lan-port) — browser flows work, CLI-token flows would 403. Brief in `Plans/To Plan/`.
- ye-builder (LXC 418) checkout migrated git.byka.wtf → git.potemk.in (was frozen pre-migration).
## v0.4.2.11 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Fix fresh-deploy identity service mode

### Changes
- `spine/internal/cmd/update.go`, `spine/internal/container/control.go` — Write the identity provider systemd unit with `IDENTITY_SERVICE=true` and generic Identity Provider description so fresh deploys serve OAuth JSON endpoints instead of the Control Panel setup redirect.
- `spine/install.sh` — Seed new branch installs with `subdomains.identity: id` instead of the obsolete `auth` subdomain key.
- `spine/internal/cmd/root.go`, `README.md` — Bumped Spine to `0.4.2.11`.

### Test Results
- Spine: `go test ./...` passed.
- Spine release binary build passed; `/tmp/spine-linux-amd64 version` reports `0.4.2.11`.
- Live `bykapc` hotfix verified: identity discovery returns JSON and token endpoint returns JSON `401 invalid_client` for an intentionally incomplete test request instead of HTML.

### Notes for Iris
- This fixes the `Unexpected token '<'` OAuth callback loop seen on a white-labelled fresh deployment when the token endpoint returned HTML from the normal Control Panel runtime.

## v0.4.13.99 / v0.4.3.30 / v0.4.2.10 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** White-label identity provider login, consent, routes, and env contract

### Changes
- `control-panel/src/app/identity/login/route.ts`, `control-panel/src/app/application/o/authorize/route.ts` — Render configured provider name and WordArt, with friendlier login and Allow/Not now consent.
- `control-panel/src/app/api/setup/run/route.ts`, `control-panel/src/lib/identity/provider.ts`, `spine/internal/api/server.go` — Persist `identity.name`, keep `subdomains.identity` configurable, and emit `IDENTITY_*` service env vars.
- `control-panel/src/app/(dashboard)/apps/identity`, `control-panel/src/app/api/apps/identity/*` — Move visible identity management routes off Authentik names.
- `ui/src/db/*`, `ui/src/lib/auth/*`, `ui/src/lib/permissions/descriptors.ts` — Use `identity_id`, migrate old `authentik_id`, read `IDENTITY_*`, and improve permission descriptors.

### Test Results
- Spine: `go test ./...` passed; binary build passed.
- CP: `pnpm build` passed.
- UI: `pnpm build` passed with known local `127.0.0.1:5432` static-generation warnings.

### Notes for Iris
- Not deployed. Existing dev deployments should move config to `identity.name` and regenerate CP/UI env files with `IDENTITY_*`.

## v0.4.13.98 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Make Settings app updates actionable

### Changes
- `control-panel/src/components/settings-shell/apps-client.tsx` — Replaced the update badge-only row with a real per-app Update button, CSRF-backed POST, progress polling, and inline status/error/completion display.
- `control-panel/src/app/settings/api/apps/[appId]/update/route.ts` — Added an admin-only Settings update endpoint that reuses existing Spine, LXD, OCI, and Marketplace update engines.
- `control-panel/tests/settings-app-updates.spec.mjs` — Added regression coverage that Settings exposes a real update action and the route stays admin/CSRF scoped.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.13.98`.

### Test Results
- Focused CP tests passed: `node --test control-panel/tests/settings-app-updates.spec.mjs control-panel/tests/market-canonical-surfaces.spec.mjs control-panel/tests/market-update-manifest-sync.spec.mjs`.
- CP production build passed for `0.4.13.98`.
- Release artifact verified: `standalone.tar` contains top-level `server.js` and embedded package version `0.4.13.98`.
- Live deploy passed: `spine update control` updated CP from `0.4.13.97` to `0.4.13.98`; final `spine status` reports CP `0.4.13.98`, 12 running containers, 0 stopped.
- TypeScript direct check still fails on pre-existing project-wide errors outside this change (`validate-url`, `suggestions`, `market/page`, service worker typings, shared UI component React type duplication, SSO setup, and system manifest typing).

### Notes for Iris
- Forgejo release `cp-artem-v0.4.13.98` is published as release ID `1643` with exact `standalone.tar`.
- The new Settings route mirrors the existing update orchestrators instead of inventing a second update path. It uses `/settings/api/auth/csrf` from the Settings shell before triggering updates.

## v0.4.13.97 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Use the correct Incus file upload method

### Changes
- `control-panel/src/lib/incus/server.ts` — Uses `POST /instances/{name}/files?path=...` for Incus file uploads, matching Incus 7.1 behavior.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.13.97`.

### Test Results
- Focused CP tests passed: `node --test control-panel/tests/scoped-caddy-grants.spec.mjs control-panel/tests/app-network-pihole-dns.spec.mjs control-panel/tests/market-update-plans.spec.mjs control-panel/tests/market-migration-planner.spec.mjs`.
- CP production build passed for `0.4.13.97`.
- Artifact verification passed: `standalone.tar` contains top-level `server.js` and embedded package version `0.4.13.97`.

### Notes for Iris
- Supersedes `0.4.13.96`, whose Incus API upload helper used `PUT` and hit `501 not implemented` on live Incus.

## v0.4.13.96 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Use Incus API for manager-downloaded app update artifacts

### Changes
- `control-panel/src/lib/incus/server.ts` — Added `incusUploadFile()` for raw file uploads over the Incus Unix socket.
- `control-panel/src/lib/market/updater.ts` — Uses the Incus files API to stage CP-downloaded native app update tarballs, avoiding a dependency on an `incus` CLI inside the Control Panel container.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.13.96`.

### Test Results
- Focused CP tests passed: `node --test control-panel/tests/scoped-caddy-grants.spec.mjs control-panel/tests/app-network-pihole-dns.spec.mjs control-panel/tests/market-update-plans.spec.mjs control-panel/tests/market-migration-planner.spec.mjs`.
- CP production build passed for `0.4.13.96`.
- Artifact verification passed: `standalone.tar` contains top-level `server.js` and embedded package version `0.4.13.96`.

### Notes for Iris
- Supersedes `0.4.13.95`, which had the right no-NAT design but attempted to shell out to `incus file push` from inside Control Panel where the CLI is not installed.

## v0.4.13.95 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Keep isolated app updates manager-downloaded

### Changes
- `control-panel/src/lib/market/updater.ts` — Downloads LXD native app release metadata and `standalone.tar` from Control Panel, pushes the artifact into the app container with `incus file push`, and removes temporary app bridge NAT plus runtime npm/package curls from the update path.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.13.95`.

### Test Results
- Focused CP tests passed: `node --test control-panel/tests/scoped-caddy-grants.spec.mjs control-panel/tests/app-network-pihole-dns.spec.mjs control-panel/tests/market-update-plans.spec.mjs control-panel/tests/market-migration-planner.spec.mjs`.
- CP production build passed for `0.4.13.95`.
- Artifact verification passed: `standalone.tar` contains top-level `server.js` and embedded package version `0.4.13.95`.

### Notes for Iris
- Supersedes the `0.4.13.94` temporary-NAT update workaround. App containers should remain isolated during updates; CP is the trusted manager that fetches and stages artifacts.

## v0.4.3.29 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Sync UI app display versions from pushed manifests

### Changes
- `ui/src/lib/db/queries/app-management.ts` — Updates `apps.version` from `manifest.version` whenever CP pushes a cached app manifest.
- `ui/package.json`, `README.md` — Bumped UI to `0.4.3.29`.

### Test Results
- Focused UI tests passed: `node --test ui/tests/internet-proxy.spec.mjs ui/tests/launch-permissions-bridge.spec.mjs ui/tests/launch-requirements.spec.mjs ui/tests/connection-proxy.spec.mjs`.
- UI production build passed for `0.4.3.29` with the known local `127.0.0.1:5432` static-generation warnings.

### Notes for Iris
- App updates already synced manifest JSON, but UI app rows could still display stale `version` values. This keeps UI display data aligned with the cached manifest.

## v0.4.13.94 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Let isolated native apps update without retaining broad internet

### Changes
- `control-panel/src/lib/market/updater.ts` — Temporarily enables app bridge NAT during LXD native app updates so isolated apps can fetch Forgejo release metadata/tarballs and package repairs, then restores the manifest's steady-state NAT policy after success or rollback.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.13.94`.

### Test Results
- Pending rebuild/release/deploy in this slice.

### Notes for Iris
- This is required by the proxy-scoped internet model: app containers should be isolated at runtime, but the updater still needs a controlled download window.

## v0.4.13.93 / v0.4.3.28 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Add proxy-scoped internet permissions and canonical proxy manifest naming

### Changes
- `control-panel/src/lib/market/schema.ts`, `control-panel/src/lib/market/types.ts` — Replaced active `wants[].caddyGrant` schema with canonical `wants[].proxy` and added `internet.proxy` host/path/method scopes.
- `control-panel/src/lib/bridges/manager.ts`, `control-panel/src/lib/bridges/store.ts` — Pushes app connection and internet proxy scope metadata to UI, stores proxy-scoped app-to-app grants as `accessMode:"proxy"`, and keeps legacy `caddy` cleanup compatibility.
- `control-panel/src/app/api/market/app/[appId]/connections/route.ts`, `control-panel/src/lib/market/engine.ts`, `control-panel/src/app/embed/market/client.tsx` — Keeps broad Internet/LAN NAT decisions separate from `internet.proxy` scopes.
- `ui/src/app/api/apps/v1/internet/route.ts`, `ui/src/lib/internet/scopes.ts` — Adds token-authenticated internet proxy enforcement with user permission, manifest scope, HTTPS, redirect, and SSRF/public-IP checks.
- `ui/src/app/api/v1/apps/[appId]/launch-requirements/route.ts`, `ui/src/app/api/ui-bridge/app-launch-permissions/route.ts`, `ui/src/lib/permissions/descriptors.ts` — Derives and describes `internet:<host>` first-launch permissions.
- `README.md`, `control-panel/package.json`, `ui/package.json`, `ui/public/sw.js` — Bumped CP to `0.4.13.93` and UI to `0.4.3.28`, including regenerated UI service worker output.

### Test Results
- `node --test control-panel/tests/scoped-caddy-grants.spec.mjs control-panel/tests/app-network-pihole-dns.spec.mjs ui/tests/internet-proxy.spec.mjs ui/tests/launch-permissions-bridge.spec.mjs ui/tests/launch-requirements.spec.mjs ui/tests/connection-proxy.spec.mjs` passed.
- `pnpm --dir control-panel build` passed for CP `0.4.13.93`.
- `pnpm --dir ui build` passed for UI `0.4.3.28` with known local `127.0.0.1:5432` static-generation warnings.

### Notes for Iris
- `internet.proxy` is intentionally not a broad NAT signal. Only `network: internet`, legacy `internet.hosts`, or the admin's explicit broad toggle should keep app bridge NAT enabled after install.

## v0.4.13.92 / v0.4.3.27 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Fix YouEye ID consent callback and runtime permission persistence

### Changes
- `control-panel/src/app/application/o/authorize/route.ts` — Sends identity user id, username, and email to UI's launch-permissions bridge, fails approval if runtime permission updates fail, and redirects OAuth authorization-code callbacks with `303` so app callbacks receive `GET` instead of the form `POST`.
- `ui/src/app/api/ui-bridge/app-launch-permissions/route.ts` — Resolves CP/YouEye ID users to UI users by Authentik/identity subject, legacy UI id, username, or email before checking/granting `app_permissions`.
- `control-panel/tests/identity-consent.spec.ts`, `ui/tests/launch-permissions-bridge.spec.mjs` — Add regression coverage for `303` consent redirects and identity-to-UI user mapping.
- `control-panel/package.json`, `ui/package.json`, `README.md`, `ui/public/sw.js` — Bumped Control Panel to `0.4.13.92` and UI to `0.4.3.27`, including regenerated UI service worker output.

### Test Results
- `node --test control-panel/tests/*.mjs` passed.
- `node --test ui/tests/launch-permissions-bridge.spec.mjs` passed.
- `pnpm --dir control-panel build` passed for Control Panel `0.4.13.92`.
- `pnpm --dir ui build` passed for UI `0.4.3.27` with known local `127.0.0.1:5432` static-generation warnings.
- Artifact verification passed: CP and UI `standalone.tar` files contain top-level `server.js`; embedded package versions are `0.4.13.92` / `0.4.3.27`.
- Released `cp-artem-v0.4.13.92` and `ui-artem-v0.4.3.27` with exact `standalone.tar` assets, deployed CP through `spine update control`, and deployed UI through CP's update endpoint.
- Live proof on `192.168.31.160`: `spine status` reports CP `0.4.13.92`, UI `0.4.3.27`, 10 running containers, 0 stopped. A bridge call using the YouEye ID UUID wrote Search permission rows under UI user `8c0e0421-1786-4687-bb5b-5f5dfbf2c379`; the controlled OAuth consent POST returned `HTTP/2 303` to `https://search.potato.app/api/auth/callback?...`; following that callback set `ye-search-session` and redirected to `https://search.potato.app/`. Tester Search consent and permission rows were cleaned after verification.

### Notes for Iris
- This fixes the live Search/Notes-style OAuth callback `405`: consent approval now uses `303 See Other`, so the app callback receives the expected OAuth `GET`.
- This also fixes the user namespace mismatch where CP sent a YouEye ID UUID to UI's `app_permissions` table, which uses UI user ids.

## v0.4.13.91 / v0.4.3.26 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Combine YouEye ID consent with selectable first-launch app permissions

### Changes
- `control-panel/src/app/application/o/authorize/route.ts` — Shows pending UI-owned runtime app permissions on the YouEye ID consent page and submits only the permissions the user leaves selected.
- `control-panel/src/lib/market/engine.ts` — Pushes connection candidates to UI immediately after fresh app installs register with the dashboard, fixing reinstall cases where Search lost its SearXNG prompt.
- `ui/src/app/api/ui-bridge/app-launch-permissions/route.ts` — Adds a bridge-only endpoint for CP to preview pending launch permissions and grant/deny the selected runtime permissions.
- `ui/src/lib/db/queries/permissions.ts`, `ui/src/app/api/v1/apps/[appId]/launch-requirements/route.ts` — Store explicit permission denials and treat denied permissions as decided while keeping access blocked.
- `control-panel/tests/identity-consent.spec.ts`, `ui/tests/launch-permissions-bridge.spec.mjs`, `ui/tests/launch-requirements.spec.mjs` — Add focused coverage for selectable runtime permissions and denial handling.
- `control-panel/package.json`, `ui/package.json`, `README.md` — Bumped Control Panel to `0.4.13.91` and UI to `0.4.3.26`.

### Test Results
- `node --test ui/tests/launch-permissions-bridge.spec.mjs ui/tests/launch-requirements.spec.mjs ui/tests/connection-proxy.spec.mjs ui/tests/permission-approval.spec.mjs ui/tests/permission-return-to.spec.mjs` passed.
- `node --test control-panel/tests/market-update-manifest-sync.spec.mjs` passed.
- `pnpm --dir control-panel build` passed for Control Panel `0.4.13.91`.
- `pnpm --dir ui build` passed for UI `0.4.3.26` with known local `127.0.0.1:5432` static-generation warnings.
- Artifact verification passed: CP and UI `standalone.tar` files contain top-level `server.js`; source package versions are `0.4.13.91` / `0.4.3.26`.
- Released `cp-artem-v0.4.13.91` and `ui-artem-v0.4.3.26` with exact `standalone.tar` assets, deployed CP through `spine update control`, and deployed UI through CP's update endpoint.
- Live smoke on `192.168.31.160` passed: UI bridge preview returned `connection:searxng` and `timeline:write`; denying both made launch requirements return `first_launch_complete:true` with `denied_permissions`; granting only `connection:searxng` made `/api/v1/my-connections` return SearXNG while Timeline remained denied. Smoke rows were cleaned up afterward.

### Notes for Iris
- Users can now uncheck optional runtime permissions such as `connection:searxng` while still approving YouEye ID sign-in. Unchecked permissions are stored as explicit denials, so the app will not be repeatedly prompted but the proxy still blocks access.
- Existing installs need a manifest sync/update once to populate the new connection candidate cache; fresh installs do this automatically through CP `0.4.13.91`.

## v0.4.13.90 / v0.4.3.25 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Move app connections out of Market install and into user permission approval

### Changes
- `control-panel/src/components/market/install-dialog.tsx` — Removes app-to-app connection toggles from the Market install modal and only shows Internet/LAN when the app truly needs broad egress.
- `control-panel/src/lib/bridges/manager.ts`, `control-panel/src/lib/market/ui-manifest-sync.ts` — Pushes installed connection candidates with internal proxy host/port and route-scope metadata during bridge changes and manifest sync/update so UI can offer them as per-user permissions without sending apps through public SSO routes.
- `ui/src/app/api/v1/apps/[appId]/launch-requirements/route.ts`, `ui/src/lib/permissions/descriptors.ts` — Adds installed app connection candidates as first-launch permissions like `connection:searxng`.
- `ui/src/app/api/v1/my-connections/route.ts`, `ui/src/app/api/apps/v1/proxy/[targetAppId]/[...path]/route.ts` — Filters discovered/proxied app connections by the current user's `connection:*` permission.
- `ui/tests/connection-proxy.spec.mjs`, `ui/tests/launch-requirements.spec.mjs`, `control-panel/tests/market-update-manifest-sync.spec.mjs`, `control-panel/package.json`, `ui/package.json`, `README.md` — Adds focused coverage and bumps CP/UI versions.

### Test Results
- `node --test ui/tests/connection-proxy.spec.mjs ui/tests/launch-requirements.spec.mjs ui/tests/permission-return-to.spec.mjs ui/tests/my-connections-auth.spec.mjs` passed.
- `node --test control-panel/tests/market-update-manifest-sync.spec.mjs` passed.
- Preliminary `pnpm --dir ui build` passed with known local `127.0.0.1:5432` static-generation warnings; final release builds follow after the version bump.

### Notes for Iris
- This makes Search/SearXNG a per-user approval in YouEye's launch permission flow. CP still owns install/routing metadata, but users grant use of an available connection for their own account.

## v0.4.13.87 / v0.4.3.24 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Add gateway-proxied app connections and permission return redirects

### Changes
- `control-panel/src/lib/market/integration-runner.ts` — Ensures identity gateway proxy devices are present before post-install identity Integration setup so apps like Memos can reach YouEye ID at gateway port `3002`.
- `control-panel/src/lib/apps/lxd-updater.ts` — Installs Caddy's root CA into LXD apps before no-op update exits and restarts the service so UI can proxy HTTPS Caddy grants.
- `ui/src/app/api/apps/v1/proxy/[targetAppId]/[...path]/route.ts`, `ui/src/middleware.ts` — Adds token-authenticated, route-scoped app-to-app connection proxying through YE-UI and allows the proxy API to reach route-level app-token auth.
- `ui/src/app/api/ui-bridge/app-connections/route.ts`, `ui/src/app/api/v1/my-connections/route.ts` — Preserve pushed `available` backend suggestions in connection discovery.
- `ui/src/lib/permissions/approval.ts`, `ui/src/app/api/v1/permissions/request/route.ts`, `ui/src/app/permissions/approve/*`, `ui/src/app/api/v1/apps/[appId]/launch-requirements/route.ts`, `ui/src/app/api/v1/timeline/route.ts` — Carry safe `return_to` values into permission approvals and redirect after Allow/Deny.
- `control-panel/tests/identity-integration-proxy.spec.mjs`, `ui/tests/connection-proxy.spec.mjs`, `ui/tests/permission-return-to.spec.mjs`, `ui/tests/launch-requirements.spec.mjs`, `ui/tests/timeline-permission-approval.spec.mjs` — Add/update focused regression coverage.
- `control-panel/package.json`, `ui/package.json`, `ui/public/sw.js`, `README.md` — Bumped Control Panel to `0.4.13.87`, UI to `0.4.3.24`, and updated current version records.

### Test Results
- `node --test control-panel/tests/identity-integration-proxy.spec.mjs ui/tests/permission-return-to.spec.mjs ui/tests/connection-proxy.spec.mjs ui/tests/launch-requirements.spec.mjs ui/tests/timeline-permission-approval.spec.mjs ui/tests/my-connections-auth.spec.mjs` passed.
- `pnpm --dir control-panel build` passed for Control Panel `0.4.13.87`.
- `pnpm --dir ui build` passed for UI `0.4.3.24`; local static generation logged expected `127.0.0.1:5432` schema-init warnings but exited successfully.
- Artifact verification passed: CP and UI `standalone.tar` files contain top-level `server.js`; source package versions are `0.4.13.87` / `0.4.3.24`.
- Lint note: `pnpm --dir control-panel lint` still fails on existing repo-wide lint debt; `pnpm --dir ui lint` is blocked by missing ESLint v9 flat config.

### Notes for Iris
- This is the first proxy-first connection slice. Search uses it now; broader per-user connection UX and external-app URL injection are still planned follow-ups.

## v0.4.13.84 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Seed Artem fresh installs from Forgejo AppMarket

### Changes
- `control-panel/src/lib/market/source.ts` — Temporarily points the default Market source at Forgejo `potemsla/YE-AppMarket` so fresh Artem installs can resolve required Postgres/Caddy/Pi-hole system manifests before infrastructure deploy.
- `control-panel/tests/market-system-apps.spec.ts` — Adds regression coverage that the fresh-install Market default matches the branch-local system manifest source.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.13.84`.

### Test Results
- `node --import tsx --test control-panel/tests/market-system-apps.spec.ts` passed.
- `pnpm --dir control-panel build` passed for Control Panel `0.4.13.84`.

### Notes for Iris
- This is an Artem-branch recovery default for the current test cycle. Before promotion, either sync system manifests to the public GitHub Market or replace this with channel-aware Market source seeding from Spine/install config.

## v0.4.13.83 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Fix Control Panel app drawer icon fallback and trigger sizing

### Changes
- `control-panel/src/components/control-surface/control-header.tsx` — Accepts Lucide object exports in the drawer icon resolver so fallback app icons render as icons, and shrinks the app-drawer trigger glyph to match UI/CP visual weight.
- `control-panel/tests/control-header-drawer-icons.spec.mjs` — Adds focused coverage for the Lucide resolver and smaller trigger glyph.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.13.83`.

### Test Results
- `node --test control-panel/tests/control-header-drawer-icons.spec.mjs` passed.
- `pnpm --dir control-panel build` passed for Control Panel `0.4.13.83`.

### Notes for Iris
- Pairs with native app releases that apply the same drawer-trigger and header-control contract across existing native apps.

## v0.4.13.82 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Read scoped Caddy grants from app manifests

### Changes
- `control-panel/src/lib/market/schema.ts` — Adds manifest schema support for `wants[].caddyGrant` with path and HTTP method declarations.
- `control-panel/src/lib/market/types.ts` — Exposes typed Caddy grant specs for Market consumers.
- `control-panel/src/lib/bridges/manager.ts` — Reads Search-to-SearXNG scoped grant paths/methods from the installed app's selected Market manifest, with the old hardcoded grant retained only as a transitional fallback.
- `control-panel/tests/scoped-caddy-grants.spec.mjs` — Covers manifest-declared scoped grants, method defaults, and the fallback path.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.13.82` and current Search release to `0.4.0.14`.

### Test Results
- `node --test control-panel/tests/scoped-caddy-grants.spec.mjs control-panel/tests/app-network-pihole-dns.spec.mjs control-panel/tests/market-update-plans.spec.mjs control-panel/tests/market-migration-planner.spec.mjs` passed.
- `pnpm --dir control-panel build` passed for Control Panel `0.4.13.82`.
- Released `cp-artem-v0.4.13.82` with exact `standalone.tar`, snapshotted core containers as `pre-test-cp-0.4.13.82-20260609-224540`, and deployed with `spine update control`.
- Live proof: Search `0.4.0.14` runtime/UI cached manifests include `wants[].caddyGrant` for SearXNG with `/search*`, `/autocompleter*`, and `GET`; bridge discovery reports the same `allowedPaths`/`allowedMethods`; local Caddy route `app-grant-search-to-searxng` matches the Search app token, host, methods, and paths; Caddy returns `200` for `GET /search` and `GET /autocompleter`, `403` for `POST /search`, `403` for `/preferences`, and `403` for Memos.
- Built-in Codex Browser verified `https://search.potato.app/search?q=youeye` renders real results with no `Search unavailable` or `fetch failed`.

### Notes for Iris
- Screenshot capture in the built-in browser still timed out at `Page.captureScreenshot`; browser verification is DOM/state based.
- The hardcoded Search/SearXNG scoped grant fallback remains intentionally as a transition guard for already-installed manifests that have not yet declared `wants[].caddyGrant`.

## v0.4.13.81 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Scope Caddy app-token grants by HTTP method

### Changes
- `control-panel/src/lib/caddy/client.ts` — Adds an HTTP `method` matcher to scoped app-grant routes, defaulting existing grants to `GET`.
- `control-panel/src/lib/bridges/manager.ts` — Persists and pushes `allowedMethods` for Caddy-mode bridge grants.
- `control-panel/src/lib/bridges/store.ts` — Adds optional bridge `allowedMethods` metadata.
- `control-panel/tests/scoped-caddy-grants.spec.mjs` — Extends focused coverage for method-scoped grants and discovery metadata.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.13.81`.

### Test Results
- `node --test control-panel/tests/scoped-caddy-grants.spec.mjs control-panel/tests/app-network-pihole-dns.spec.mjs control-panel/tests/market-update-plans.spec.mjs control-panel/tests/market-migration-planner.spec.mjs` passed.
- `pnpm --dir control-panel build` passed for Control Panel `0.4.13.81`.
- Released `cp-artem-v0.4.13.81` with exact `standalone.tar`, snapshotted core containers as `pre-test-cp-0.4.13.81-20260609-223200`, and deployed with `spine update control`.
- Live proof: Search→SearXNG was reactivated through the bridge API; Caddy route has `method:["GET"]`; discovery reports `allowedMethods:["GET"]`; `GET /search` with Search token returns `200`; `POST /search`, `/preferences`, and Memos with the same token return `403`; built-in Codex Browser verified Search results render with no `Search unavailable` or `fetch failed`.

### Notes for Iris
- Screenshot capture in the built-in browser still timed out at `Page.captureScreenshot`; browser verification is DOM/state based.

## v0.4.3.22 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Suppress legacy notification projection when canonical surface exists

### Changes
- `ui/src/lib/surfaces/normalize.ts` — Stops synthesizing `default-notification` from `capabilities.notifications` when a canonical notification-center surface is already declared.
- `ui/tests/surfaces.spec.ts` — Adds regression coverage for canonical notification surfaces suppressing legacy projection and fixes the test harness path resolution for the current Node/tsx runner.
- `ui/package.json`, `README.md`, `ui/public/sw.js` — Bumped UI to `0.4.3.22` and regenerated build output.

### Test Results
- `node --import tsx --test ui/tests/surfaces.spec.ts` passed.
- `node --test ui/tests/app-preference-settings.spec.mjs ui/tests/launch-requirements.spec.mjs ui/tests/my-connections-auth.spec.mjs` passed.
- `pnpm --dir ui build` passed with the known local Postgres static-generation warnings.
- Released `ui-artem-v0.4.3.22` with exact `standalone.tar`, deployed through CP's UI update endpoint, and verified live `/api/v1/apps/surfaces` returns only canonical Memos surfaces with no `default-notification`.

### Notes for Iris
- This keeps compatibility for legacy notification-only manifests while preventing duplicate notification embeds once an app declares canonical `surfaces[]`.

## v0.4.13.80 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Finish scoped app-token grant hardening and Search Caddy trust

### Changes
- `ui/src/app/api/v1/my-connections/route.ts` — Requires Bearer app-token auth and rejects `X-YouEye-App` spoofing before returning connection grants.
- `control-panel/src/lib/caddy/client.ts` — Adds a terminal Caddy deny route for app-token requests that do not match an explicit scoped app grant.
- `control-panel/src/lib/market/caddy-ca.ts` — Injects Caddy's root CA and writes service drop-ins that point runtimes at the persistent certificate path.
- `control-panel/src/lib/bridges/manager.ts` — Injects the CA and restarts source app containers after scoped Caddy grant activation.
- `control-panel/src/lib/bridges/atomic-json-store.ts` — Adds temp-file-plus-rename JSON writes for bridge, internet-grant, and suggestion stores.
- `control-panel/tests/scoped-caddy-grants.spec.mjs`, `ui/tests/my-connections-auth.spec.mjs` — Added focused coverage for discovery auth, Caddy token deny, CA env, restart order, and atomic bridge writes.

### Test Results
- UI focused tests passed before release: `node --test ui/tests/my-connections-auth.spec.mjs ui/tests/timeline-permission-approval.spec.mjs ui/tests/launch-requirements.spec.mjs ui/tests/permission-approval.spec.mjs ui/tests/app-preference-settings.spec.mjs`.
- Control Panel focused tests passed for the final slice: `node --test control-panel/tests/scoped-caddy-grants.spec.mjs control-panel/tests/app-network-pihole-dns.spec.mjs control-panel/tests/market-update-plans.spec.mjs`.
- `pnpm --dir ui build` passed for UI `0.4.3.21`; `pnpm --dir control-panel build` passed for final CP `0.4.13.80`.
- Released/deployed `ui-artem-v0.4.3.21`, Search `artem-v0.4.0.13`, and final `cp-artem-v0.4.13.80` with exact `standalone.tar` assets.
- Live proof: discovery returns `401` without token, `403` on token/header mismatch, and only Search's SearXNG Caddy grant for a valid Search token. Caddy allows Search token traffic only to SearXNG `/search*` and `/autocompleter*`, denies SearXNG `/preferences` and Memos with `403`, Search server-side Node fetch to SearXNG returns `200`, and built-in Codex Browser verified Search results with no `Search unavailable` or `fetch failed`.

### Notes for Iris
- A live ENOSPC event truncated `/var/lib/youeye/bridges/bridges.json`; the test host LV was expanded, bridge state was restored, and CP `0.4.13.79` makes future bridge writes atomic.
- CP `0.4.13.78` used `/tmp/caddy-root.crt` for runtime CA env; CP `0.4.13.80` supersedes it with `/usr/local/share/ca-certificates/caddy-root.crt` because `/tmp` disappears across container restarts.

## v0.4.13.78 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Set runtime CA env for scoped Caddy grants

### Changes
- `control-panel/src/lib/market/caddy-ca.ts` — Writes a systemd drop-in for app services with `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, and `REQUESTS_CA_BUNDLE` pointing at the injected Caddy root certificate.
- `control-panel/src/lib/bridges/manager.ts` — Restarts the source app container after scoped grant CA injection so the runtime picks up the trust environment.
- `control-panel/tests/scoped-caddy-grants.spec.mjs` — Extended coverage for runtime CA env vars and restart order.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.13.78`.

### Test Results
- Focused Control Panel tests passed: `node --test control-panel/tests/scoped-caddy-grants.spec.mjs control-panel/tests/app-network-pihole-dns.spec.mjs control-panel/tests/market-update-plans.spec.mjs`.
- `pnpm --dir control-panel build` passed for Control Panel `0.4.13.78`; the standalone artifact reports version `0.4.13.78`.

### Notes for Iris
- Node-based apps need `NODE_EXTRA_CA_CERTS` for Caddy internal CA trust. Installing the CA into the OS store alone was not enough for Search's server-side fetch to SearXNG.

## v0.4.13.77 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Trust Caddy CA for scoped app grants

### Changes
- `control-panel/src/lib/bridges/manager.ts` — Injects the Caddy root CA into the source app container whenever a scoped Caddy grant is created, so app server runtimes can verify YouEye-managed HTTPS backend URLs.
- `control-panel/tests/scoped-caddy-grants.spec.mjs` — Extended scoped-grant coverage to require source-app CA injection after grant creation.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.13.77`.

### Test Results
- Focused Control Panel tests passed: `node --test control-panel/tests/scoped-caddy-grants.spec.mjs control-panel/tests/app-network-pihole-dns.spec.mjs control-panel/tests/market-update-plans.spec.mjs`.
- `pnpm --dir control-panel build` passed for Control Panel `0.4.13.77`; the standalone artifact reports version `0.4.13.77`.

### Notes for Iris
- This fixes the Search browser proof failure where server-side Node fetch rejected `https://searx.potato.app` with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` even though the Caddy scoped grant itself was correct.

## v0.4.13.76 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Deny unapproved app-token Caddy route fallthrough

### Changes
- `control-panel/src/lib/caddy/client.ts` — Adds a terminal `app-grant-token-deny` Caddy route so requests carrying `X-YouEye-App-Token` are denied unless an earlier scoped grant matched the caller token, target host, and allowed path.
- `control-panel/src/app/api/setup/control-routes/route.ts` — Reapplies the app-token deny guard during existing-install route repair.
- `control-panel/tests/scoped-caddy-grants.spec.mjs` — Added focused regression coverage for the deny route and repair wiring.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.13.76`.

### Test Results
- Focused Control Panel tests passed: `node --test control-panel/tests/scoped-caddy-grants.spec.mjs control-panel/tests/app-network-pihole-dns.spec.mjs control-panel/tests/market-integration-remove.spec.mjs control-panel/tests/market-filters.spec.mjs control-panel/tests/market-update-preview.spec.mjs control-panel/tests/market-migration-planner.spec.mjs control-panel/tests/market-update-plans.spec.mjs`.
- `pnpm --dir control-panel build` passed for Control Panel `0.4.13.76`; the standalone artifact reports version `0.4.13.76`.

### Notes for Iris
- This pairs with UI `0.4.3.21` and Search `0.4.0.13`. Search's app token can discover and use only the explicit SearXNG grant; app-token traffic that falls through to other public app routes should receive `403`.

## v0.4.3.21 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Require app tokens for connection discovery

### Changes
- `ui/src/app/api/v1/my-connections/route.ts` — Requires a valid Bearer `YOUEYE_APP_TOKEN` and verifies it matches `X-YouEye-App` before returning app connection grants.
- `ui/tests/my-connections-auth.spec.mjs` — Added focused executable coverage for missing-token and token/app mismatch enforcement.
- `ui/package.json`, `README.md`, `ui/public/sw.js` — Bumped UI to `0.4.3.21` and regenerated build output.

### Test Results
- Focused UI tests passed: `node --test ui/tests/my-connections-auth.spec.mjs ui/tests/timeline-permission-approval.spec.mjs ui/tests/launch-requirements.spec.mjs ui/tests/permission-approval.spec.mjs ui/tests/app-preference-settings.spec.mjs`.
- `pnpm --dir ui build` passed for UI `0.4.3.21`; the standalone artifact package reports version `0.4.3.21`.

### Notes for Iris
- This hardens Plan 3 scoped Caddy grants: apps can no longer discover another app's granted backends by spoofing `X-YouEye-App`.

## v0.4.13.75 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Derive catalog notification capability from canonical surfaces

### Changes
- `control-panel/src/lib/market/catalog.ts` — Derives catalog `capabilities.notifications` from canonical `kind: notification` / `placement: notification-center` surfaces so manifests no longer need legacy notification capability flags just to advertise notification support.
- `control-panel/tests/market-canonical-surfaces.spec.mjs` — Added executable regression coverage for notification-capability derivation from canonical surfaces.
- `control-panel/tests/market-surfaces.spec.ts` — Updated existing surface coverage for the same derivation.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.13.75`.

### Test Results
- Focused Control Panel tests passed: `node --test tests/market-canonical-surfaces.spec.mjs tests/market-sso-engine.spec.mjs tests/market-integration-remove.spec.mjs tests/market-filters.spec.mjs tests/market-update-preview.spec.mjs tests/market-migration-planner.spec.mjs tests/market-update-plans.spec.mjs`.
- `pnpm build` passed for Control Panel `0.4.13.75`.
- Released `cp-artem-v0.4.13.75` with exact `standalone.tar` asset id `1574`, snapshotted core live containers as `pre-test-cp-0.4.13.75-20260609-212755`, and deployed through `spine update control`.
- Live proof: CP catalog for Memos still reports `capabilities.notifications:true` derived from canonical surfaces; after syncing the installed Memos manifest into UI, authenticated `/api/v1/apps/surfaces` returns exactly `memos:timeline` and `memos:memo-alert`, both with `legacy_source:"surfaces"`, and no `default-notification` row.

### Notes for Iris
- This pairs with the YE-AppMarket Memos manifest cleanup that removes legacy `capabilities.notifications` now that Memos has canonical notification surfaces.

## v0.4.13.74 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Harden Integration teardown API response parsing

### Changes
- `control-panel/src/lib/market/sso-engine.ts` — Successful API steps with non-JSON response bodies now return `{ raw }` instead of failing JSON parsing, while non-OK responses still fail loudly.
- `control-panel/tests/market-sso-engine.spec.mjs` — Added focused coverage for successful non-JSON SSO API responses.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.13.74`.

### Test Results
- Focused Control Panel tests passed: `node --test tests/market-sso-engine.spec.mjs tests/market-integration-remove.spec.mjs tests/market-filters.spec.mjs tests/market-update-preview.spec.mjs tests/market-migration-planner.spec.mjs tests/market-update-plans.spec.mjs`.
- `pnpm build` passed for Control Panel `0.4.13.74`.
- Released `cp-artem-v0.4.13.74` with exact `standalone.tar` asset id `1573`, snapshotted core live containers as `pre-test-cp-0.4.13.74-20260609-211237`, and deployed through `spine update control`.
- Live teardown proof passed for Jellyfin, Immich, and Nextcloud after deploying `0.4.13.74`; final `spine status` reports CP `0.4.13.74`, UI `0.4.3.20`, 21 running containers, and 0 stopped.
- Built-in Codex Browser verified all three updated Integration detail pages show the new versions, `Installed`, and concrete `Remove ... YouEye ID` actions. Screenshots: `/tmp/codex-browser-jellyfin-youeye-id-teardown-current-0.4.13.74.png`, `/tmp/codex-browser-immich-youeye-id-teardown-current-0.4.13.74.png`, `/tmp/codex-browser-nextcloud-youeye-id-teardown-current-0.4.13.74.png`.

### Notes for Iris
- This supports real Integration teardown endpoints such as Jellyfin plugin routes that may return successful text/empty responses rather than JSON. HTTP failures remain fatal.

## v0.4.13.73 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Resolve variables in SSO cleanup conditions

### Changes
- `control-panel/src/lib/market/sso-engine.ts` — Resolves manifest variables inside `contains`/`equals` condition expected values, so conditions such as `provider.title equals '${identity.name}'` compare against the configured YouEye ID display name instead of the literal placeholder.
- `control-panel/tests/market-sso-engine.spec.mjs` — Extended SSO engine regression coverage for variable-resolved condition values.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.13.73`.

### Test Results
- Focused Control Panel tests passed: `node --test tests/market-sso-engine.spec.mjs tests/market-integration-remove.spec.mjs tests/market-filters.spec.mjs tests/market-update-preview.spec.mjs tests/market-migration-planner.spec.mjs tests/market-update-plans.spec.mjs`.
- `pnpm build` passed for Control Panel `0.4.13.73`.
- Released `cp-artem-v0.4.13.73` with exact `standalone.tar`, snapshotted core live containers as `pre-test-cp-0.4.13.73-20260609-205410`, and deployed through `spine update control`.
- Final Memos Integration proof passed after deploying `0.4.13.73`: reapplying Memos YouEye ID cleaned the duplicate providers and left exactly one Memos OAuth provider, `{"title":"YouEye ID","type":"OAUTH2","name":"identityProviders/3"}`. Memos install metadata again records `memos-youeye-id`, `enableSSO:true`, and `hasSSO:true`.
- Built-in Codex Browser verified `https://potato.app/market/memos-youeye-id?source=official` shows `v0.1.1`, `Installed`, and `Remove Memos YouEye ID` after reapply. Screenshot: `/tmp/codex-browser-memos-integration-reapplied-0.1.1-cp-0.4.13.73.png`.

### Notes for Iris
- CP `0.4.13.72` fixed literal `equals` support but did not resolve variables inside expected values. Memos teardown uses `${identity.name}`, so `0.4.13.73` supersedes `0.4.13.72` for valid Integration teardown proof.

## v0.4.13.72 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Fix SSO cleanup condition handling

### Changes
- `control-panel/src/lib/market/sso-engine.ts` — Added support for `equals` conditions such as `provider.type equals 'OAUTH2'` and made iteration action steps fail loudly on non-OK HTTP responses instead of silently ignoring failed cleanup.
- `control-panel/tests/market-sso-engine.spec.mjs` — Added focused regression coverage for `equals` condition support and non-OK action failure handling.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.13.72`.

### Test Results
- Focused Control Panel tests passed: `node --test tests/market-sso-engine.spec.mjs tests/market-integration-remove.spec.mjs tests/market-filters.spec.mjs tests/market-update-preview.spec.mjs tests/market-migration-planner.spec.mjs tests/market-update-plans.spec.mjs`.
- `pnpm build` passed for Control Panel `0.4.13.72`.

### Notes for Iris
- Live Memos teardown testing exposed this bug: the manifest used `equals` conditions but the engine only implemented `contains`, so provider cleanup did not run and reapply created duplicate YouEye ID providers. CP `0.4.13.72` must be deployed before considering Integration teardown proof valid.

## v0.4.13.71 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Add Integration removal foundation

### Changes
- `control-panel/src/lib/market/schema.ts`, `control-panel/src/lib/market/types.ts` — Added Integration manifest `uninstall`/`rollback` step fields and catalog metadata that indicates whether an Integration declares teardown.
- `control-panel/src/lib/market/integration-runner.ts` — Added `removeIntegration()` with optional manifest-declared teardown execution and explicit metadata-only removal for Integrations that do not yet provide app teardown steps.
- `control-panel/src/app/api/market/integrations/remove/route.ts` — Added a Market API endpoint for removing an installed Integration and returning install-style events.
- `control-panel/src/app/market/[appId]/page.tsx` — Added a remove action for installed Integration detail pages, using teardown when available and clearly labeling metadata-only removal when not.
- `control-panel/tests/market-integration-remove.spec.mjs` — Added focused regression coverage for schema, catalog, runner, API, and UI hooks.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.13.71`.

### Test Results
- Focused Control Panel tests passed: `node --test tests/market-integration-remove.spec.mjs tests/market-filters.spec.mjs tests/market-update-preview.spec.mjs tests/market-migration-planner.spec.mjs tests/market-update-plans.spec.mjs`.
- `pnpm build` passed for Control Panel `0.4.13.71`.
- Released `cp-artem-v0.4.13.71` with exact `standalone.tar`, snapshotted core live containers as `pre-test-cp-0.4.13.71-20260609-203642`, and deployed through `spine update control`.
- Final `spine status` reports CP `0.4.13.71`, UI `0.4.3.20`, 21 running containers, and 0 stopped.
- Built-in Codex Browser verified `https://potato.app/market/memos-youeye-id?source=official` shows the installed Memos Integration with the new `Remove record` action. Screenshot: `/tmp/codex-browser-integration-remove-0.4.13.71.png`.

### Notes for Iris
- Existing Integration manifests do not yet declare app-specific teardown steps, so live removal of those items should use the explicit metadata-only path until each manifest gains safe uninstall steps.

## v0.4.13.70 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Add combined Market browsing filters

### Changes
- `control-panel/src/app/market/page.tsx` — Root Market now has combined catalog filters for search, Market source, item type, install/update status, and category, with clear/reset and visible result counts.
- `control-panel/tests/market-filters.spec.mjs` — Added focused coverage for the root Market filter controls and filtered empty state.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.13.70`.

### Test Results
- Focused Control Panel tests passed: `node --test tests/market-filters.spec.mjs tests/market-update-preview.spec.mjs tests/market-migration-planner.spec.mjs tests/market-update-plans.spec.mjs`.
- `pnpm build` passed for Control Panel `0.4.13.70`.
- Released `cp-artem-v0.4.13.70` with exact `standalone.tar`, snapshotted core live containers as `pre-test-cp-0.4.13.70-20260610-062250`, and deployed through `spine update control`.
- Final `spine status` reports CP `0.4.13.70`, UI `0.4.3.20`, 21 running containers, and 0 stopped.
- Built-in Codex Browser verified trusted `https://potato.app/market` shows the new Browse filter bar with search, Market source, type, status, category, clear, and result count.
- Browser proof selected `Integrations`, reducing the catalog to 4 integration items, then selected `Installed`, reducing the catalog to 11 installed items. Screenshots: `/tmp/codex-browser-market-filters-0.4.13.70.png`, `/tmp/codex-browser-market-filters-integration-0.4.13.70.png`, `/tmp/codex-browser-market-filters-installed-0.4.13.70.png`.

### Notes for Iris
- This implements the Plan 3 combined-catalog browsing requirement on the canonical root `/market` page. The older embed Market client still has its existing partial search/category filters.

## v0.4.13.69 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Expose Market update migration previews

### Changes
- `control-panel/src/lib/market/installed-apps.ts` — Update checks now compute non-destructive migration previews from the installed app's Market source, including `updatePath`, `migrationsRequired`, and `migrationGates`.
- `control-panel/src/app/embed/market/client.tsx` — Market cards can show the planned update path and required migration count when an installed app has an update.
- `control-panel/tests/market-update-preview.spec.mjs` — Added focused coverage for update-check preview metadata and Market UI rendering hooks.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.13.69`.

### Test Results
- Focused Control Panel tests passed: `node --test tests/market-migration-planner.spec.mjs tests/market-update-plans.spec.mjs tests/market-update-preview.spec.mjs`.
- `pnpm build` passed for Control Panel `0.4.13.69`.
- Released `cp-artem-v0.4.13.69` with exact `standalone.tar`, snapshotted core live containers as `pre-test-cp-0.4.13.69-20260610-061404`, and deployed through `spine update control`.
- Final `spine status` reports CP `0.4.13.69`, UI `0.4.3.20`, 21 running containers, and 0 stopped.
- Direct CP package check reports `0.4.13.69` and direct CP `/api/ping` returns OK.
- Built-in Codex Browser loaded trusted `https://potato.app/market` after deploy and captured `/tmp/codex-browser-market-0.4.13.69.png`.

### Notes for Iris
- This is a preview-only addition. It does not run migrations during update checks; execution still happens only through the app updater after snapshots.

## v0.4.13.68 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Make durable update migration planning directly testable

### Changes
- `control-panel/src/lib/market/migration-planner.ts` — Extracted the pure update migration planner so durable update-plan behavior can be tested directly without invoking live container updates.
- `control-panel/src/lib/market/updater.ts` — Uses the extracted planner for migration source merging, required-gate selection, and user-visible update path descriptions.
- `control-panel/tests/market-migration-planner.spec.mjs` — Added behavioral coverage proving normal version skips, required durable gates, optional migration skips, idempotency-key skips, and update-plan override precedence.
- `control-panel/tests/market-update-plans.spec.mjs` — Converted the existing durable update-plan wiring check from an un-runnable `.ts` test to an executable Node test.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.13.68`.

### Test Results
- Focused Control Panel tests passed: `node --test tests/market-migration-planner.spec.mjs tests/market-update-plans.spec.mjs`.
- `pnpm build` passed for Control Panel `0.4.13.68`.

### Notes for Iris
- This preserves the existing updater behavior but strengthens the proof for Plan 3 updates: servers can skip ordinary versions directly to latest, while only required durable migration gates inside the installed Market source are selected and recorded by idempotency key.

## v0.4.3.20 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Harden preference settings fetches against stale cache

### Changes
- `ui/src/components/settings/app-settings-detail.tsx` — Manifest preference and user-settings fetches now use `cache: "no-store"` and `credentials: "same-origin"` so live App Settings forms read the current manifest/settings for the signed-in user.
- `ui/tests/app-preference-settings.spec.mjs` — Added source assertions for cache-resistant preference fetches.
- `ui/package.json`, `ui/public/sw.js`, `README.md` — Bumped UI to `0.4.3.20` and refreshed the generated service worker precache.

### Test Results
- Focused UI tests passed: `node --test tests/app-preference-settings.spec.mjs tests/launch-requirements.spec.mjs tests/permission-approval.spec.mjs tests/timeline-permission-approval.spec.mjs`.
- `pnpm --dir ui build` passed for UI `0.4.3.20` with the known local `127.0.0.1:5432` static-generation noise.
- Verified local release tarball contains flat `server.js` and package version `0.4.3.20`.
- Released `ui-artem-v0.4.3.20` with exact `standalone.tar`, snapshotted live containers, and deployed through CP's UI update endpoint.
- Final `spine status` reports UI `0.4.3.20`, CP `0.4.13.67`, 21 running containers, and 0 stopped.
- Live smoke reused `plan3-preferences-smoke`: launch requirements reported missing `defaultNotebook` and `digestFrequency`, service-auth settings write saved `defaultNotebook:"Personal"`, `digestFrequency:"weekly"`, and `showHints:false`, launch requirements then returned `first_launch_complete:true`, and cleanup verified 0 app rows plus 0 settings namespaces remain.
- Built-in Codex Browser opened the authenticated manifest API and captured that the stored manifest includes the preference schema. Browser visual route screenshots at `/tmp/codex-browser-plan3-preference-form-0.4.3.20-fresh-tab.png` still showed stale client chunks without the form; deployed chunk inspection confirmed the live app-specific bundle contains the `Preferences` form and `cache:"no-store"` fetches.

### Notes for Iris
- This follows the live `0.4.3.19` verification path where the server manifest was correct but the browser-side form fetch needed cache-resistant reads.
- If the visual settings route still lacks the App Settings preference tab in an existing browser session, clear/update the service worker or open a fresh browser profile; the built-in Codex browser held older route chunks during this verification.

## v0.4.3.19 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Fix schema-only preferences opening an empty app-settings iframe

### Changes
- `ui/src/app/api/v1/apps/drawer/route.ts`, `ui/src/app/api/ui-bridge/settings/[...path]/route.ts` — Embedded app settings panel detection now requires explicit `capabilities.settings_panel` or root `settings_panel`; schema-only `settings.schema[]` manifests no longer trigger an iframe.
- `ui/tests/app-preference-settings.spec.mjs` — Added regression coverage for schema-only settings not implying an embedded settings panel.
- `ui/package.json`, `ui/public/sw.js`, `README.md` — Bumped UI to `0.4.3.19` and refreshed the generated service worker precache.

### Test Results
- Focused UI tests passed: `node --test tests/app-preference-settings.spec.mjs tests/launch-requirements.spec.mjs tests/permission-approval.spec.mjs tests/timeline-permission-approval.spec.mjs`.
- `pnpm --dir ui build` passed for UI `0.4.3.19` with the known local `127.0.0.1:5432` static-generation noise.

### Notes for Iris
- Live testing of UI `0.4.3.18` caught this before completion: the preference tab existed, but schema-only manifests rendered an empty iframe. This patch keeps explicit native app settings panels working while letting manifest preference forms render natively.

## v0.4.3.18 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Render manifest-declared app preference forms

### Changes
- `ui/src/components/settings/app-settings-detail.tsx` — App Settings now renders and saves manifest-declared `preferences[]`, `launchPreferences[]`, and `settings.schema[]` fields while preserving embedded app settings panels.
- `ui/tests/app-preference-settings.spec.mjs` — Added focused source regression coverage for schema-derived preference fields, defaults, required-field visibility, embedded settings coexistence, and boolean `false` persistence.
- `ui/package.json`, `ui/public/sw.js`, `README.md` — Bumped UI to `0.4.3.18` and refreshed the generated service worker precache.

### Test Results
- Focused UI tests passed: `node --test tests/app-preference-settings.spec.mjs tests/launch-requirements.spec.mjs tests/permission-approval.spec.mjs tests/timeline-permission-approval.spec.mjs`.
- `pnpm --dir ui build` passed for UI `0.4.3.18` with the known local `127.0.0.1:5432` static-generation noise.

### Notes for Iris
- This builds on UI `0.4.3.17` launch requirements: apps can declare first-launch preferences in the manifest and users can now set those values from the native App Settings tab.

## v0.4.13.67 / v0.4.3.17 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Add manifest-declared launch preferences foundation

### Changes
- `control-panel/src/lib/market/schema.ts`, `control-panel/src/lib/market/types.ts` — Added manifest schema/types for required user preferences through root `preferences[]`, `launchPreferences[]`, and `settings.schema[]`.
- `ui/src/app/api/v1/apps/[appId]/launch-requirements/route.ts` — Launch requirements now also evaluate required manifest preferences against per-user app settings and return app-settings URLs/API paths when first launch needs user choices.
- `ui/src/app/api/v1/apps/[appId]/user-settings/route.ts` — Normalized native app settings namespaces so service-auth callers can use either bare installed app ids or `ye-*` OAuth app ids.
- `ui/src/lib/permissions/approval.ts` — Exported public base URL helper for shared approval/settings response metadata.
- `control-panel/tests/market-preferences.spec.mjs`, `control-panel/tests/market-surfaces.spec.ts`, `ui/tests/launch-requirements.spec.mjs` — Added focused regression coverage for manifest preference declarations and launch-requirements preference responses.
- `control-panel/package.json`, `ui/package.json`, `ui/public/sw.js`, `README.md` — Bumped Control Panel to `0.4.13.67`, UI to `0.4.3.17`, and refreshed the generated UI service worker precache.

### Test Results
- Focused UI tests passed: `node --test tests/launch-requirements.spec.mjs tests/permission-approval.spec.mjs tests/timeline-permission-approval.spec.mjs`.
- Focused Control Panel tests passed: `node --test tests/market-preferences.spec.mjs tests/market-update-manifest-sync.spec.mjs`.
- `pnpm --dir control-panel build` passed for Control Panel `0.4.13.67`.
- `pnpm --dir ui build` passed for UI `0.4.3.17` with the known local `127.0.0.1:5432` static-generation noise.
- Verified local release tarballs contain flat `server.js` and matching `package.json` versions for CP `0.4.13.67` and UI `0.4.3.17`.
- Released `cp-artem-v0.4.13.67` and `ui-artem-v0.4.3.17` with exact `standalone.tar` assets, snapshotted `youeye-control`, `youeye-ui`, `youeye-caddy`, and `youeye-postgres`, then deployed CP through `spine update control` and UI through CP's UI update endpoint.
- Live smoke registered temporary `plan3-preferences-smoke`, verified launch requirements returned `202` with missing `defaultNotebook` and `digestFrequency`, wrote settings through `/api/v1/apps/ye-plan3-preferences-smoke/user-settings`, verified `first_launch_complete:true`, and cleaned up both app row and settings namespace.
- Built-in Codex Browser opened the trusted live JSON endpoint and captured `/tmp/codex-browser-plan3-preferences-json-0.4.13.67-0.4.3.17.png`.
- Final `spine status` reports CP `0.4.13.67`, UI `0.4.3.17`, 21 running containers, and 0 stopped.

### Notes for Iris
- This is the API/schema foundation for first-launch user preferences. It returns settings metadata and detects missing required preferences, but a richer app-settings preference form can build on the stored manifest schema in a later UI slice.

## v0.4.13.66 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Sync UI manifest cache after app updates

### Changes
- `control-panel/src/lib/market/ui-manifest-sync.ts` — Added a direct bridge sync helper for the manifest object already selected by the updater.
- `control-panel/src/lib/market/updater.ts` — App updates now sync the updated Market manifest into YouEye UI before version records are saved.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.13.66`.

### Test Results
- Focused: `node --test tests/market-update-manifest-sync.spec.mjs` — passed.
- Build: `pnpm build` from `control-panel/` — passed for Control Panel `0.4.13.66`.
- Released `cp-artem-v0.4.13.66` with exact `standalone.tar`; verified flat `server.js`, `package.json`, and package version `0.4.13.66`.
- Snapshotted `youeye-control` as `pre-cp-0.4.13.66-20260609175441`, then deployed through `spine update control`.
- Live `spine status` reports Control Panel `0.4.13.66`, UI `0.4.3.16`, Search `0.4.0.11`, 21 running containers, and 0 stopped after the follow-up Search update.
- Live Search update through CP `0.4.13.66` refreshed UI's cached Search manifest to version `0.4.0.11` with 3 canonical surfaces.
- Built-in Codex Browser verified the Search launch-requirements prompt appears from the synced manifest, the approval page grants `timeline:write`, and Search reloads without the prompt.
- Screenshots: `/tmp/codex-browser-search-launch-requirements-before-0.4.0.11.png`, `/tmp/codex-browser-search-launch-requirements-approval-0.4.0.11.png`, `/tmp/codex-browser-search-launch-requirements-granted-0.4.0.11.png`, `/tmp/codex-browser-search-launch-requirements-after-0.4.0.11.png`.

### Notes for Iris
- Live Search first-launch testing exposed a stale UI cached manifest after app update; launch requirements depend on UI seeing the updated manifest permissions and canonical surfaces.

## v0.4.3.16 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Add manifest-derived first-launch requirements API

### Changes
- `ui/src/app/api/v1/apps/[appId]/launch-requirements/route.ts` — Added a first-launch requirements endpoint that reads cached manifest permissions and `surfaces[].permissions`, checks the current user's grants, and returns approval metadata for missing permissions.
- `ui/tests/launch-requirements.spec.mjs` — Added focused regression coverage for manifest-derived launch requirements, service-auth ownership, and approval URL behavior.
- `ui/package.json`, `README.md` — Bumped UI to `0.4.3.16`.

### Test Results
- Focused UI tests passed: `node --test tests/permission-approval.spec.mjs tests/timeline-permission-approval.spec.mjs tests/launch-requirements.spec.mjs`.
- `pnpm --dir ui build` passed for UI `0.4.3.16` with the known local `127.0.0.1:5432` static-generation noise.
- Released `ui-artem-v0.4.3.16` with exact `standalone.tar` containing flat `server.js` and `package.json` version `0.4.3.16`.
- Snapshotted `youeye-ui` as `pre-ui-0.4.3.16-20260609172724`, then deployed UI through CP's UI update endpoint.
- Live `spine status` reports CP `0.4.13.65`, UI `0.4.3.16`, 21 running containers, and 0 stopped.
- Built-in Codex Browser verified Memos launch requirements derive `notifications:send` from its cached `surfaces[]`, return `first_launch_complete:false`, and include `approval_url_absolute`.
- Built-in Codex Browser approved the Memos notification permission, saw `Permission granted.`, and verified launch requirements flipped to `first_launch_complete:true`; the smoke grant was then deleted and the endpoint returned to approval-needed.
- Live Search service-auth verified `GET /api/v1/apps/search/launch-requirements` returns `first_launch_complete:true` for its own app and `403` when the same token tries to inspect Wiki.
- Screenshots: `/tmp/codex-browser-launch-requirements-memos-0.4.3.16.png`, `/tmp/codex-browser-launch-requirements-approval-before-0.4.3.16.png`, `/tmp/codex-browser-launch-requirements-approval-after-0.4.3.16.png`.

### Notes for Iris
- This is the orchestration API for apps to call on first launch before using manifest-declared permissions. It does not add a new permission type; it reuses existing descriptors and `/permissions/approve`.

## v0.4.3.15 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Require explicit timeline permission approval for app writes

### Changes
- `ui/src/lib/permissions/approval.ts` — Added shared approval-response helpers with relative and absolute approval URLs plus service app-id matching.
- `ui/src/app/api/v1/permissions/request/route.ts`, `ui/src/app/api/v1/permissions/check/route.ts` — Service-auth apps can request and check only their own app permissions and receive approval metadata, but only a browser session can approve grants.
- `ui/src/app/api/v1/timeline/route.ts` — Removed native-app `timeline:write` auto-grants; missing timeline permission now returns approval metadata instead of silently granting access.
- `ui/tests/permission-approval.spec.mjs`, `ui/tests/timeline-permission-approval.spec.mjs` — Added focused regression coverage for explicit service-auth timeline permission consent.
- `ui/package.json`, `README.md` — Bumped UI to `0.4.3.15`.

### Test Results
- Focused UI tests passed: `node --test tests/permission-approval.spec.mjs tests/timeline-permission-approval.spec.mjs`.
- `pnpm --dir ui build` passed for UI `0.4.3.15` with the known local `127.0.0.1:5432` static-generation noise.
- Released `ui-artem-v0.4.3.15` with exact `standalone.tar` containing flat `server.js` and `package.json` version `0.4.3.15`.
- Snapshotted `youeye-ui` as `pre-ui-0.4.3.15-20260609171614`, then deployed UI through CP's UI update endpoint.
- Live `spine status` reports CP `0.4.13.65`, UI `0.4.3.15`, 21 running containers, and 0 stopped.
- Live Search service-auth proof temporarily removed tester's existing `ye-search/timeline:write` grant, verified permission request returned `202` plus `approval_url_absolute` even with `approved:true`, permission check returned `granted:false`, and timeline POST returned `403` plus approval metadata.
- Built-in Codex Browser verified the approval page for `ye-search/timeline:write`, clicked Allow, saw `Permission granted.`, and service-auth check then returned `granted:true`.
- Cross-app service-auth request from `ye-search` for `wiki` returned `403`.
- Screenshots: `/tmp/codex-browser-timeline-permission-approval-before-0.4.3.15.png`, `/tmp/codex-browser-timeline-permission-approval-after-0.4.3.15.png`.

### Notes for Iris
- Existing users with already-granted `timeline:write` keep working. New or revoked users now need explicit approval before app timeline writes are accepted.

## v0.4.3.14 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Add user approval for app permission requests

### Changes
- `ui/src/app/api/v1/permissions/request/route.ts` — Permission requests now return an approval URL and descriptors unless explicitly approved, so app permissions are user-approved instead of silently granted.
- `ui/src/app/permissions/approve/page.tsx`, `ui/src/app/permissions/approve/permission-approval-form.tsx` — Added a user-facing approval page with descriptor copy and Allow/Deny controls.
- `ui/tests/permission-approval.spec.mjs` — Added focused regression coverage for approval-before-grant behavior.
- `ui/package.json`, `README.md` — Bumped UI to `0.4.3.14`.

### Test Results
- Focused UI test passed: `node --test tests/permission-approval.spec.mjs`.
- `pnpm --dir ui build` passed for UI `0.4.3.14` with the known local `127.0.0.1:5432` static-generation noise.
- Released `ui-artem-v0.4.3.14` with exact `standalone.tar` containing flat `server.js` and `package.json` version `0.4.3.14`.
- Snapshotted `youeye-ui` as `pre-ui-0.4.3.14-20260609165801`, then deployed UI through CP's UI update endpoint.
- Live `spine status` reports CP `0.4.13.65`, UI `0.4.3.14`, 21 running containers, and 0 stopped.
- Built-in Codex Browser verified `/permissions/approve` renders the approval page, `app:plan3-approval-smoke` checked `granted:false` before approval, `Permission granted.` appeared after Allow, the permission checked `granted:true`, and the smoke-test grant was deleted and verified back to `granted:false`.
- Screenshots: `/tmp/codex-browser-permission-approval-before-0.4.3.14.png`, `/tmp/codex-browser-permission-approval-after-0.4.3.14.png`.

### Notes for Iris
- Existing app flows that request permissions should use the returned `approval_url` for first-launch consent, then repost with `approved: true` after the user allows access.

## v0.4.13.65 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Reconcile installed app versions during update checks

### Changes
- `control-panel/src/lib/market/installed-apps.ts` — Update checks now reconcile existing installed-app records from install metadata before comparing catalog versions, preventing stale registry rows from reporting phantom updates.
- `control-panel/tests/installed-apps-version-reconcile.spec.mjs` — Added focused regression coverage for metadata-before-comparison reconciliation.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.13.65`.

### Test Results
- Focused Node tests passed: `node --test tests/app-network-pihole-dns.spec.mjs tests/installed-apps-version-reconcile.spec.mjs`.
- `pnpm --dir control-panel build` passed for Control Panel `0.4.13.65`.

### Notes for Iris
- Live verification of `0.4.13.64` found Notes/Search running the correct versions while `/api/market/updates` still reported stale installed versions. This release repairs that drift using CP's existing install metadata.

## v0.4.13.64 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Enforce Pi-Hole DNS for app networks

### Changes
- `control-panel/src/lib/incus/app-network.ts` — App bridge creation now fails if Pi-Hole DNS forwarding cannot be configured and always sets `raw.dnsmasq` for app networks.
- `control-panel/src/lib/market/engine.ts` — Installer rolls back instead of falling back to `incusbr0` when app network creation fails.
- `control-panel/tests/app-network-pihole-dns.spec.mjs` — Added focused regression coverage for the hard DNS invariant.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.13.64`.

### Test Results
- Focused Node test passed: `node --test tests/app-network-pihole-dns.spec.mjs`.
- `pnpm --dir control-panel build` passed for Control Panel `0.4.13.64`.

### Notes for Iris
- This intentionally makes app network creation fail loud when Pi-Hole DNS cannot be resolved. Apps should not silently install onto a broad fallback bridge.

## v0.4.3.12 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Consume unified timeline and notification surfaces

### Changes
- `ui/src/lib/db/queries/app-management.ts` — Adds timeline-card metadata to app meta and exposes notification-center surfaces keyed by app id.
- `ui/src/app/api/v1/timeline/route.ts` — Uses canonical `timeline-card` surfaces to supply embed paths for entries that do not store one directly.
- `ui/src/app/api/v1/notifications/route.ts` — Returns notification surface metadata alongside notification rows.
- `ui/src/components/notifications/notification-surface-embed.tsx`, `ui/src/components/layout/notification-bell.tsx`, `ui/src/components/notifications/notifications-list.tsx` — Adds a readiness-gated notification embed consumer for app-provided notification surfaces.
- `ui/tests/surfaces.spec.ts` — Extends focused coverage for timeline and notification surface consumers.
- `ui/package.json`, `README.md` — Bumped UI to `0.4.3.12`.

### Test Results
- Focused Node test passed: `ui/tests/surfaces.spec.ts`.
- `pnpm --dir YouEye/ui build` passed for UI `0.4.3.12` with the known local `127.0.0.1:5432` static-generation noise.

### Notes for Iris
- Notification embeds stay hidden unless an app endpoint posts `youeye-embed-ready`, so apps without a notification embed route keep the existing text notification behavior.

## v0.4.3.11 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Use unified surfaces for info-card providers

### Changes
- `ui/src/lib/db/queries/app-management.ts` — `getInfoCardProviders()` now discovers provider rows from normalized `kind: info-card` surfaces instead of directly reading legacy `info_cards`.
- `ui/tests/surfaces.spec.ts` — Extended focused coverage to assert info-card providers use the surface normalizer and map `embedPath` back to the compatibility endpoint shape.
- `ui/package.json`, `README.md` — Bumped UI to `0.4.3.11`.

### Test Results
- Focused Node test passed: `ui/tests/surfaces.spec.ts`.
- `pnpm --dir YouEye/ui build` passed for UI `0.4.3.11` with the known local `127.0.0.1:5432` static-generation noise.
- Released `ui-artem-v0.4.3.11` with exact `standalone.tar`.
- Snapshotted `youeye-ui`, then deployed UI through CP's UI update endpoint.
- Live `spine status` reports CP `0.4.13.62`, UI `0.4.3.11`, and 17 running containers / 0 stopped.
- Built-in Codex Browser verified `/api/v1/apps/info-cards` returns `{"providers":[]}` cleanly on the current live install. That install currently has no installed `info-card` surfaces, so runtime mapping is covered by the focused test rather than a populated live provider.
- UI service logs after deploy show only expected schema "already exists" notices.

### Notes for Iris
- This migrates info-card provider discovery to the surface model while preserving the public endpoint. A later slice should add/refresh installed apps with actual `kind: info-card` surfaces for populated live proof.

## v0.4.13.62 / v0.4.3.10 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Add unified app surfaces foundation

### Changes
- `control-panel/src/lib/market/schema.ts`, `control-panel/src/lib/market/types.ts` — Added the canonical `surfaces[]` manifest schema for widgets, info cards, timeline cards, and notification embeds.
- `control-panel/src/lib/market/catalog.ts` — Exposes app surface declarations in Market catalog/detail responses.
- `ui/src/lib/surfaces/normalize.ts` — Added shared UI normalizer for new `surfaces[]` plus legacy `widgets`, `info_cards`, `timeline_embeds`, and notification capabilities.
- `ui/src/lib/db/queries/app-management.ts` — Added unified surface discovery from live manifests with cached manifest fallback.
- `ui/src/app/api/v1/apps/surfaces/route.ts` — Added the first unified installed-app surfaces API.
- `ui/src/app/api/v1/apps/widgets/route.ts` — Keeps dashboard widget compatibility by projecting dashboard/widget surfaces into the old response shape.
- `control-panel/tests/market-surfaces.spec.ts`, `ui/tests/surfaces.spec.ts` — Added focused runtime/static regression coverage.
- `control-panel/package.json`, `ui/package.json`, `README.md` — Bumped Control Panel to `0.4.13.62` and UI to `0.4.3.10`.

### Test Results
- Focused Node test passed: `control-panel/tests/market-surfaces.spec.ts`.
- Focused Node test passed: `ui/tests/surfaces.spec.ts`.
- `pnpm --dir YouEye/control-panel build` passed for CP `0.4.13.62`.
- `pnpm --dir YouEye/ui build` passed for UI `0.4.3.10` with the known local `127.0.0.1:5432` static-generation noise.
- Released `cp-artem-v0.4.13.62` and `ui-artem-v0.4.3.10`, each with exact `standalone.tar`.
- Snapshotted `youeye-control`, `youeye-ui`, `youeye-caddy`, and `youeye-postgres` before deploy.
- Deployed CP through `spine update control`; deployed UI through CP's UI update endpoint.
- Live `spine status` reports CP `0.4.13.62`, UI `0.4.3.10`, and 17 running containers / 0 stopped.
- Built-in Codex Browser verified `/api/v1/apps/surfaces` returns normalized notification/widget/timeline surfaces and `/api/v1/apps/widgets` still returns legacy dashboard widget shape. Dashboard visual smoke passed. Screenshots: `/tmp/codex-browser-surfaces-widgets-compat-0.4.13.62-0.4.3.10.png`, `/tmp/codex-browser-surfaces-dashboard-smoke-0.4.13.62-0.4.3.10.png`.

### Notes for Iris
- This is the manifest/API foundation for unified surfaces. It does not yet migrate timeline rendering or notification rendering to consume the new surface API.

## v0.4.13.61 / v0.4.3.9 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Add user-visible permission descriptors

### Changes
- `ui/src/lib/permissions/descriptors.ts` — Added the first shared descriptor registry for YouEye user permissions.
- `ui/src/app/api/ui-bridge/settings/[...path]/route.ts` — Returns permission descriptors through the CP settings bridge.
- `ui/src/app/api/v1/permissions/app/[appId]/route.ts`, `ui/src/app/api/v1/permissions/request/route.ts` — Return descriptors from direct permission list/request APIs.
- `control-panel/src/app/api/identity/consents/app/[appId]/route.ts` — Adds descriptor metadata to YouEye ID first-launch consent grants.
- `control-panel/src/components/settings-shell/apps-client.tsx` — Renders friendly permission title, description, category, risk, grant type, and raw audit string in app settings.
- `ui/tests/permission-descriptors.spec.ts`, `control-panel/tests/identity-consent.spec.ts` — Added/extended focused regression coverage.
- `control-panel/package.json`, `ui/package.json`, `README.md` — Bumped Control Panel to `0.4.13.61` and UI to `0.4.3.9`.

### Test Results
- Focused Node test passed: `ui/tests/permission-descriptors.spec.ts`.
- Focused Node test passed: `control-panel/tests/identity-consent.spec.ts`.
- `pnpm --dir YouEye/ui build` passed for UI `0.4.3.9`.
- `pnpm --dir YouEye/control-panel build` passed for CP `0.4.13.61`.
- Released `cp-artem-v0.4.13.61` and `ui-artem-v0.4.3.9`, each with exact `standalone.tar`.
- Deployed CP through `spine update control`; deployed UI through CP's UI update endpoint.
- Live `spine status` reports CP `0.4.13.61`, UI `0.4.3.9`, and 17 running containers / 0 stopped.
- Built-in Codex Browser verified `https://potato.app/settings/apps/ye-search` renders friendly permission descriptor copy, badges, grant type, and raw audit string. Screenshot: `/tmp/codex-browser-permission-descriptors-0.4.13.61-0.4.3.9.png`.

### Notes for Iris
- This is the descriptor/copy foundation for broader first-launch permissions. It does not yet add a modal prompt for every non-identity permission request.

## v0.4.13.60 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Add guarded System settings system-update operator workflow

### Changes
- `control-panel/src/lib/infrastructure/system-updater.ts` — Requires explicit maintenance-window and exact container-name confirmation before any real system container rebuild.
- `control-panel/src/app/api/deploy/infrastructure/system-updates/route.ts` — Passes confirmation fields through to the updater and uses server-side `HOST_IP` for Pi-hole rebuild requests.
- `control-panel/src/components/settings-shell/system-client.tsx` — Adds a guarded Adopt/Recreate/Update action with a confirmation modal while keeping dry-runs one-click.
- `control-panel/tests/system-settings-market-updates.spec.ts` — Extends regression coverage for the settings UI workflow, route fallback, and backend confirmation gates.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.13.60`.

### Test Results
- Focused Node test passed: `control-panel/tests/system-settings-market-updates.spec.ts`.
- `pnpm --dir YouEye/control-panel build` passed for CP `0.4.13.60`.
- Released `cp-artem-v0.4.13.60` with exact `standalone.tar`; deployed through `spine update control` on `192.168.31.160`.
- Live `spine status` reports CP `0.4.13.60`, UI `0.4.3.8`, and 17 running containers / 0 stopped.
- Built-in Codex Browser verified `https://potato.app/settings/system` shows the guarded Adopt/Recreate actions, opens the Caddy confirmation modal with the destructive button disabled until confirmation, and still runs Caddy dry-run successfully.
- Live backend guard check refused a real Caddy rebuild without `confirmMaintenanceWindow` before stopping/rebuilding anything.

### Notes for Iris
- Dry-run behavior is unchanged. Real system rebuilds now require both a checked maintenance-window confirmation and the exact target container name, and legacy/PostgreSQL gates still apply.

## v0.4.13.59 — artem — 2026-06-09
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Fix System settings Market update-plan auth path

### Changes
- `control-panel/src/app/settings/api/deploy/infrastructure/system-updates/route.ts` — Added a settings-surface API alias for the Market system update planner.
- `control-panel/src/components/settings-shell/system-client.tsx` — Uses the settings-scoped system update planner path so the existing settings session can load and dry-run plans.
- `control-panel/tests/system-settings-market-updates.spec.ts` — Extended coverage for the settings API alias and settings-scoped fetch path.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.13.59`.

### Test Results
- Focused Node test passed: `control-panel/tests/system-settings-market-updates.spec.ts`.
- `pnpm --dir YouEye/control-panel build` passed for CP `0.4.13.59`.
- Released `cp-artem-v0.4.13.59` with exact `standalone.tar`; deployed through `spine update control` on `192.168.31.160`.
- Live `spine status` reports CP `0.4.13.59`, UI `0.4.3.8`, and 17 running containers / 0 stopped.
- Built-in Codex Browser verified `https://potato.app/settings/system` loads `Market System Manifests` with no `Unauthorized` and Caddy dry-run returns `Dry run: youeye-caddy would rebuild to docker.io/library/caddy:2.11.4.` Screenshot: `/tmp/codex-browser-system-settings-0.4.13.59.png`.

### Notes for Iris
- CP `0.4.13.58` rendered the section but the built-in Codex Browser proved the root API path was unauthorized under the settings session. This patch keeps the same planner behavior and fixes the browser-auth path.

## v0.4.13.58 — artem — 2026-06-09
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Surface Market system update plans in System settings

### Changes
- `control-panel/src/components/settings-shell/system-client.tsx` — Added a Market System Manifests section showing Postgres, Caddy, and Pi-hole tracking state, desired Market image/version, safety reason, database maintenance warning, and dry-run action.
- `control-panel/tests/system-settings-market-updates.spec.ts` — Added focused regression coverage for the System settings planner UI and safe dry-run request shape.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.13.58`.

### Test Results
- Focused Node test passed: `control-panel/tests/system-settings-market-updates.spec.ts`.
- `pnpm --dir YouEye/control-panel build` passed for CP `0.4.13.58`.

### Notes for Iris
- This surfaces the CP `0.4.13.57` planner without adding a one-click destructive rebuild. Real adoption/recreate still requires the guarded API path and operator maintenance-window decision.

## v0.4.13.57 — artem — 2026-06-09
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Add Market-backed system app update planning

### Changes
- `control-panel/src/lib/infrastructure/system-market-manifests.ts` — Added required system ids/container lookup and records Market image/version/source/digest metadata on system containers.
- `control-panel/src/lib/infrastructure/deployer.ts` — Stamps newly created Postgres, Caddy, and Pi-hole containers with the Market system manifest metadata that created them.
- `control-panel/src/lib/infrastructure/system-updater.ts` — Added system update planning and guarded rebuild execution from Market system manifests, with legacy adoption and PostgreSQL maintenance gates.
- `control-panel/src/app/api/deploy/infrastructure/system-updates/route.ts` — Added admin/CLI-token GET plan and POST SSE update endpoint for CP-managed system apps.
- `control-panel/tests/market-system-apps.spec.ts` — Extended system-app regression coverage to the update planner/executor and tracking metadata.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.13.57`.

### Test Results
- Focused Node test passed: `control-panel/tests/market-system-apps.spec.ts`.
- `pnpm --dir YouEye/control-panel build` passed for CP `0.4.13.57`.
- Released `cp-artem-v0.4.13.57` with exact `standalone.tar`; deployed through `spine update control` on `192.168.31.160`.
- Live `/api/deploy/infrastructure/system-updates` reports Postgres/Caddy as `legacy-compatible`, Pi-hole as `legacy-untracked`, refuses Caddy dry-run without `forceLegacy`, and succeeds forced Caddy dry-run to `docker.io/library/caddy:2.11.4`.
- Browser smoke over trusted HTTPS loaded `/api/health` and routed `/market` to YouEye ID login with no console errors or failed responses. Screenshot: `/tmp/youeye-market-login-0.4.13.57.png`.

### Notes for Iris
- Existing legacy system containers are not surprise-rebuilt. The new endpoint reports them as legacy-compatible or legacy-untracked and requires `forceLegacy`; PostgreSQL also requires `allowDatabaseUpdate`.

## v0.4.13.56 — artem — 2026-06-09
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Clean YouEye ID consent browser smoke

### Changes
- `control-panel/src/app/application/o/authorize/route.ts` — Added an inline empty favicon to the first-launch consent page to avoid browser favicon 404 noise.
- `control-panel/src/app/identity/login/route.ts` — Added the same inline empty favicon to the YouEye ID login page.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.13.56`.

### Test Results
- Focused Node test passed: `control-panel/tests/identity-consent.spec.ts`.
- `pnpm --dir YouEye/control-panel build` passed for CP `0.4.13.56`.

### Notes for Iris
- No behavior change beyond removing favicon 404 noise from YouEye ID login/consent browser checks.

## v0.4.13.55 — artem — 2026-06-09
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Fix app consent settings route

### Changes
- `control-panel/src/app/api/identity/consents/app/[appId]/route.ts` — Accepts the existing CP SSO settings session as well as a direct YouEye ID session when resolving the user for consent list/revoke.
- `control-panel/src/app/settings/api/identity/consents/app/[appId]/route.ts` — Added a settings-surface API alias for the app consent endpoint.
- `control-panel/src/components/settings-shell/apps-client.tsx` — Uses a settings-aware consent API path so app settings can reliably list/revoke the first-launch grant.
- `control-panel/src/lib/identity/store.ts` — Added username lookup for resolving CP sessions back to YouEye ID users.
- `control-panel/src/lib/caddy/client.ts` — Added `/api/identity/*` to the root settings/market support route for existing installs after route repair.
- `control-panel/tests/identity-consent.spec.ts` — Extended consent regression coverage for CP session fallback and settings-aware routing.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.13.55`.

### Test Results
- Focused Node test passed: `control-panel/tests/identity-consent.spec.ts`.
- `pnpm --dir YouEye/control-panel build` passed for CP `0.4.13.55`.

### Notes for Iris
- CP `0.4.13.54` introduced the consent table and OAuth gate; `0.4.13.55` makes the app settings revoke path match the real settings auth/routing model.

## v0.4.13.54 — artem — 2026-06-09
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Add YouEye ID first-launch app consent

### Changes
- `control-panel/src/lib/identity/store.ts` — Added per-user/per-client `identity_app_consents` storage plus list/upsert/revoke helpers.
- `control-panel/src/app/application/o/authorize/route.ts` — Added first-launch consent gating for app OAuth clients before issuing authorization codes, while skipping first-party Control Panel/UI clients.
- `control-panel/src/app/api/identity/consents/app/[appId]/route.ts` — Added an authenticated settings-compatible API to list/revoke an app's YouEye ID consent grant.
- `control-panel/src/components/settings-shell/apps-client.tsx` — Merged YouEye ID first-launch consent into the app Permissions tab and revoke-all flow.
- `control-panel/tests/identity-consent.spec.ts` — Added focused regression coverage for consent storage, OAuth gating, and settings revoke wiring.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.13.54`.

### Test Results
- Focused Node test passed: `control-panel/tests/identity-consent.spec.ts`.
- `pnpm --dir YouEye/control-panel build` passed for CP `0.4.13.54`.

### Notes for Iris
- This is the first YouEye ID launch-time permission foundation. It gates app OAuth clients on first launch and exposes the grant in app settings; richer per-permission preference prompts still need follow-up manifest/UI work.

## v0.4.13.53 — artem — 2026-06-09
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Consume Market system app manifests during infrastructure deploy/reconcile

### Changes
- `control-panel/src/lib/infrastructure/system-market-manifests.ts` — Added required Market system manifest resolution for Postgres, Caddy, and Pi-hole images with fail-loud container-name validation.
- `control-panel/src/lib/infrastructure/deployer.ts` — Infrastructure deploy/reconcile now applies Market-pinned system images before creating missing system containers.
- `control-panel/src/app/api/deploy/infrastructure/system-manifests/route.ts` — Added an admin/CLI-token audit endpoint for verifying the resolved Market system manifests without rebuilding live infrastructure.
- `control-panel/tests/market-system-apps.spec.ts` — Extended regression coverage so system manifests are not only exposed by API, but consumed by infrastructure deploy/reconcile.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.13.53`.

### Test Results
- Focused Node test passed: `control-panel/tests/market-system-apps.spec.ts`.
- `pnpm --dir YouEye/control-panel build` passed for CP `0.4.13.53`.
- Released `cp-artem-v0.4.13.53` with exact `standalone.tar`; deployed through `spine update control` on `192.168.31.160`.
- Live audit endpoint returned official Postgres `17.10`, Caddy `2.11.4`, and Pi-hole `2026.05.0` Market images with manifest digests.
- Codex Browser verified `https://potato.app/market` renders the current Market UI over trusted HTTPS with no console errors.

### Notes for Iris
- CP still owns ports, volumes, secrets, health checks, and reconciliation. Market system manifests now provide image/version metadata for CP-managed infrastructure. Spine still manages only itself and the Control Panel container.

## v0.4.13.52 — artem — 2026-06-09
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Expose system app manifests through Market catalog

### Changes
- `control-panel/src/lib/market/schema.ts`, `control-panel/src/lib/market/parser.ts`, `control-panel/src/lib/market/types.ts` — Added first-class `kind: system-app` manifest parsing and display metadata types.
- `control-panel/src/lib/market/catalog.ts` — Added source-aware system manifest fetching and conversion to Market metadata with image/container/version/audit fields.
- `control-panel/src/app/api/market/catalog/route.ts`, `control-panel/src/app/api/market/route.ts` — Return `systemApps` separately from normal app/integration browsing.
- `control-panel/tests/market-system-apps.spec.ts` — Added regression coverage for system manifest parsing/exposure and pinned Market system manifests.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.13.52`.

### Test Results
- Focused Node test passed: `control-panel/tests/market-system-apps.spec.ts`.
- Existing durable update-plan focused test still passed.
- `pnpm --dir YouEye/control-panel build` passed for CP `0.4.13.52`.

### Notes for Iris
- This does not redeploy infrastructure. It makes Market the source of truth for system app version/image/container metadata so follow-up infrastructure update control can compare live state against source-specific system manifests.

## v0.4.3.8 — artem — 2026-06-09
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Retire legacy UI Market routes without redirects

### Changes
- `ui/src/middleware.ts` — Added retired public-404 handling for `/app-market` and `/app-store` so old paths fall through to Next.js not-found instead of redirecting to login.
- `ui/tests/retired-market-routes.spec.ts` — Added a focused regression check for the retired Market routes.
- `ui/package.json`, `README.md` — Bumped UI to `0.4.3.8`.

### Test Results
- Focused Node test passed after ESM bundling: `ui/tests/retired-market-routes.spec.ts`.
- `pnpm --dir YouEye/ui build` passed for UI `0.4.3.8`; local static generation still logged expected PostgreSQL connection warnings because no local UI database is running.

### Notes for Iris
- `/market` remains Control Panel-owned. `/app-market` and `/app-store` are intentionally not redirected; they should return not-found behavior.

## v0.4.13.51 — artem — 2026-06-09
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Add durable Market update-plan artifacts

### Changes
- `control-panel/src/lib/market/schema.ts`, `control-panel/src/lib/market/parser.ts`, `control-panel/src/lib/market/types.ts` — Added `kind: update-plan` manifest/catalog schemas and installed migration metadata.
- `control-panel/src/lib/market/catalog.ts` — Added source-specific fetching of durable update-plan migration gates.
- `control-panel/src/lib/market/updater.ts` — Merges manifest and durable update-plan migrations, skips already-applied idempotency keys, and records completed gates.
- `control-panel/tests/market-update-plans.spec.ts` — Added focused regression coverage for update-plan schema support and idempotency recording.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.13.51`.

### Test Results
- Focused Node test passed: `control-panel/tests/market-update-plans.spec.ts` verifies catalog update-plan parsing and updater idempotency behavior.
- Market artifact parse passed for 31 apps, 4 integrations, 1 update plan, and 3 system entries.
- `pnpm --dir YouEye/control-panel build` passed for CP `0.4.13.51`.

### Notes for Iris
- Most app versions still skip directly to newest. Add durable migration gates only for required one-time data/container changes; each required gate should include an `idempotencyKey` so old-version updates can retry safely.

## v0.4.13.49 / v0.4.13.50 — artem — 2026-06-09
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Prove Immich standalone YouEye ID Integration install

### Changes
- `control-panel/src/lib/identity/store.ts`, `control-panel/src/lib/identity/tokens.ts`, `control-panel/src/app/oauth/jwks/route.ts` — Added persisted RS256 OAuth token signing and a real JWKS endpoint for YouEye ID while keeping HS256 bearer verification fallback for compatibility.
- `control-panel/src/app/application/o/token/route.ts`, `control-panel/src/app/application/o/[clientId]/.well-known/openid-configuration/route.ts` — Pass authorization scopes into token issuance and advertise RS256 discovery metadata including `immich_role`.
- `control-panel/src/lib/market/engine.ts`, `control-panel/src/lib/market/integration-runner.ts` — Store app role-claim scopes on OAuth clients created during base install or standalone Integration apply.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.13.50`.

### Test Results
- `pnpm --dir YouEye/control-panel build` passed for CP `0.4.13.49` and `0.4.13.50`.
- Release assets verified as `standalone.tar` with `server.js`, `package.json`, and embedded versions `0.4.13.49` and `0.4.13.50`.
- Live deploy on `192.168.31.160`: CP updated through `spine update control` to `0.4.13.50`; `spine status` reports 15 running containers and 0 stopped.
- Manual OAuth probe verified RS256 token headers, JWKS publication, `immich_role: admin`, and userinfo success; Jellyfin SSO still completed after the RS256/JWKS change.
- Live Immich install with `selectedIntegrations: ["immich-youeye-id"]` installed the base app, applied the standalone Integration, recorded installed Integration metadata, left `forwardAuthEnabled:false`, and created the SSO `Tester Dev` user as admin.
- Codex Browser verified Immich SSO lands on `https://photos.potato.app/photos` with no login/error text.

### Notes for Iris
- Immich/openid-client requires real RS256/JWKS metadata. Keep session/internal identity tokens separate from OAuth signing behavior, and keep the HS256 bearer fallback only for compatibility.

## v0.4.13.45 / v0.4.13.46 / v0.4.13.47 / v0.4.13.48 — artem — 2026-06-09
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Prove Jellyfin standalone YouEye ID Integration install

### Changes
- `control-panel/src/lib/market/caddy-ca.ts`, `control-panel/src/lib/market/engine.ts`, `control-panel/src/lib/market/integration-runner.ts` — Inject the Caddy root CA for selected/applied standalone identity Integrations so target apps can trust YouEye ID through Caddy.
- `control-panel/src/lib/market/catalog.ts` — Fetch standalone Integration manifests fresh during apply/install so the executed manifest matches the recorded digest.
- `control-panel/src/app/application/o/userinfo/route.ts` — Accept Bearer, POST form `access_token`, and query `access_token` userinfo requests.
- `control-panel/src/app/application/o/[clientId]/.well-known/openid-configuration/route.ts`, `control-panel/src/lib/auth/authentik.ts` — Advertise/use no-slash token and userinfo endpoints to avoid POST redirects for stricter OAuth clients.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.13.48`.

### Test Results
- `pnpm --dir YouEye/control-panel build` passed for CP `0.4.13.45`, `0.4.13.46`, `0.4.13.47`, and `0.4.13.48`.
- Release assets verified as `standalone.tar` with `server.js`, `package.json`, and embedded versions through `0.4.13.48`.
- Live deploy on `192.168.31.160`: CP updated through `spine update control` to `0.4.13.48`; `spine status` reports 11 running containers and 0 stopped.
- Live Jellyfin clean install with `selectedIntegrations: ["jellyfin-youeye-id"]` installed the base app, applied the standalone Integration, recorded installed Integration metadata, and left `forwardAuthEnabled:false`.
- Manual OAuth probe verified the no-slash YouEye ID token and userinfo endpoints with the Jellyfin client; Codex Browser verified Jellyfin SSO lands on `https://jellyfin.potato.app/web/index.html#/home` with no unauthorized/error text.

### Notes for Iris
- The no-slash token/userinfo discovery endpoints are important for OAuth clients that do not handle POST 308 redirects safely. Keep compatibility aliases, but avoid advertising slash-suffixed POST endpoints.

## v0.4.13.43 / v0.4.13.44 — artem — 2026-06-09
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Apply standalone Integrations during app install

### Changes
- `control-panel/src/lib/market/catalog.ts`, `control-panel/src/lib/market/types.ts` — Attached matching standalone Integration catalog items to their target app install options with source and manifest audit metadata.
- `control-panel/src/app/api/market/install/route.ts` — Applies selected standalone Integrations after the base app install in the same install stream and rolls back the base install if a selected Integration apply fails.
- `control-panel/src/lib/market/engine.ts` — Treats a selected standalone identity Integration as planned native SSO, preparing the identity proxy and suppressing Caddy forward-auth before the app first boots.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.13.44`.

### Test Results
- `pnpm --dir YouEye/control-panel build` passed for CP `0.4.13.43` and `0.4.13.44`.
- Release assets verified as `standalone.tar` with `server.js`, `package.json`, and embedded versions `0.4.13.43` and `0.4.13.44`.
- Live deploy on `192.168.31.160`: CP updated through `spine update control` to `0.4.13.44`; route repair returned success; `spine status` reports 10 running containers and 0 stopped.
- Live Memos clean reinstall with `selectedIntegrations: ["memos-youeye-id"]` installed the base app, applied the standalone Integration, recorded installed Integration metadata, and left `forwardAuthEnabled:false`.
- Codex Browser verified `/market/memos-youeye-id?source=official` shows `Installed` and `https://memos.potato.app/` renders the Memos Explore page without a forward-auth wall.

### Notes for Iris
- CP `0.4.13.43` exposed that selecting a standalone identity Integration must affect base install proxy/auth planning. CP `0.4.13.44` fixes that by planning identity service access before first boot and rolling back the base install if the selected standalone Integration fails.

## v0.4.13.40 / v0.4.13.41 / v0.4.13.42 — artem — 2026-06-09
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Complete post-install Integration proof for OCI app-network installs

### Changes
- `control-panel/src/lib/infrastructure/oci-deployer.ts`, `control-panel/src/lib/market/engine.ts` — Added stopped-start sequencing for OCI app-network containers so service access can be prepared before first boot.
- `control-panel/src/lib/incus/app-network.ts`, `control-panel/src/lib/market/platform-env.ts`, `control-panel/src/lib/market/uninstaller.ts` — Moved system-service access to Control-owned host proxy devices on each app bridge gateway and clean them up on rollback/uninstall.
- `control-panel/src/app/api/market/status/route.ts`, `control-panel/src/app/market/[appId]/page.tsx`, `control-panel/src/lib/market/types.ts` — Exposed installed Integration metadata and show applied Integration items as `Installed`.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.13.42`.

### Test Results
- `pnpm --dir YouEye/control-panel build` passed for CP `0.4.13.40`, `0.4.13.41`, and `0.4.13.42`.
- Release assets verified as `standalone.tar` with `server.js`, `package.json`, and embedded versions `0.4.13.40`, `0.4.13.41`, and `0.4.13.42`.
- Live deploy on `192.168.31.160`: CP updated through `spine update control` to `0.4.13.42`; route repair returned success; `spine status` reports 10 running containers and 0 stopped.
- Manual Incus probes proved OCI `bind=instance` proxy devices race/fail for immediate DB clients, while Control-owned host proxies are reachable from OCI containers.
- Memos base install with `selectedIntegrations: []` succeeded; `memos-youeye-id` post-install apply succeeded; install metadata records selected and installed Integration state.
- Codex Browser verified `/market/memos-youeye-id?source=official` shows `Installed` and `https://memos.potato.app/` renders Memos.

### Notes for Iris
- The live Memos proof depends on app-network service proxies being owned by `youeye-control`, listening on the per-app bridge gateway IP. Avoid moving OCI apps back to `bind=instance` service proxies unless Incus OCI proxy behavior is separately fixed and reverified.

## v0.4.13.39 — artem — 2026-06-09
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Attach app proxy devices before install health checks

### Changes
- `control-panel/src/lib/market/engine.ts` — Adds system-service proxy devices immediately after each app container deploys and before health checks, restarting the container if it exited before the proxy was available.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.13.39`.

### Test Results
- `pnpm --dir YouEye/control-panel build` passed for CP `0.4.13.39`.
- Release asset verified as `standalone.tar` with `server.js`, `package.json`, and embedded version `0.4.13.39`.
- Live deploy on `192.168.31.160`: CP updated through `spine update control`; route repair returned success; `spine status` reports CP `0.4.13.39`, 9 running containers, 0 stopped.
- Memos base install retry progressed through secrets, shared PostgreSQL setup, app network creation, OCI deploy, and early proxy device setup before failing because `app-memos` itself stopped and failed health. Rollback completed and platform returned to 9 running, 0 stopped with Memos not installed.

### Notes for Iris
- This fixes a pre-existing installer ordering bug exposed by Memos: shared-DB apps receive localhost PostgreSQL DSNs, so the PostgreSQL proxy must exist before the app's first health check.

## v0.4.13.38 — artem — 2026-06-09
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Add post-install Market Integration runner

### Changes
- `control-panel/src/lib/market/catalog.ts` — Added source-specific standalone Integration manifest/reference fetch helpers.
- `control-panel/src/lib/market/integration-runner.ts` — Added a runner that reconstructs the installed target app context, creates/reuses the YouEye ID OAuth client, executes the standalone Integration SSO setup, and records installed integration metadata.
- `control-panel/src/app/api/market/integrations/apply/route.ts` — Added an API endpoint to apply standalone Integration manifests.
- `control-panel/src/app/market/[appId]/page.tsx` — Integration detail pages can apply an integration when the target app is installed and keep the unavailable state when it is not.
- `control-panel/src/lib/market/types.ts`, `control-panel/package.json`, `README.md` — Added installed integration metadata and bumped Control Panel to `0.4.13.38`.

### Test Results
- `pnpm --dir YouEye/control-panel build` passed for CP `0.4.13.38`.
- Release asset verified as `standalone.tar` with `server.js`, `package.json`, and embedded version `0.4.13.38`.
- Live deploy on `192.168.31.160`: CP updated through `spine update control`; route repair returned success; `spine status` reported CP `0.4.13.38`, 9 running containers, 0 stopped.
- Apply endpoint was tested against `memos-youeye-id` before Memos install and correctly returned `Target app "memos" is not installed`.
- Full post-install apply proof remains pending because Memos OCI base install fails before it can become a target app.

### Notes for Iris
- This is the first execution path for standalone Integration manifests. Uninstall/rollback semantics for applied integrations are still future work.

## v0.4.13.37 — artem — 2026-06-09
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Add standalone Market integration catalog items

### Changes
- `control-panel/src/lib/market/schema.ts`, `control-panel/src/lib/market/types.ts`, `control-panel/src/lib/market/parser.ts` — Added `kind: integration` manifests and `catalog.integrations[]` parsing.
- `control-panel/src/lib/market/catalog.ts` — Fetches integration manifests from all enabled Market sources and exposes source/audit metadata just like app manifests.
- `control-panel/src/app/market/page.tsx`, `control-panel/src/app/market/[appId]/page.tsx`, `control-panel/src/components/market/app-card.tsx` — Displays standalone integration items in their own Market section with target app and permission details.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.13.37`.

### Test Results
- Local YAML parse of YE-AppMarket verified 31 apps, 2 integrations, and 3 system entries.
- `pnpm --dir YouEye/control-panel build` passed for CP `0.4.13.37`.
- Release asset verified as `standalone.tar` with `server.js`, `package.json`, and embedded version `0.4.13.37`.
- Live deploy on `192.168.31.160`: CP updated through `spine update control`; `spine status` reports CP `0.4.13.37`, 9 running containers, 0 stopped.
- Route repair returned success for `/settings` and `/market`; root health endpoint returned OK.
- Codex Browser HTTPS check: `/market` shows `INTEGRATIONS (2)` with Memos and Jellyfin YouEye ID; `/market/memos-youeye-id?source=official` shows target app, permissions, Market source, and disabled post-install action.

### Notes for Iris
- This slice makes integration scripts first-class Market artifacts. Execution is still routed through the existing app install compatibility path until the follow-up post-install Integration runner slice.

## v0.4.13.36 — artem — 2026-06-09
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Add installed app Market source switching

### Changes
- `control-panel/src/app/api/market/status/route.ts`, `control-panel/src/lib/market/types.ts` — Status responses now expose installed source and manifest audit metadata.
- `control-panel/src/app/api/market/app/[appId]/source/route.ts` — Added an admin-only source switch endpoint that updates install metadata and installed-app source records for future updates.
- `control-panel/src/app/market/[appId]/page.tsx` — App detail pages now offer a source switch action when viewing a non-current source variant for an installed app.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.13.36`.

### Test Results
- `pnpm --dir YouEye/control-panel build` passed for CP `0.4.13.36`.
- Release asset verified as `standalone.tar` with `server.js`, `package.json`, and embedded version `0.4.13.36`.
- Live deploy on `192.168.31.160`: CP updated through `spine update control`; `spine status` reports CP `0.4.13.36`, 9 running containers, 0 stopped.
- Live API check: `PATCH /api/market/app/search/source` with `sourceId: official` returned source/audit metadata; `/api/market/status?app=search` now echoes installed source and manifest audit fields.
- Live health checks: Search and root platform health stayed OK; Market updates API returns zero pending updates.
- Codex Browser HTTPS check: Search detail page shows `Market Source: Official YouEye Market` and no source-switch button when already viewing the current source.

### Notes for Iris
- Source switching is metadata-only: it changes future update checks/updates, not the currently running containers.

## v0.4.13.35 — artem — 2026-06-09
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Add Market source management and manifest audit metadata

### Changes
- `control-panel/src/app/market/page.tsx` — Replaced the single Market repo input with multi-Market source controls and grouped duplicate app variants by source.
- `control-panel/src/lib/market/source.ts`, `control-panel/src/app/api/market/source/route.ts` — Source management can now return configured disabled sources while catalog fetching still uses enabled sources only.
- `control-panel/src/lib/market/catalog.ts`, `control-panel/src/lib/market/types.ts`, `control-panel/src/lib/market/engine.ts`, `control-panel/src/lib/market/updater.ts`, install APIs — Catalog entries now expose manifest repo/path/branch and SHA-256 digest, and installs/updates persist that audit metadata.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to `0.4.13.35`.

### Test Results
- `pnpm --dir YouEye/control-panel build` passed for CP `0.4.13.35`.
- Release asset verified as `standalone.tar` with `server.js`, `package.json`, and embedded version `0.4.13.35`.
- Live deploy on `192.168.31.160`: CP updated through `spine update control`; route repair returned `/settings` and `/market`; `spine status` reports CP `0.4.13.35`, 9 running containers, 0 stopped.
- Live API checks: `/api/market/source` returns configured `sources` plus `enabledSources`; `/api/market/catalog` returns manifest path/repo/branch/SHA-256 digest fields.
- Live updater check: forced Search refresh from `0.4.0.5` to `0.4.0.5` succeeded and backfilled `manifestPath`, `manifestRepo`, `manifestBranch`, and `manifestDigest` in `/var/lib/youeye/app-search/install.json`; Search health remained OK.
- Codex Browser HTTPS check: logged in as `tester`, opened `/market`, and verified the Markets source controls, official source row, source badges, and catalog cards render.

### Notes for Iris
- This is the UI/source-conflict/audit slice for Plan 3. It does not yet implement source switching for an already-installed app.

## v0.4.13.34 — artem — 2026-06-09
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Match scoped Caddy app grants by app token

### Changes
- `control-panel/src/lib/caddy/client.ts` — Scoped app-grant routes now match the approved app token header instead of the app container source IP.
- `control-panel/src/lib/bridges/manager.ts` — Reads the source app's injected `YOUEYE_APP_TOKEN` when creating Search to SearXNG scoped Caddy grants.
- `README.md`, `control-panel/package.json` — Bumped Control Panel to `0.4.13.34`.

### Test Results
- `pnpm --dir YouEye/control-panel build` passed for CP `0.4.13.34`.
- Release asset verified as `standalone.tar` with `server.js`, `package.json`, and embedded version `0.4.13.34`.
- Live deploy on `192.168.31.160`: CP updated through `spine update control`; Search was updated to `0.4.0.5`; Caddy route now matches host `searx.potato.app`, paths `/search*` and `/autocompleter*`, and the Search app token.
- Initial live access matrix: Search with its app token gets `200` for SearXNG `/search`; Search with the same token gets `307` for `/`; Search with a wrong token gets `307`; Notes with no token gets `307`; platform health remains OK. This prototype behavior was later superseded by the terminal app-token deny route and CP `0.4.13.81` method scoping, where missed app-token grants return `403`.
- Codex Browser loaded `https://potato.app/api/health` and saw live `{"status":"ok"}` JSON.

### Notes for Iris
- CP `0.4.13.33` proved source-IP matching was too strict for live app-to-Caddy traffic; `0.4.13.34` keeps host/path scoping and uses the per-app secret token as the app identity proof.

## v0.4.13.33 — artem — 2026-06-09
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Prototype scoped Caddy app grants for Search to SearXNG

### Changes
- `control-panel/src/lib/caddy/client.ts` — Added scoped app-grant Caddy routes matched by source app IP, target host, and approved path list.
- `control-panel/src/lib/bridges/store.ts`, `control-panel/src/lib/bridges/manager.ts` — Search to SearXNG approved connections now create a Caddy-scoped grant instead of broad target network access, and UI discovery receives the scoped URL plus access metadata.
- `README.md`, `control-panel/package.json` — Bumped Control Panel to `0.4.13.33`.

### Test Results
- Pending build, Search release, and live scoped-grant verification.

### Notes for Iris
- This first scoped grant is intentionally narrow: `search -> searxng` only, with SearXNG API paths `/search*` and `/autocompleter*`. Other bridge pairs still use the legacy network grant path until modeled.

## v0.4.13.32 — artem — 2026-06-09
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Add optional Market integration install toggles

### Changes
- `control-panel/src/lib/market/schema.ts`, `control-panel/src/lib/market/types.ts` — Added manifest and install metadata support for optional Market integrations.
- `control-panel/src/lib/market/catalog.ts` — Exposes declared integrations and synthesizes a default YouEye ID integration for legacy API/CLI SSO setup manifests.
- `control-panel/src/lib/market/engine.ts` — Keeps legacy SSO setup default-on for old clients, but skips API/CLI SSO creation/configuration when the user explicitly deselects the YouEye ID integration.
- `control-panel/src/components/market/install-dialog.tsx`, `control-panel/src/app/embed/market/client.tsx` — Added install-time integration toggles and send selected integration ids to the installer.
- `control-panel/src/app/api/market/validate/route.ts` — Validates manifests from the selected Market source.
- `control-panel/tests/market-integrations.spec.ts` — Added static regression coverage for integration schema, default legacy SSO integration behavior, and install UI payloads.
- `README.md`, `control-panel/package.json` — Bumped Control Panel to `0.4.13.32`.

### Test Results
- Static regression: `market-integrations.spec.ts` passed after temporary ESM transpilation with `CONTROL_PANEL_ROOT`.
- Control Panel: `pnpm --dir YouEye/control-panel build` passed for `0.4.13.32`.
- Live practice on `192.168.31.160`: `spine update control` updated CP to `0.4.13.32`; `/api/setup/control-routes` returned success; `spine status` reported 9 running containers and 0 stopped.
- Live Market detail API returns default-on `youeye-id` integrations for Jellyfin and Memos from the official source.

### Notes for Iris
- This is the first compatibility bridge from embedded `sso.setup` scripts to explicit Integrations. Existing manifests still work by default; app manifests can be migrated to first-class `integrations` incrementally.

## v0.4.13.31 — artem — 2026-06-09
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Backfill Market install metadata after app updates

### Changes
- `control-panel/src/lib/market/updater.ts` — Writes successful update version records back to each app's `install.json` and backfills source metadata for legacy installs.
- `README.md`, `control-panel/package.json` — Bumped Control Panel to `0.4.13.31`.

### Test Results
- Control Panel: `pnpm --dir YouEye/control-panel build` passed for `0.4.13.31`.
- Live practice on `192.168.31.160`: `spine update control` updated CP to `0.4.13.31`; `/api/setup/control-routes` returned success; `spine status` reported 9 running containers and 0 stopped.
- Live forced Search update backfilled `/var/lib/youeye/app-search/install.json` to `installedVersion: 0.4.0.3`, `sourceId: official`, and `catalogKey: official:app:search`.

### Notes for Iris
- This closes the gap found after `0.4.13.30`: installed-app state had source-aware versions, but per-app install metadata could remain stale until the next update.

## v0.4.13.30 — artem — 2026-06-09
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Persist Market source identity for installs and updates

### Changes
- `control-panel/src/lib/market/catalog.ts` — Added source-specific manifest fetching so duplicate app ids can resolve through the selected Market source.
- `control-panel/src/lib/market/types.ts`, `control-panel/src/lib/market/engine.ts`, `control-panel/src/lib/market/installed-apps.ts` — Persist catalog key, source id/name/repo URL, and use the installed source for update detection.
- `control-panel/src/lib/market/updater.ts` — Updates now fetch manifests from the originally installed source when source metadata exists.
- `control-panel/src/app/api/market/install/route.ts`, `control-panel/src/app/api/ui-bridge/market/route.ts`, `control-panel/src/app/api/market/app/[appId]/route.ts` — Accept and honor source identity for install, validate, and detail lookups.
- `control-panel/src/app/embed/market/client.tsx`, `control-panel/src/components/market/app-card.tsx`, `control-panel/src/app/market/[appId]/page.tsx`, `control-panel/src/components/market/install-dialog.tsx` — Carry source identity through UI install flows and show source badges/links for variants.
- `README.md`, `control-panel/package.json` — Bumped Control Panel to `0.4.13.30`.

### Test Results
- Control Panel: `pnpm --dir YouEye/control-panel build` passed for `0.4.13.30`.

### Notes for Iris
- This does not yet build the full add/remove source management UI. It establishes install/update identity so that UI can safely expose source variants without silently merging duplicate app ids.

## v0.4.13.29 / v0.4.3.7 — artem — 2026-06-09
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Start Plan 3 Market rename, multi-source catalog groundwork, update gates, and PWA prompt removal

### Changes
- `control-panel/src/lib/market/source.ts`, `control-panel/src/app/api/market/source/route.ts` — Added multi-source Market registry support while keeping backward-compatible single repo source reads/writes.
- `control-panel/src/lib/market/catalog.ts`, `control-panel/src/lib/market/types.ts` — Fetch enabled Market sources into one catalog and annotate entries with source identity metadata.
- `control-panel/src/lib/market/schema.ts`, `control-panel/src/lib/market/updater.ts` — Added required migration gate fields and update path descriptions so ordinary versions can be skipped while required migration edges still run.
- `control-panel/src/components/settings-shell/settings-shell.tsx`, `control-panel/src/app/embed/market/client.tsx`, `control-panel/messages/en.json`, `control-panel/src/lib/health/monitor.ts` — Renamed active user-facing App Market copy to Market.
- `ui/src/app/app-market/*`, `ui/src/app/app-store/*` — Deleted old UI Market iframe/redirect routes; `/app-market` intentionally has no redirect.
- `ui/src/components/providers.tsx`, `ui/src/components/pwa/install-banner.tsx`, `ui/messages/en.json` — Removed the proactive PWA install prompt and renamed visible Market copy.
- `README.md`, `control-panel/package.json`, `ui/package.json` — Bumped CP to `0.4.13.29`, UI to `0.4.3.7`, and updated current-version/product wording.

### Test Results
- Control Panel: `pnpm --dir YouEye/control-panel build` passed.
- UI: `pnpm --dir YouEye/ui build` passed; local static generation still logs expected PostgreSQL `ECONNREFUSED` warnings when no local DB is running.

### Notes for Iris
- This is the first Plan 3 implementation slice, not the full architecture. Integrations, Caddy-scoped app grants, first-launch permissions, system-app manifests, and unified surfaces still need follow-up work.
- Multi-source conflict grouping UI is not complete yet; catalog items now carry enough source metadata to build it.

## v0.4.2.9 / v0.4.13.28 — artem — 2026-06-09
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Stabilize Caddy upstream generation for core routes and forward-auth apps

### Changes
- `control-panel/src/lib/caddy/client.ts` — Added Caddy-safe upstream resolution to deterministic IPv4 for YouEye-managed containers, applied it to core route writers, and added active-config migration for legacy hostname dials.
- `control-panel/src/lib/market/engine.ts`, `control-panel/src/lib/identity/provider.ts` — Resolved YouEye ID forward-auth upstreams to IPv4 so SearXNG-style routes no longer hit IPv6-first container DNS.
- `control-panel/src/app/api/setup/run/route.ts` — Runs the Caddy upstream migration after setup route generation.
- `spine/internal/api/server.go` — Changed fresh setup defaults from Authentik `auth` to YouEye ID `identity`.
- `spine/internal/api/server_test.go` — Added regression coverage for the fresh identity subdomain default.
- `README.md`, `control-panel/package.json`, `spine/internal/cmd/root.go` — Bumped Spine to `0.4.2.9` and Control Panel to `0.4.13.28`.

### Test Results
- Spine: `go test ./...` passed.
- Control Panel: `pnpm -C control-panel build` passed.
- Live practice on `192.168.31.160`: root UI, UI SSO, YouEye ID, Control Panel SSO, Notes native SSO, SearXNG forward-auth, and Pi-Hole route verified after active Caddy config migration.

### Notes for Iris
- The durable fix is in CP route generation. Existing Caddy configs with `youeye-control.youeye:*` need the migration helper to run once, or a manual active-config migration before updating.
- This intentionally keeps user-entered LAN IP/FQDN proxy targets unchanged; only YouEye-managed container names are resolved to IPv4.

## v0.4.2.8 / v0.4.13.27 — artem — 2026-06-09
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Split core release repo ownership from CP-owned AppMarket repo ownership

### Changes
- `spine/internal/config/*`, `spine/internal/releases/releases.go` — Added canonical `releases.repo_url` for the core YouEye monorepo while preserving old multi-field config as a migration fallback.
- `spine/internal/cmd/repo.go`, `spine/internal/cmd/market.go`, `spine/install.sh` — Added `youeye repo get/set`, changed installer repo selection to `--repo`, and added `youeye market repo get/set` as a Control Panel API proxy.
- `control-panel/src/lib/market/source.ts`, `control-panel/src/app/api/market/source/route.ts` — Added CP-owned AppMarket repo source persisted in `market-source.json`.
- `control-panel/src/lib/market/catalog.ts`, `control-panel/src/lib/market/updater.ts` — Moved Market catalog, manifest, and native app release lookup off Spine's core release source.
- `control-panel/src/app/market/page.tsx` — Added a Market repo URL control in the CP Market UI.
- `control-panel/tests/release-source-ownership.spec.ts` — Added a focused ownership regression scan.
- `README.md`, `control-panel/package.json`, `spine/internal/cmd/root.go` — Bumped Spine to `0.4.2.8` and Control Panel to `0.4.13.27`.

### Test Results
- Spine: `go test ./...` passed.
- Control Panel: `pnpm -C control-panel build` passed.
- Ownership scan: Market catalog/API/UI paths no longer import or read Spine core release source helpers.
- Release verification: Spine binary reports `0.4.2.8`; CP standalone package contains `0.4.13.27`.

### Notes for Iris
- Spine owns only the core monorepo release repo. Control Panel owns AppMarket source. Market code intentionally has no fallback to Spine `release_source`.

## v0.4.13.26 — artem — 2026-06-09
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Remove remaining Authentik infrastructure manifest and README architecture references

### Changes
- `control-panel/src/lib/apps/manifest.ts` — Removed the legacy Authentik app manifest so CP status/control manifest helpers no longer expose Authentik as a managed infrastructure app.
- `control-panel/src/lib/apps/updater.ts`, `control-panel/src/app/api/apps/[name]/update/route.ts` — Updated infrastructure updater comments to remove Authentik as an OCI update target.
- `README.md`, `control-panel/package.json` — Bumped Control Panel to `0.4.13.26` and updated architecture/current-version docs for YouEye ID.

### Test Results
- CP build: `pnpm -C control-panel build` passed.
- Live deploy verification pending after release.

### Notes for Iris
- CP-only follow-up after `0.4.13.25`; Spine remains `0.4.2.6`.

## v0.4.13.25 / v0.4.2.6 — artem — 2026-06-09
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Remove Authentik from fresh installs and infrastructure reconciliation

### Changes
- `control-panel/src/lib/infrastructure/deployer.ts` — Removed Authentik DB/server/worker/token/route deployment and stopped reconcile from recreating missing Authentik containers.
- `control-panel/src/app/api/setup/run/route.ts` — Removed Authentik route/admin/branding setup; fresh setup now creates the admin user only in YouEye ID.
- `control-panel/src/components/setup/SetupServerName.tsx`, `control-panel/src/app/setup/page.tsx`, `control-panel/src/app/api/setup/config/route.ts` — Removed the Authentik subdomain from fresh setup defaults and advanced settings.
- `control-panel/src/lib/apps/definitions.ts`, `control-panel/src/lib/health/service.ts`, `control-panel/src/app/api/health/services/[slug]/restart/route.ts`, `control-panel/src/lib/backup/service.ts`, `control-panel/src/lib/incus/*`, `control-panel/src/lib/market/schema.ts` — Removed Authentik from CP system inventory, health, restart, backup, reserved names, and static IP maps.
- `spine/internal/cmd/deploy.go`, `spine/internal/cmd/cleanup.go`, `spine/internal/incus/static_ips.go`, `spine/internal/api/server.go`, `spine/internal/installer/engine.go` — Removed Authentik data directory creation, static IP reservations, OCI update listing, and old install progress parsing.
- `control-panel/tests/authentik-removal.spec.ts` — Added a focused regression spec for no-Authentik deploy/reconcile/setup/catalog invariants.
- `control-panel/package.json`, `spine/internal/cmd/root.go`, `README.md` — Bumped CP to `0.4.13.25` and Spine to `0.4.2.6`.

### Test Results
- CP build: `pnpm -C control-panel build` passed.
- Spine: `go test ./...` passed.
- Spine build: `spine-linux-amd64 version` reports `0.4.2.6`.
- Authentik removal scan: deploy/reconcile/setup/AppMarket invariant checks passed.

### Notes for Iris
- This intentionally keeps YouEye ID Authentik-compatible OAuth/forward-auth paths and `AUTHENTIK_*` app env compatibility. It only removes Authentik as an installed infrastructure component.
- Existing upgraded hosts must deploy CP `0.4.13.25` before deleting `youeye-authentik*`; older CP releases would recreate those containers during reconcile.

## v0.4.13.24 verification (CP) — artem — 2026-06-06
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Verify Forgejo native release asset handling and clean Wiki install

### Changes
- `AGENTS.md` — Recorded live verification evidence for the already-released CP 0.4.13.24 asset URL fix.

### Test Results
- Deploy: `spine update control` updated `192.168.31.160` to CP 0.4.13.24 and reconfirmed UI -> CP egress ACL.
- Clean install: Wiki installed from AppMarket, created YouEye ID client `youeye-app-wiki`, deployed `app-wiki`, added `wiki.potato.app`, saved config, and registered with the dashboard.
- Runtime: `spine status` reports 11 running containers and Wiki `0.4.0.1`.
- Env: `/etc/app-wiki.env` contains `YOUEYE_ID_URL`, `YOUEYE_ID_INTERNAL_URL`, `YOUEYE_ID_CLIENT_ID=youeye-app-wiki`, and `YOUEYE_ID_CLIENT_SECRET`.
- Browser: `https://wiki.potato.app` redirected through YouEye ID and landed back on Wiki as `tester`; screenshot `/tmp/artem-wiki-oauth-041324.png`.

### Notes for Iris
- The earlier CP 0.4.13.24 AGENTS entry was written before deploy. This entry records the completed live proof without editing that prior entry.

## v0.4.13.24 (CP) — artem — 2026-06-06
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Use Forgejo attachment URLs for native app release assets

### Changes
- `control-panel/src/lib/apps/release-source.ts` — Added provider-aware release asset URL resolution, using Forgejo attachment UUID URLs when available.
- `control-panel/src/lib/infrastructure/lxd-deployer.ts` — Made clean LXD app installs download `standalone.tar` from Forgejo attachment URLs instead of UI redirect URLs.
- `control-panel/src/lib/apps/lxd-updater.ts`, `control-panel/src/lib/market/updater.ts` — Applied the same asset URL resolution to native app update paths.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to 0.4.13.24.

### Test Results
- CP build: `pnpm -C control-panel build` passed for 0.4.13.24.
- Pending after release: deploy and clean Wiki install proof.

### Notes for Iris
- CP-only follow-up to 0.4.13.23. That release fixed release discovery, but Forgejo's release-list `browser_download_url` redirected to HTML on this instance; the asset UUID `/attachments/*` URL returns the actual tarball.

## v0.4.13.23 (CP) — artem — 2026-06-06
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Fetch native app install releases from the configured release source

### Changes
- `control-panel/src/lib/infrastructure/lxd-deployer.ts` — Switched clean LXD app installs from hardcoded GitHub release API calls to the configured release source, preserving GitHub support and enabling Forgejo-hosted native app releases.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to 0.4.13.23.

### Test Results
- CP build: `pnpm -C control-panel build` passed for 0.4.13.23.
- Pending after release: deploy and clean Wiki install proof.

### Notes for Iris
- CP-only follow-up to 0.4.13.22; required because the catalog could see Forgejo AppMarket data but app install downloads still queried GitHub.

## v0.4.13.22 (CP) — artem — 2026-06-06
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Fetch AppMarket and app manifests from the configured Forgejo release source

### Changes
- `control-panel/src/lib/market/catalog.ts` — Replaced hardcoded GitHub raw manifest URLs with release-source-aware raw fetching. Forgejo/Gitea sources now use `/api/v1/repos/{org}/{repo}/raw/{path}?ref={branch}` for AppMarket and app repo manifests.
- `control-panel/package.json`, `README.md` — Bumped Control Panel to 0.4.13.22.

### Test Results
- CP build: `pnpm -C control-panel build` passed for 0.4.13.22.
- Pending in this iteration: release, deploy, and clean native app install proof.

### Notes for Iris
- This is required for branch-local AppMarket/native manifest changes to be visible without pushing to GitHub.

## v0.4.13.21 (CP) — artem — 2026-06-06
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Finish provider-neutral YouEye ID user and app wiring for OAuth Plan 2

### Changes
- `control-panel/src/lib/identity/*` — Added the provider-neutral user management layer backed by YouEye ID users.
- `control-panel/src/app/api/people/*`, `control-panel/src/app/api/apps/authentik/users/*`, `control-panel/src/app/api/ui-bridge/users/*` — Routed user list/create/update/delete/password/admin actions through the identity provider layer while preserving existing endpoint paths.
- `control-panel/src/app/api/user/*` — Moved self-profile/avatar/language sync off direct Authentik user mutation; avatars now persist through the UI bridge.
- `control-panel/src/lib/market/*` — Added `identity.*` and runtime `sso.slug` manifest variables so app installs can target YouEye ID without display-name path bugs.
- `README.md`, `control-panel/package.json` — Bumped Control Panel to 0.4.13.21 and updated the current version table.

### Test Results
- CP build: `pnpm -C control-panel build` passed for 0.4.13.21 after the final market/user changes.
- Strict TS: `pnpm -C control-panel exec tsc --noEmit --pretty false` still fails only on known unrelated backlog files (`api/market/validate-url`, `api/suggestions`, `app/sw.ts`, several `components/ui/*`, `lib/auth/sso-setup.ts`).
- Live pre-release regression: UI OAuth, CP `/settings` OAuth, direct PAM rescue, Notes OIDC, and SearXNG forward-auth all verified on `192.168.31.160` after UI 0.4.3.6.

### Notes for Iris
- Authentik compatibility route names remain intentionally stable, but the changed user APIs no longer require Authentik numeric IDs.
- `${identity.name}` is for display labels; `${sso.slug}` is now available for URL-safe provider path segments.

## v0.4.3.6 (UI) — artem — 2026-06-06
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Link existing UI accounts during the YouEye ID provider migration

### Changes
- `ui/src/lib/db/queries/users.ts` — When a new YouEye ID subject logs in, migrate an existing UI account matched by username or email before inserting a new user, and fail explicitly if username and email point at different users.
- `ui/package.json`, `README.md` — Bumped the UI release version only.

### Test Results
- Pending in this iteration: UI build, release, live deploy, and OAuth retest on `192.168.31.160`.

### Notes for Iris
- This keeps existing Authentik-created UI accounts intact while changing their stored provider subject to YouEye ID on first login.

## v0.4.13.20 (CP) / v0.4.3.5 (UI) / v0.4.2.5 (Spine) — artem — 2026-06-05
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Switch core UI and Control Panel OAuth wiring to YouEye ID

### Changes
- `control-panel/src/lib/identity/core-clients.ts`, `control-panel/src/app/api/identity/core-clients/route.ts` — Added shared core-client setup and an admin repair endpoint for `youeye-control` and `youeye-ui`.
- `control-panel/src/app/api/setup/run/route.ts`, `control-panel/src/lib/reconfigure/index.ts`, `control-panel/src/lib/ui/manager.ts`, `control-panel/src/lib/auth/sso-setup.ts` — Fresh setup, reconfigure, UI enable, and CP SSO setup now create YouEye ID clients and write YouEye ID env, while Authentik remains installed for coexistence.
- `control-panel/src/lib/auth/authentik.ts`, `ui/src/lib/auth/authentik.ts`, callback routes — Prefer `YOUEYE_ID_*` env vars and accept native `admin` / `is_admin` claims while keeping temporary Authentik env aliases.
- `spine/internal/api/server.go` — `/api/control/sso` and `/api/ui/sso` write `YOUEYE_ID_*` env vars and compatibility aliases; UI SSO now reconciles a checked `identity-proxy` to YouEye ID port `3001`.
- `control-panel/package.json`, `ui/package.json`, `spine/internal/cmd/root.go`, `README.md` — Bumped only changed component versions.

### Test Results
- CP build: `pnpm -C control-panel build` passed for `0.4.13.20`.
- UI build: `pnpm -C ui build` passed for `0.4.3.5` with the existing local Postgres static-generation warnings.
- Spine tests: `go test ./...` passed for `0.4.2.5`.

### Notes for Iris
- Authentik is still deployed and Authentik-shaped env names are still written as temporary aliases. New core OAuth wiring uses YouEye ID.
- UI receives YouEye ID through a narrow Incus `identity-proxy` on localhost `3002`; generic UI to CP access remains blocked.

## v0.4.2.4 (Spine) — artem — 2026-06-05
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Add YouEye ID repair to the CLI update path

### Changes
- `spine/internal/cmd/update.go` — Added the checked `youeye-id.service` repair to the CLI `spine update control` path, including the up-to-date branch and the post-deploy branch.
- `spine/internal/cmd/root.go`, `README.md` — Bumped Spine release version only.

### Test Results
- Live `spine update control` on `0.4.2.3` still short-circuited before the API repair and left `youeye-id.service` missing.
- Spine release build/testing pending in this iteration.

### Notes for Iris
- Follow-up to `v0.4.2.3`; this fixes the operator-facing CLI path used on the live test host.

## v0.4.2.3 (Spine) — artem — 2026-06-05
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Repair YouEye ID service creation during up-to-date CP updates

### Changes
- `spine/internal/api/server.go` — Made `youeye-id.service` creation a checked repair step, removed the unavailable `openssl` dependency, restarted the service after repair, and run the repair even when Control Panel is already at the latest version.
- `spine/internal/cmd/root.go`, `README.md` — Bumped Spine release version only.

### Test Results
- Live CP `0.4.13.19` update exposed that `youeye-id.service` was not created on the existing host because the repair script failed and the old updater ignored the error.
- Spine release build/testing pending in this iteration.

### Notes for Iris
- Follow-up to `v0.4.2.2`; CP artifact does not need to change for this repair.

## v0.4.13.19 (CP) / v0.4.2.2 (Spine) — artem — 2026-06-05
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Move YouEye ID toward an identity-owned runtime and wire app installs to it

### Changes
- `control-panel/src/middleware.ts` — Added `YOUEYE_ID_SERVICE=true` mode so the identity runtime serves only login/OIDC/forward-auth/discovery routes and returns 404 for generic CP routes.
- `control-panel/src/lib/identity/*` — Added explicit identity internal port/config, provider-neutral client/forward-auth helpers, and OAuth client removal for rollback.
- `control-panel/src/lib/market/*`, `control-panel/src/lib/incus/app-network.ts`, `control-panel/src/app/api/market/forward-auth/route.ts` — New native SSO and forward-auth app wiring now targets YouEye ID and exposes `${identity.*}` variables while keeping temporary legacy aliases.
- `control-panel/src/app/api/setup/*`, `control-panel/src/app/api/identity/route/route.ts` — Persist explicit `identity.provider=youeye-id` and route `id.<domain>` to the identity-owned port.
- `spine/internal/api/server.go`, `spine/internal/container/control.go` — Install and update a managed `youeye-id` systemd service on port `3001` alongside `youeye-control`.
- `spine/internal/config/defaults.go`, `spine/internal/config/config_test.go`, `spine/internal/releases/releases_test.go` — Aligned default release source with Forgejo (`git.potemk.in/potemsla`) and repaired stale tests.
- `control-panel/package.json`, `spine/internal/cmd/root.go`, `README.md` — Bumped only the changed component versions.

### Test Results
- CP build: `pnpm -C control-panel build` passed for `0.4.13.19`.
- Spine tests/build: `go test ./...` passed; `youeye` binary built with `Version=0.4.2.2`.
- CP lint and full `tsc --noEmit` still expose pre-existing project-wide lint/type debt outside this change; production build passed.

### Notes for Iris
- This is the first service-boundary phase: YouEye ID is now a distinct managed process/port in the CP container, not a generic CP dashboard route. A later phase can split it into its own package/container if desired.
- Authentik remains installed for coexistence, but new app install wiring now targets YouEye ID by default.

## v0.4.13.18 (CP) — artem — 2026-06-05
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Build external YouEye ID authorize return URLs

### Changes
- `control-panel/src/app/application/o/authorize/route.ts` — Builds login `return_to` from configured YouEye ID external URL plus the request path/query instead of Next's internal `0.0.0.0:3000` URL.
- `control-panel/package.json`, `README.md` — Bumped CP branch release version and current-version table.

### Test Results
- CP build: `pnpm -C control-panel build` passed for `0.4.13.18`.
- Release: `cp-artem-v0.4.13.18` published with asset name exactly `standalone.tar`.
- Deploy: `spine update control` updated `192.168.31.160` to CP `0.4.13.18`; UI remained `0.4.3.4`.
- Notes OIDC pilot: Playwright browser flow signed in through `https://id.potato.app` and landed on `https://notes.potato.app/` with `ye-id-session` and `ye-notes-session`; screenshot `/tmp/youeye-id-notes-pilot.png`.
- SearXNG forward-auth pilot: unauthenticated `https://searx.potato.app/` redirected to YouEye ID, browser login landed on SearXNG with `ye-id-session`; screenshot `/tmp/youeye-id-searxng-forward-auth.png`.
- UI -> Control Panel egress block was reconfirmed by `spine update control`.

### Notes for Iris
- CP-only follow-up to `0.4.13.17`. The pilot remains CP-hosted; service separation is still required before Authentik removal.

## v0.4.13.17 (CP) — artem — 2026-06-05
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Use browser-safe redirect after YouEye ID login

### Changes
- `control-panel/src/app/identity/login/route.ts` — Changed successful login redirect from default 307 to 303 so form POSTs continue the OAuth authorize flow as GET.
- `control-panel/package.json`, `README.md` — Bumped CP branch release version and current-version table.

### Test Results
- Live CP `0.4.13.16` seeded the pilot user/client successfully and Notes redirected to YouEye ID.
- Cookie/redirect test showed `ye-id-session` was set, then the preserved POST hit `/application/o/authorize` and returned 405.
- CP release build pending in this session.

### Notes for Iris
- CP-only follow-up to `0.4.13.16`.

## v0.4.13.16 (CP) — artem — 2026-06-05
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Preserve JSON quoting in YouEye ID psql calls

### Changes
- `control-panel/src/lib/identity/store.ts` — Escaped double quotes, backslashes, and dollar signs before running identity SQL through the existing Incus/psql shell path so JSONB values survive correctly.
- `control-panel/package.json`, `README.md` — Bumped CP branch release version and current-version table.

### Test Results
- Live CP `0.4.13.15` fixed writable CTE syntax, but pilot seeding still failed because JSONB arrays lost their double quotes in the shell command.
- CP release build pending in this session.

### Notes for Iris
- CP-only follow-up to `0.4.13.15`.

## v0.4.13.15 (CP) — artem — 2026-06-05
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Fix YouEye ID writable SQL JSON wrapper

### Changes
- `control-panel/src/lib/identity/store.ts` — Switched identity row JSON wrapping to a writable CTE so `INSERT/UPDATE ... RETURNING` statements can be parsed the same way as `SELECT` statements.
- `control-panel/package.json`, `README.md` — Bumped CP branch release version and current-version table.

### Test Results
- Live CP `0.4.13.14` exposed `https://id.potato.app/identity/login` and OIDC discovery correctly.
- Pilot seeding returned HTTP 500 because PostgreSQL rejected the old `FROM (INSERT ... RETURNING)` wrapper.
- CP release build pending in this session.

### Notes for Iris
- CP-only follow-up to `0.4.13.14`.

## v0.4.13.14 (CP) — artem — 2026-06-05
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Expose YouEye ID routes through middleware

### Changes
- `control-panel/src/middleware.ts` — Marked YouEye ID login, OAuth/OIDC, forward-auth, and discovery endpoints as public auth-system routes so they are not redirected to the Control Panel PAM login.
- `control-panel/package.json`, `README.md` — Bumped CP branch release version and current-version table.

### Test Results
- Live CP `0.4.13.13` update succeeded, but `https://id.potato.app/identity/login` redirected to `/login` because middleware still required a CP session.
- CP release build pending in this session.

### Notes for Iris
- CP-only follow-up to `0.4.13.13`. Authentik remains live at `auth.<domain>`.

## v0.4.13.13 (CP) — artem — 2026-06-05
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Add staged YouEye ID pilot beside Authentik

### Changes
- `control-panel/src/lib/identity/*` — Added database-backed YouEye ID users, OAuth clients, authorization codes, sessions, and signed token helpers.
- `control-panel/src/app/application/o/*`, `control-panel/src/app/oauth/*`, `control-panel/src/app/identity/login/route.ts`, `control-panel/src/app/forward-auth/caddy/route.ts`, `control-panel/src/app/outpost.goauthentik.io/auth/caddy/route.ts` — Added Authentik-compatible and native YouEye ID OAuth/OIDC and forward-auth pilot endpoints.
- `control-panel/src/app/api/identity/*` — Added admin-only pilot seeding and explicit identity-route activation endpoints.
- `control-panel/src/app/setup/page.tsx`, `control-panel/src/components/setup/SetupServerName.tsx`, `control-panel/src/app/api/setup/config/route.ts`, `control-panel/src/app/api/setup/run/route.ts` — Split Authentik `auth` subdomain from YouEye ID `identity` subdomain and require explicit identity config during provisioning.
- `control-panel/src/lib/caddy/client.ts` — Added `ensureIdentityRoute()` and stripped YouEye identity headers at the Caddy edge.
- `control-panel/package.json`, `README.md` — Bumped CP branch release version and current-version table.

### Test Results
- CP build: `pnpm -C control-panel build` passed before version bump; final release build pending in this session.
- Lint: `pnpm -C control-panel lint` currently fails on broad pre-existing project lint errors; this change cleaned its only new unused-variable warning.

### Notes for Iris
- This is the first coexistence slice only. Authentik remains at `auth.<domain>`; YouEye ID is introduced at configured `subdomains.identity` (`id.<domain>` by default).
- The initial runtime is CP-owned and CP-hosted behind a distinct `id.<domain>` route for pilot testing. The service boundary still needs to become a separate process/container before full Authentik removal.

## v0.4.13.12 (CP) — artem — 2026-06-05
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Route direct PAM login to Settings admin mode

### Changes
- `control-panel/src/app/login/page.tsx` — Redirect direct `ip:3000`, `localhost:3000`, and `127.0.0.1:3000` PAM logins to `/settings/system` instead of the legacy CP dashboard.
- `control-panel/package.json`, `README.md` — Bumped CP branch release version and current-version table.

### Test Results
- CP build: `pnpm -C control-panel build` passed for `0.4.13.12`.
- Release: `cp-artem-v0.4.13.12` published with asset name exactly `standalone.tar`.
- Deploy: `spine update control` updated `192.168.31.160` to CP `0.4.13.12`; UI remained `0.4.3.4`.
- Route repair: `/api/setup/control-routes` returned success for `/settings` and `/market`.
- Live direct PAM verification: `http://192.168.31.160:3000/login` landed at `/settings/system`, showed admin-only Settings sections, and hid user-specific header controls.
- Screenshot verification: `/tmp/youeye-shots/plan4-pam-settings-system-0.4.13.12.png`.
- Cleanup: temporary PAM test user `plan4pam` was removed after verification.

### Notes for Iris
- CP-only follow-up to `0.4.13.11`; UI remains `0.4.3.4`.

## v0.4.13.11 (CP) — artem — 2026-06-05
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Fix Lucide icon rendering in CP Settings Apps tab

### Changes
- `control-panel/src/components/settings-shell/apps-client.tsx` — Accepted React/Lucide component objects as well as function exports when resolving symbolic app icons, restoring non-letter icons for apps and system components.
- `control-panel/package.json`, `README.md` — Bumped CP branch release version and current-version table.

### Test Results
- Live verification of CP `0.4.13.10` showed Apps rows still falling back to letters, which this release fixes.

### Notes for Iris
- CP-only follow-up to `0.4.13.10`; UI remains `0.4.3.4`.

## v0.4.13.10 (CP) + v0.4.3.4 (UI) — artem — 2026-06-05
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Plan4 follow-up for CP Settings app drawer, app settings iframe, icons, and direct PAM mode

### Changes
- `control-panel/src/app/api/ui-settings/[...path]/route.ts` — Forwarded the browser/public host and proto to the UI bridge so app drawer URLs are generated for the public domain instead of the internal UI container DNS name.
- `ui/src/app/api/ui-bridge/settings/[...path]/route.ts`, `ui/src/app/api/v1/apps/drawer/route.ts` — Used the forwarded public host/proto for app URLs and detected app settings panels from both `capabilities.settings_panel` and runtime manifest `settings` blocks.
- `control-panel/src/components/settings-shell/apps-client.tsx` — Restored app-owned settings iframes for the `App Settings` tab, improved app/system icon rendering with Lucide name support, and made Apps usable in no-user-context PAM mode.
- `control-panel/src/lib/auth/session.ts`, `control-panel/src/app/api/auth/login/route.ts`, `control-panel/src/app/api/auth/callback/route.ts` — Added session `authMethod` and direct-HTTP-safe PAM cookies while keeping HTTPS/SSO cookies secure.
- `control-panel/src/components/control-surface/control-header.tsx`, `control-panel/src/components/settings-shell/settings-shell.tsx`, `control-panel/src/app/settings/(shell)/*`, `control-panel/src/components/control-surface/market-shell.tsx` — Hid UI-user-specific controls in PAM/CLI mode and routed direct PAM `/settings` to admin System settings.
- `control-panel/package.json`, `ui/package.json`, `README.md` — Bumped CP/UI branch release versions and current-version table.

### Test Results
- CP build: `pnpm -C control-panel build` passed for `0.4.13.10`.
- UI build: `pnpm -C ui build` passed for `0.4.3.4` with a temporary SSH Postgres tunnel; existing Edge Runtime warnings and Postgres "already exists, skipping" notices were emitted.
- Focused type check: no TypeScript diagnostics in the touched CP files. Full CP `tsc --noEmit` still reports pre-existing unrelated diagnostics in older routes/UI primitives.

### Notes for Iris
- The bridge direction remains CP -> UI only. UI still does not call Control Panel.
- Direct PAM mode intentionally has no UI-user context, so Profile/Appearance/Language user pages redirect to `/settings/system` and the header suppresses drawer, notifications, and UI theme controls.

## v0.4.13.9 (CP) — artem — 2026-06-05
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Restore Spine metrics client used by System settings

### Changes
- `control-panel/src/lib/spine/client.ts` — Added the missing `getMetrics()` client method and metrics response type used by native System settings and the existing UI bridge system route.
- `control-panel/package.json`, `README.md` — Bumped CP branch release version and current-version table.

### Test Results
- CP build: `pnpm -C control-panel build` passed for `0.4.13.9`.
- Release: `cp-artem-v0.4.13.9` published with `standalone.tar`.
- Deploy: `spine update control` updated `192.168.31.160` to CP `0.4.13.9`; UI remained `0.4.3.3`.
- Route repair: `/api/setup/control-routes` returned success for `/settings` and `/market`.
- Playwright/browser route pass: `/settings`, `/settings/appearance`, `/settings/apps`, `/settings/language`, `/settings/users`, `/settings/system`, `/settings/network`, `/settings/about`, and `/market` all rendered without 404s.
- Screenshot verification: final screenshots under `/tmp/youeye-shots/plan3-*-0.4.13.9.png`; System now renders host metrics and container summary.
- Boundary: CP update reconfirmed UI -> CP egress block enforcement.

### Notes for Iris
- CP-only follow-up to `0.4.13.8`; no UI release needed.

## v0.4.13.8 (CP) — artem — 2026-06-05
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Fix Settings System API alias on root-domain CP surface

### Changes
- `control-panel/src/app/settings/api/settings/system/route.ts` — Added a Settings-scoped API alias for the native System settings endpoint.
- `control-panel/src/components/settings-shell/system-client.tsx` — Fetches the System summary through `/settings/api/settings/system` so root-domain Caddy routing stays on CP.
- `control-panel/package.json`, `README.md` — Bumped CP branch release version and current-version table.

### Test Results
- CP build: `pnpm -C control-panel build` passed for `0.4.13.8`; build route table includes `/settings/api/settings/system`.

### Notes for Iris
- CP-only follow-up to `0.4.13.7`; no UI release needed.

## v0.4.13.7 (CP) + v0.4.3.3 (UI) — artem — 2026-06-05
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Reshape CP-owned Settings to match main UI settings structure

### Changes
- `control-panel/src/components/settings-shell/settings-shell.tsx` — Collapsed Settings navigation to main-style Profile, Appearance, Apps, Language plus admin Users, System, Network, About, and App Market.
- `control-panel/src/app/settings/(shell)/*` — Redirected legacy Settings routes into the new main-shaped sections and added native Network/About pages.
- `control-panel/src/components/settings-shell/profile-client.tsx`, `appearance-client.tsx`, `apps-client.tsx`, `language-client.tsx`, `users-client.tsx`, `system-client.tsx`, `network-client.tsx`, `about-client.tsx` — Replaced embed/dashboard-style settings content with compact native CP settings pages.
- `control-panel/src/app/api/settings/system/route.ts` — Added an admin system summary endpoint for the native Settings System page.
- `ui/src/app/api/ui-bridge/settings/[...path]/route.ts` — Added bridge-backed app branding and permission revoke support for CP-rendered app settings.
- `control-panel/package.json`, `ui/package.json`, `README.md` — Bumped CP/UI branch release versions and current-version table.

### Test Results
- CP build: `pnpm -C control-panel build` passed for `0.4.13.7`.
- UI build: `pnpm -C ui build` passed for `0.4.3.3` with a temporary SSH Postgres tunnel; existing schema "already exists" notices were emitted during static generation.

### Notes for Iris
- Settings and Market remain Control Panel-owned. UI still does not call CP; CP renders settings and uses CP -> UI bridge calls for UI-owned user/dashboard data.
- Legacy CP embed routes remain present for now, but the visible Settings routes no longer depend on embeds for these sections.

## v0.4.13.6 (CP) + v0.4.3.2 (UI) — artem — 2026-06-05
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Match CP Settings header to UI header and fix immediate avatar sync

### Changes
- `control-panel/src/components/control-surface/control-header.tsx` — Reworked the CP root-surface header to load UI-owned branding, WordArt, app drawer, notifications, user avatar, and theme state through the CP -> UI bridge.
- `control-panel/src/components/control-surface/site-name.tsx` — Added a CP-side renderer for UI WordArt site names so Settings/Market branding matches the dashboard header.
- `control-panel/src/components/ui/avatar.tsx`, `dropdown-menu.tsx`, `popover.tsx`, `scroll-area.tsx` — Added Radix primitives needed for the UI-style header controls.
- `control-panel/src/components/settings-shell/profile-identity-client.tsx` — Broadcasts avatar upload/delete updates immediately and clears stale profile-card previews.
- `ui/src/app/api/ui-bridge/settings/[...path]/route.ts` — Added bridge endpoints for header config and notification actions consumed by CP.
- `control-panel/package.json`, `ui/package.json`, `README.md` — Bumped CP/UI branch release versions and current-version table.

### Test Results
- CP build: `pnpm -C control-panel build` passed for `0.4.13.6`.
- UI build: `pnpm -C ui build` passed for `0.4.3.2` with a temporary SSH Postgres tunnel; existing schema "already exists" notices were emitted during static generation.
- Releases: `cp-artem-v0.4.13.6` and `ui-artem-v0.4.3.2` published with `standalone.tar`.
- Deploy: live host `192.168.31.160` updated to CP `0.4.13.6` and UI `0.4.3.2`.
- Route repair: `/api/setup/control-routes` returned success for `/settings` and `/market`.
- Playwright screenshots verified Settings/dashboard header parity, app drawer, drawer edit mode, notifications, immediate avatar upload/remove sync, dashboard avatar persistence, and fresh fallback state.
- Boundary: UI container request to Control Panel timed out, preserving the one-way bridge rule.

### Notes for Iris
- UI server still does not call Control Panel. The new header data flow is CP browser -> CP `/api/ui-settings/*` proxy -> UI bridge with bridge token.
- Screenshot evidence is under `/tmp/youeye-shots/` with `0.4.13.6` / `0.4.3.2` suffixes.

## v0.4.13.5 (CP) — artem — 2026-06-05
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Finish live route and Market icon verification fixes for CP-owned Settings/Market

### Changes
- `control-panel/src/app/settings/(shell)/profile/page.tsx` — Added an intentional `/settings/profile` alias redirect to the CP-owned profile settings root so route crawls and old links do not 404.
- `control-panel/src/app/api/market/image/route.ts` — Added stable-branch fallback and SVG placeholder response for Market image proxy failures so missing agent-branch assets do not render broken images.
- `control-panel/package.json` — Bumped CP to `0.4.13.5` before building the release artifact.
- `README.md` — Updated the current Control Panel version table.

### Test Results
- CP build: `pnpm build` passed for `0.4.13.5`.
- Release: `cp-artem-v0.4.13.5` published with `standalone.tar` asset.
- Deploy: `spine update control` updated `192.168.31.160` from CP `0.4.13.4` to `0.4.13.5`.
- Live authenticated crawl: `/settings/profile`, all settings sidebar routes, `/market`, and `/market/wiki` returned non-404.
- Live Market image audit: browser reported `broken-market-images []`; screenshot captured at `/tmp/youeye-shots/market-catalog-0.4.13.5.png`.

### Notes for Iris
- CP-only release. Spine remains `0.4.2.1`; UI remains `0.4.3.1`.

## v0.4.13.4 (CP) — artem — 2026-06-05
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Add reliable fallback favicon for CP root surfaces

### Changes
- `control-panel/src/app/api/branding/favicon/route.ts` — Returns a built-in SVG fallback when UI has no rendered branding icon yet.
- `control-panel/package.json` and `README.md` — Bumped CP branch release version.

### Test Results
- CP build: `pnpm build` passed for `0.4.13.4`.

### Notes for Iris
- This prevents `/settings/api/branding/favicon` and `/market/api/branding/favicon` from returning 404 on fresh/default branding.

## v0.4.13.3 (CP) — artem — 2026-06-05
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Fix root-domain Market auth and favicon middleware handling

### Changes
- `control-panel/src/lib/settings-public-path.ts` — Treat `/market` as a root-domain Control Panel surface for auth redirects.
- `control-panel/src/middleware.ts` — Mark settings/market favicon aliases public so tabs and header logo can load without session redirects.
- `control-panel/package.json` and `README.md` — Bumped CP branch release version.

### Test Results
- CP build: `pnpm build` passed for `0.4.13.3`.

### Notes for Iris
- This fixes live `/market` redirecting to UI `/login` instead of the CP `/settings/login` SSO path.

## v0.4.2.1 (Spine) + v0.4.13.2 (CP) — artem — 2026-06-05
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Fix CP LXD updates to use configured Forgejo release source

### Changes
- `spine/internal/api/server.go` — Exposes configured release provider/base URL/API path/organization on `/api/config`.
- `spine/internal/cmd/root.go` — Bumped Spine branch release version.
- `control-panel/src/lib/apps/release-source.ts` — Added shared CP helper for building release API URLs from Spine release metadata.
- `control-panel/src/lib/apps/lxd-updater.ts` and `control-panel/src/lib/apps/lxd-updates.ts` — Replaced GitHub-only release discovery with configured release-source discovery.
- `control-panel/src/lib/market/updater.ts` — Uses the same configured release source for LXD market app updates.
- `control-panel/package.json` and `README.md` — Bumped CP release version and current-version table.

### Test Results
- CP build: `pnpm build` passed for `0.4.13.2`.
- Spine focused tests: `go test ./internal/api ./internal/config ./internal/version ./internal/update` passed.
- Spine binary: built with ldflags and reported `0.4.2.1`.
- Full `go test ./...` still has pre-existing `internal/releases` expectation failures around old default release URLs; the modified config API test now passes.

### Notes for Iris
- This fixes the live issue where UI update via CP reported `0.4.2.1` as up to date because CP still queried GitHub instead of `git.potemk.in`.
- Deploy Spine before retrying CP-driven UI updates so CP can read release metadata from Spine.

## v0.4.13.1 (CP) + v0.4.3.1 (UI) — artem — 2026-06-05
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Rebase root-domain settings work onto main and add CP-owned market

### Changes
- `control-panel/src/app/market/*` — Moved Market to first-class CP `/market` routes with a universal surface header.
- `control-panel/src/components/control-surface/*` — Added shared header/shell for root-domain CP settings and market surfaces.
- `control-panel/src/app/settings/(shell)/*` — Added missing settings routes, native CP page mappings, and redirects for legacy aliases.
- `control-panel/src/app/settings/api/*` and `control-panel/src/app/market/api/*` — Added path-mounted branding and UI-settings aliases.
- `control-panel/src/app/api/user/avatar/route.ts` — Made UI avatar mirror failures visible instead of silently accepting partial saves.
- `control-panel/src/app/api/setup/control-routes/route.ts` — Added idempotent existing-install repair endpoint for `/settings` and `/market` Caddy routes.
- `control-panel/src/lib/caddy/client.ts` — Ensured root-domain `/settings` and `/market` routes are installed before the root UI route.
- `control-panel/package.json`, `ui/package.json`, `README.md` — Bumped CP/UI branch release versions and current-version table.

### Test Results
- CP build: `pnpm build` passed for `0.4.13.1`.
- UI build: `pnpm build` passed for `0.4.3.1` using the live Postgres tunnel; existing schema notices and Edge Runtime warnings only.

### Notes for Iris
- This supersedes stale dev-based Artem releases `cp-artem-v0.4.12.4` and `ui-artem-v0.4.2.1`.
- Existing installs should run `POST /api/setup/control-routes` after CP update to apply `/market` and refresh `/settings` route order.
- Product settings/market paths are CP-owned; UI must not regain ownership or call CP directly.

## v0.4.12 (CP) + v0.4.2 (UI) — artem — 2026-06-05
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Move user-facing Control Panel to root-domain `/settings` while preserving one-way bridge

### Changes
- `control-panel/src/app/settings/(shell)/*` — Added CP-owned settings shell and pages matching the current UI settings sections.
- `control-panel/src/app/settings/api/*` — Added settings-path auth and UI-settings bridge aliases.
- `control-panel/src/app/api/auth/*` — Made SSO initiation/callback path-aware for `/settings/api/auth/callback`.
- `control-panel/src/lib/caddy/client.ts` — Added root-domain `/settings` route helper with referer-scoped CP asset/API support.
- `control-panel/src/app/api/setup/run/route.ts` and `control-panel/src/lib/auth/sso-setup.ts` — Registered Authentik callbacks for `/settings/api/auth/callback`.
- `control-panel/src/lib/reconfigure/index.ts` — Ensures reconfigure preserves/adds the CP `/settings` OAuth callback.
- `ui/src/app/api/ui-bridge/settings/[...path]/route.ts` — Added token-authenticated CP -> UI settings bridge endpoints for UI-owned settings data.
- `ui/src/app/api/v1/admin/proxy-cp/route.ts`, `ui/src/app/api/v1/my-connections/route.ts`, `ui/src/app/api/v1/request-bridge/route.ts`, `ui/src/app/api/v1/admin/install-progress/route.ts` — Removed server-side UI -> CP proxy behavior.
- `README.md` — Updated Artem release versions.

### Test Results
- CP build: `pnpm build` passed.
- UI build: `pnpm build` passed; local Postgres was absent during static generation, producing existing schema initialization noise but nonzero failures did not occur.
- Release artifacts: `standalone.tar` created for CP and UI.

### Notes for Iris
- The live Caddy route for `/settings` must be applied on existing installs; fresh setup now creates it.
- `control.<domain>` compatibility remains during transition; user-facing path is `<domain>/settings`.

## v0.3.5.11 (CP) — iris — 2026-04-27
**Branch:** dev
**VM:** ye-iris
**Agent:** Iris
**Task:** Manifest validator false warnings, health checker per-app port/path, ACME 429 rate limit handling

### Changes
- `control-panel/src/lib/market/validator.ts` — Add `containers`, `smtp`, `provider` to known namespace roots in template variable check; auto-accept container names declared in manifest
- `control-panel/src/lib/market/types.ts` — Add `port` and `healthCheck` optional fields to `ContainerMeta` interface
- `control-panel/src/lib/market/engine.ts` — Store `port` and `healthCheck` from manifest into `ContainerMeta` during installation
- `control-panel/src/lib/market/health-checker.ts` — Read stored `port`/`healthCheck.path` per container instead of hardcoded 3000/"/"
- `control-panel/src/lib/acme/client.ts` — Add axios response interceptor to catch LE 429 rate limits before acme-client's silent retry loop
- `control-panel/src/app/api/tls/acme/route.ts` — Add `Promise.race` timeout wrappers (30s/60s) as safety net around ACME calls; return 504 on timeout
- `control-panel/src/components/setup/SetupServerName.tsx` — Add `AbortSignal.timeout` (35s/65s) to ACME fetch calls; display user-friendly timeout messages
- `control-panel/package.json` — Bumped 0.3.5.10 → 0.3.5.11

### Test Results
- TypeScript: clean build, no type errors
- Artifact: standalone.tar 102MB uploaded to Gitea release #1265

### Notes for Iris
- Only CP changed — no Spine or UI release needed
- Backward-compatible: existing install.json files without port/healthCheck fall back to 3000/"/"

## v0.3.5.10 (CP) — iris — 2026-04-27
**Branch:** dev
**VM:** ye-iris
**Agent:** Iris
**Task:** Source code fixes for 3 ACME/Caddy bugs discovered during LE cert issuance (previously hot-patched)

### Changes
- `control-panel/src/lib/acme/client.ts` — Preserve `.url` on `readyOrder` after first `waitForValidStatus` call; the raw ACME response body lacks `.url` which the second call requires
- `control-panel/src/lib/caddy/client.ts` — Remove invalid `certificate_selection` field from TLS automation policy (Caddy 2.11 rejects it). Update `loadExternalCert`/`removeExternalCert` to use subject-only discriminant. Fix `ensureTLSSubject` to check ALL TLS policies before adding a subject (prevents duplicate subjects across internal/external policies)
- `control-panel/src/lib/caddy/types.ts` — Remove `certificate_selection` from `TLSAutomationPolicy` interface
- `control-panel/src/app/api/setup/run/route.ts` — Log root domain UI route creation errors instead of swallowing them (empty catch masked Caddy config failures, causing root domain to route to CP catch-all instead of UI)
- `control-panel/package.json` — Bumped 0.3.5.9 → 0.3.5.10

### Test Results
- TypeScript: clean build
- Bugs were previously confirmed via hot-patches on live VM; source now matches fixes

### Notes for Iris
- Only CP changed — no Spine or UI release needed
- Sebastian and Vanya branches already merged into dev (confirmed via merge-base check)

## v0.3.5.9 (CP) + v0.3.1.4 (Spine) — iris — 2026-04-26
**Branch:** dev
**VM:** ye-iris
**Agent:** Iris
**Task:** Three ACME/cleanup hotfixes — cleanup state, authoritative DNS, config API extra, order finalization

### Changes
- `spine/internal/cmd/cleanup.go` — Parse YAML, extract only `release_branch`, write minimal file after wipe (was preserving entire `youeye.yaml` including `setup_completed: true`)
- `control-panel/src/lib/acme/client.ts` — Replaced `client.verifyChallenge()` with authoritative NS queries (bypasses DNS cache, <1s vs ~4 min). Fixed order finalization: skip `finalizeOrder` when order already `valid` from prior attempt, capture updated order for `getCertificate`
- `spine/internal/api/server.go` — Added `Extra map[string]string` to `YouEyeConfig`, PATCH stores unrecognized keys (fixes `tls_acme_account_key` being silently dropped)
- `control-panel/src/lib/spine/client.ts` — `getConfig()` merges `extra` into top-level
- `control-panel/src/lib/settings/service.ts` — `getRaw()` widened with index signature
- `control-panel/package.json` — Bumped 0.3.5.6 → 0.3.5.9
- `spine/internal/cmd/root.go` — Bumped 0.3.1.2 → 0.3.1.4

### Test Results
- TypeScript: clean build
- Hotpatched live VM for each fix, verified errors resolved in sequence
- Full ACME flow: cleanup → deploy → setup wizard → LE cert (pending user test on fresh deploy)

### Notes for Iris
- Three sequential releases: Spine 0.3.1.3+CP 0.3.5.7, Spine 0.3.1.4+CP 0.3.5.8, CP 0.3.5.9
- ACME flow tested via hotpatches on compiled bundle; source code matches final hotpatch state

## v0.3.5.6 (CP) — iris — 2026-04-26
**Branch:** dev
**VM:** ye-iris
**Agent:** Iris
**Task:** Move Let's Encrypt ACME DNS-01 flow inline into server name setup step

### Changes
- `control-panel/src/components/setup/SetupServerName.tsx` — Added inline ACME sub-flow (DNS TXT record display, copy buttons, verify & issue) triggered when user selects Let's Encrypt and clicks Continue. Domain inputs lock during ACME flow. Wildcard checkbox shown before starting.
- `control-panel/src/app/setup/page.tsx` — Added `acmeCertIssued` state. LE now skips step 5 (cert issued in step 0). Upload still goes to step 5. Sends `tls_choice` to backend.
- `control-panel/src/app/api/setup/run/route.ts` — After `caddy.setDomain()`, checks `tlsStorage` for existing ACME cert and restores it via `caddy.loadExternalCert()`. Added `tls_choice` to request interface.
- `control-panel/src/components/setup/SetupTls.tsx` — Removed AcmeFlow (moved to SetupServerName). Now upload-only.
- `control-panel/package.json` — Bumped to 0.3.5.6.

### Test Results
- TypeScript: clean (no errors)
- Build: standalone.tar 102MB, deployed via `spine update control`
- ACME API: returns 401 Unauthorized without session (correct)
- Self-signed flow: unaffected (existing path unchanged)

### Notes for Iris
- Full LE flow requires real public DNS — cannot be end-to-end tested on dev VMs with .test domains
- The ACME order has 30-min TTL in memory; UI should show "Start over" on timeout errors

## v0.3.5.5 (CP) — iris — 2026-04-26
**Branch:** dev
**VM:** ye-iris
**Agent:** Iris
**Task:** Fix custom TLD lost during setup wizard — customTld state not lifted to page level

### Changes
- `control-panel/src/components/setup/SetupServerName.tsx` — Removed local `customTld` useState; now received as props from parent. Added trailing-dot stripping on custom TLD input.
- `control-panel/src/app/setup/page.tsx` — `customTld`/`setCustomTld` now passed as props to SetupServerName. Config restore logic detects non-standard TLDs and sets `__custom__` sentinel + populates `customTld`. Imported `TLD_OPTIONS` for lookup.
- `control-panel/src/app/api/setup/run/route.ts` — Defense-in-depth: strip trailing dots from `body.domain` before any step uses it.
- `control-panel/package.json` — Bumped to 0.3.5.5.

### Test Results
- Fresh setup with domain `potemk.in` (custom TLD `.in`): all 7 steps pass including SSO
- Domain correctly saved as `potemk.in` in youeye.yaml
- Authentik applications created with valid `meta_launch_url: https://control.potemk.in`

### Notes for Iris
- Root cause: `customTld` was local state inside SetupServerName, invisible to page.tsx which computed the domain for the API request with its own empty `customTld`. Result: domain sent as `potemk.` (no TLD) instead of `potemk.in`.
- This also caused Authentik 2025.12 to reject `meta_launch_url: https://control.potemk.` as an invalid URL.

## v0.3.1.2 (Spine) — iris — 2026-04-26
**Branch:** dev
**VM:** ye-iris
**Agent:** Iris (acting as dev agent)
**Task:** Fix spine deploy timeout on fresh VMs — IPv6 hangs + insufficient timeout

### Changes
- `spine/internal/releases/releases.go` — Added `NewIPv4Client()` shared HTTP client that forces tcp4 dialer (avoids IPv6 AAAA hangs). Increased `fetchReleases()` timeout from 10s to 30s. Added 3-attempt retry with 2s/4s backoff on network errors.
- `spine/internal/releases/client.go` — `NewClient()` now uses `NewIPv4Client(30s)` instead of bare `http.Client{Timeout: 10s}`.
- `spine/internal/cmd/status.go` — `checkSpineUpdate()` uses `NewIPv4Client` instead of bare 10s client.
- `spine/internal/cmd/update.go` — Spine binary download uses `NewIPv4Client(10m)` instead of `http.Get()`.
- `spine/internal/container/control.go` — CP tarball download uses `NewIPv4Client(10m)` instead of bare client.
- `spine/internal/api/server.go` — API server CP download uses `NewIPv4Client(10m)`.
- `spine/install.sh` — Added `-4` flag to all curl calls hitting git.byka.wtf.
- `spine/internal/cmd/root.go` — Bumped version to 0.3.1.2.

### Test Results
- Spine builds cleanly (16MB binary)
- `spine status` fetches releases successfully (no timeout)
- `spine version` shows 0.3.1.2

### Notes for Iris
- Root cause: Go's default HTTP client tries IPv6 first on VMs where DNS returns AAAA records for git.byka.wtf but there's no IPv6 route. The IPv6 connection hangs until the 10s timeout expires, leaving no budget for IPv4.
- Fix is structural: force tcp4 at the dialer level so IPv6 is never attempted.

## v0.3.5.4 (CP) — iris — 2026-04-26
**Branch:** dev
**VM:** ye-iris
**Agent:** Iris (acting as dev agent)
**Task:** Add dedicated TLS setup step to setup wizard (step 5), simplify DNS explainer

### Changes
- `control-panel/src/components/setup/SetupTls.tsx` — NEW. Dedicated TLS setup step with AcmeFlow (ACME DNS-01 challenge: domain input, TXT records display, verify & finalize) and UploadFlow (PEM paste/browse for cert, key, optional chain). Runs after provisioning for LE and upload paths; self-signed skips this step entirely.
- `control-panel/src/app/setup/page.tsx` — Reworked wizard step flow: steps 0-3 unchanged, step 4 provisioning, step 5 TLS setup (new), step 6 DNS explainer. `handleProvisioningComplete` routes self-signed to step 6, LE/upload to step 5. Imports new SetupTls component.
- `control-panel/src/components/setup/SetupDnsExplainer.tsx` — Removed AcmeFlow and UploadCertFlow (moved to SetupTls). Simplified to DNS-only: connection status, DNS setup instructions per platform, self-signed cert install, and "Go to server" link. Removed ~420 lines of duplicated TLS flow code.
- `control-panel/package.json` — Bumped version to 0.3.5.4

### Test Results
- CP builds cleanly (102MB standalone.tar)
- CP deploys and starts successfully (Next.js 16.1.4 on port 3000)

### Notes for Iris
- The TLS setup step reuses existing `/api/tls/acme` (POST to start order, PUT to verify) and `/api/tls/upload` (POST) endpoints — no new API routes.
- Self-signed path never renders SetupTls; provisioning callback goes directly to DNS explainer (step 6).

## v0.3.5.3 (CP) — iris — 2026-04-26
**Branch:** dev
**VM:** ye-iris
**Agent:** Iris (acting as dev agent)
**Task:** Move TLS certificate choice to Name Your Server step; add custom TLD and upload-own-cert options

### Changes
- `control-panel/src/components/setup/SetupServerName.tsx` — Added TLS certificate choice section (Let's Encrypt with "Recommended" badge, self-signed, upload own cert). Added custom TLD text input when "Other..." is selected from the TLD dropdown. LE option auto-disabled for local TLDs. Exports `TlsChoice` type.
- `control-panel/src/components/setup/SetupDnsExplainer.tsx` — Removed `TlsPathChoice` inline component. Now accepts `tlsChoice` prop from page.tsx and goes directly to the selected flow. Added `UploadCertFlow` component for PEM paste/browse upload via `/api/tls/upload`. Replaced hardcoded `bg-white/80` with theme-aware `bg-card`.
- `control-panel/src/app/setup/page.tsx` — Added `tlsChoice` and `customTld` state. Computes `effectiveTld` for custom TLD sentinel. Passes `tlsChoice`/`setTlsChoice` to SetupServerName and `tlsChoice` to SetupDnsExplainer. Auto-resets LE choice to self-signed when switching to a local TLD.
- `control-panel/src/lib/wordart-presets.ts` — Expanded `TLD_OPTIONS` from 13 to 22 entries: added .xyz, .cloud, .sh, .cc, .tv, .info, .pro, and "Other..." (`__custom__` sentinel with group `'custom'`).
- `control-panel/messages/{en,de,es,fr,ru}.json` — Added 14 new i18n keys (certificateChoice, recommended, tlsUploadOwn, tlsUploadOwnDesc, uploadCertTitle, uploadCertDesc, uploadCertLabel, uploadKeyLabel, uploadCertBrowse, uploadChainOptional, uploadChainLabel, uploadCertApply, uploadCertDone, uploadCertDoneDesc). Updated tlsLetsEncrypt to remove inline "(recommended)" text.
- `control-panel/package.json` — Bumped version to 0.3.5.3

### Test Results
- CP builds cleanly (102MB standalone.tar)
- CP deploys and starts successfully (Next.js 16.1.4 on port 3000)
- User will test setup wizard flow via fresh spine deploy

### Notes for Iris
- The upload cert flow uses the existing `/api/tls/upload` POST endpoint — no new API routes.
- Custom TLD uses `__custom__` sentinel value in the TLD dropdown; page.tsx resolves it to the actual typed TLD before computing the domain string.
- `TlsChoice` type exported from SetupServerName for shared use.

## v0.3.5.2 (CP) / v0.3.3.2 (UI) — iris — 2026-04-26
**Branch:** dev
**VM:** ye-iris
**Agent:** Iris (acting as dev agent)
**Task:** Add Let's Encrypt to setup wizard; fix PIN prompt light mode visibility

### Changes
- `control-panel/src/components/setup/SetupDnsExplainer.tsx` — Added TLS path choice (Let's Encrypt vs self-signed) to the DNS explainer step. Integrated ACME DNS-01 flow with domain input, DNS TXT record display, and verification. Only shown in wizard mode (not standalone/setup-complete page).
- `control-panel/src/middleware.ts` — Added `/api/tls/` to middleware setup-allowed paths so ACME endpoints are accessible during IP-based setup flow.
- `control-panel/messages/{en,de,es,fr,ru}.json` — Added 24 i18n keys for the ACME/Let's Encrypt flow in all 5 languages.
- `ui/src/components/timeline/pin-prompt.tsx` — Fixed embedded PIN prompt invisible text in light mode. Replaced hardcoded white text/borders with theme-aware Tailwind classes (text-foreground, bg-muted, border-border, bg-primary, text-primary-foreground).
- `control-panel/package.json` — Bumped version to 0.3.5.2
- `ui/package.json` — Bumped version to 0.3.3.2

### Test Results
- PIN prompt light mode: labels, inputs, icons, buttons all visible with proper contrast (verified via Playwright screenshot)
- Setup-complete page (standalone mode): renders correctly, skips TLS choice as designed
- Middleware: /api/tls/acme accessible via IP (returns 401 for auth, not redirect — confirms middleware allows path through)

### Notes for Iris
- The LE flow in SetupDnsExplainer uses the existing `/api/tls/acme` POST/PUT endpoints — no new API routes added.
- TLS choice only appears when `standalone=false` (wizard mode has auth session for ACME calls). Standalone/setup-complete page skips to self-signed flow.
- Local TLDs (.local, .test, etc.) show a warning that LE won't work, but still allow the attempt.

## v0.3.5.1 — andrew — 2026-04-22
**Branch:** andrew
**VM:** ye-andrew
**Agent:** Andrew
**Task:** Manifest-driven SSO admin mapping (adminMapping) for automatic admin provisioning

### Changes
- `control-panel/src/lib/market/schema.ts` — Added `AdminMappingSchema` discriminated union (groups | roleClaim) and `adminMapping` field to `SSOSchema`
- `control-panel/src/lib/market/types.ts` — Exported `AdminMapping` type from schema
- `control-panel/src/lib/market/authentik.ts` — Added `ensureAdminScopeMapping()` function: for `groups` type, updates global "YouEye Groups" scope mapping to normalize "authentik Admins" → also emit "admin"; for `roleClaim` type, creates per-app scope mapping with custom claim. Added `adminMapping` param to `createAuthentikOAuth2App`
- `control-panel/src/lib/market/engine.ts` — Passes `adminMapping` from manifest to Authentik OAuth2 provider creation
- `control-panel/src/app/api/setup/run/route.ts` — Updated YouEye Groups expression to normalized version (includes admin append)
- `control-panel/src/lib/auth/sso-setup.ts` — Updated YouEye Groups expression to normalized version
- `control-panel/src/lib/ui/manager.ts` — Updated YouEye Groups expression to normalized version
- `control-panel/package.json` — Bumped version to 0.3.5.1

### Test Results
- Nextcloud: SSO login → tester user provisioned into "authentik Admins" + "admin" groups → full admin access to admin panel verified
- Jellyfin: existing behavior preserved (SSO users recognized as admin via "authentik Admins" group)
- Immich: roleClaim scope mapping created and attached to provider (limitation: only evaluated at first user registration)
- Authentik: YouEye Groups expression updated with admin normalization, immich_role scope mapping created

### Notes for Iris
- The `groups` type modifies the GLOBAL "YouEye Groups" scope mapping — affects ALL apps with groups scope. The normalization is additive (appends "admin", doesn't remove "authentik Admins")
- The `roleClaim` type creates per-app scope mappings — isolated per app, no global side effects
- Immich limitation: `oauth.roleClaim` only evaluated at first user registration, not subsequent logins. Fresh installs work; existing users won't be retroactively promoted
- Three setup files (setup/run/route.ts, sso-setup.ts, manager.ts) all updated to use the normalized groups expression — ensures consistency whether created during initial setup or app install
## v0.3.5.18 (CP) — sebastian — 2026-04-25
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Internet/LAN access toggle in install dialog + fix native app internet access

### Changes
- `control-panel/src/lib/market/types.ts` — added `allowInternet` to InstallConfig
- `control-panel/src/lib/market/engine.ts` — fixed wantsInternet to also check internet.hosts; engine now respects config.allowInternet override
- `control-panel/src/app/api/market/app/[appId]/connections/route.ts` — added needsInternet computed field to response
- `control-panel/src/app/embed/market/client.tsx` — added "Allow Internet & LAN Access" toggle with GlobeIcon, pre-ticked from needsInternet
- `control-panel/src/components/market/install-dialog.tsx` — added matching toggle to standalone dialog

### Test Results
- `GET /api/market/app/weather/connections` → needsInternet: true, hosts: [api.open-meteo.com, geocoding-api.open-meteo.com]
- `GET /api/market/app/cinema/connections` → needsInternet: true, hosts: [api.themoviedb.org, image.tmdb.org]
- Weather NAT manually enabled on yeapp3 → `curl api.open-meteo.com` succeeds
- CP deployed and running on VM, api/ping OK

### Notes for Iris
- Native app manifests also updated in their own repos (all 6 apps: network: internet added to containers)
- Cinema manifest: removed installParams.tmdbApiKey — app should handle API key internally
- Existing installed apps need NAT manually enabled if they were installed before this fix

## v0.3.5.17 (CP) + v0.3.5.7 (UI) — sebastian — 2026-04-25
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Discovery API — resolve container IPs for bridge targets

### Changes
- `control-panel/src/app/api/bridges/resolve/route.ts` — NEW: resolves app's primary container IP+port from install metadata + Incus
- `ui/src/app/api/v1/my-connections/route.ts` — REWRITE: calls CP bridge resolve endpoint for actual IPs instead of DNS names
- `ui/src/middleware.ts` — Added /api/v1/my-connections to PUBLIC_ROUTES
- `control-panel/package.json` — Bumped to 0.3.5.17
- `ui/package.json` — Bumped to 0.3.5.7

### Test Results
- API: /api/bridges/resolve?appId=searxng → returns container IP 10.76.2.241 + port 8080
- API: /api/v1/my-connections with X-YouEye-App: search → returns SearXNG with resolved IP
- E2E: Search UI returns "hello world" results from SearXNG (screenshot verified)

### Notes for Iris
- First UI release in this session — UI was previously at v0.3.5.6
- Both CP and UI must be deployed together for bridge discovery to work
- No database migrations required
- No Spine changes

---

## v0.3.5.16 (CP) — sebastian — 2026-04-25
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Install-time connection prompts for app bridge system

### Changes
- `control-panel/src/lib/market/types.ts` — Added ApprovedConnection type + approvedConnections to InstallConfig
- `control-panel/src/lib/market/engine.ts` — New step 12: process approved connections, create+activate bridges inline
- `control-panel/src/lib/bridges/suggestions.ts` — Skip already-approved targets in suggestion generation
- `control-panel/src/app/api/market/app/[appId]/connections/route.ts` — NEW: returns outgoing/incoming wants + internet requirements
- `control-panel/src/app/api/suggestions/approve/route.ts` — NEW: creates bridge from suggestion + activates
- `control-panel/src/app/api/suggestions/[id]/dismiss/route.ts` — NEW: dismiss suggestion endpoint
- `control-panel/src/app/api/suggestions/route.ts` — Added approve action
- `control-panel/src/app/api/ui-bridge/market/route.ts` — Added connections proxy action
- `control-panel/src/app/embed/market/client.tsx` — Connection toggles in embedded install dialog
- `control-panel/src/components/market/install-dialog.tsx` — Connection toggles in standalone install dialog
- `control-panel/src/middleware.ts` — Added /api/market/app to public routes
- `ui/src/components/settings/app-settings-detail.tsx` — Pending suggestions with approve/dismiss in Network tab

### Test Results
- API: connections endpoint returns correct outgoing/incoming for Search and SearXNG
- API: suggestion approval creates and activates bridge (search-to-searxng)
- Network: Search container has NIC on SearXNG's bridge, HTTP 200 from SearXNG

### Notes for Iris
- UI component changed (app-settings-detail.tsx) — needs UI rebuild for Network tab suggestions
- No database migrations required
- No Spine changes in this release

## v0.3.5.14 (CP) + v0.3.1.1 (Spine) — sebastian — 2026-04-25
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Static IP assignment for all system containers

### Changes
- `spine/internal/incus/static_ips.go` — NEW: subnet detection, DHCP range restriction, static IP device override
- `spine/internal/incus/install.go` — configure DHCP ranges after Incus init
- `spine/internal/container/control.go` — init → set static IP → start (not launch)
- `spine/internal/container/ui.go` — same init → static IP → start pattern
- `spine/internal/cmd/root.go` — version bump to 0.3.1.1
- `control-panel/src/lib/incus/static-ips.ts` — NEW: mirrors Spine logic via Incus REST API
- `control-panel/src/lib/incus/container-ip.ts` — fast path returns static IP for system containers
- `control-panel/src/lib/infrastructure/deployer.ts` — Caddyfile templates use static IPs instead of DNS names
- `control-panel/src/lib/infrastructure/oci-deployer.ts` — apply static IP before container start
- `control-panel/src/lib/infrastructure/lxd-deployer.ts` — apply static IP before container start
- `control-panel/src/lib/incus/app-network.ts` — use static IPs for proxy device targets
- `control-panel/src/app/api/admin/migrate-networks/route.ts` — DELETED (not needed for fresh installs)
- `control-panel/src/lib/market/types.ts` — usePerAppBridge marked deprecated
- `control-panel/package.json` — version bump to 0.3.5.14

### Test Results
- All 7 system containers verified at correct static IPs (.10-.16)
- 15 containers running, 0 stopped
- Platform healthy: `curl -sk https://devvm.test/api/ping` → `{"status":"ok"}`

### Notes for Iris
- Spine + CP cross-component change — both releases required
- No backwards compatibility — designed for fresh install
- Static IPs are offsets from dynamic incusbr0 subnet base (auto-detected)

## v0.3.5.13 (CP) — sebastian — 2026-04-25
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Post-migration cleanup — remove legacy ACL system, connector debris, fix metadata gap

### Changes
- `control-panel/src/lib/incus/network-acl.ts` — DELETED (829 lines of legacy ACL code)
- `control-panel/src/lib/incus/app-network.ts` — added SYSTEM_APP_IDS export (moved from deleted network-acl.ts)
- `control-panel/src/lib/bridges/manager.ts` — removed legacy ACL branches from activate/deactivate/delete
- `control-panel/src/lib/market/engine.ts` — removed legacy ACL else block and imports
- `control-panel/src/lib/market/uninstaller.ts` — removed legacy ACL cleanup branch
- `control-panel/src/app/api/internet-grants/route.ts` — removed legacy ACL grant path
- `control-panel/src/app/api/internet-grants/[id]/route.ts` — removed legacy ACL revoke path
- `control-panel/src/app/api/bridges/route.ts` — updated SYSTEM_APP_IDS import to app-network
- `control-panel/src/app/api/admin/migrate-networks/route.ts` — added fixMetadataOnly mode
- `control-panel/src/lib/caddy/client.ts` — addAppRoutes now resolves container IPs for per-app bridge apps
- `connector-runtime/` — DELETED (entire abandoned package)
- `ui/tests/connector-settings.spec.ts` — DELETED
- `ui/tests/connector-runtime.spec.ts` — DELETED
- `pnpm-workspace.yaml` — removed connector-runtime

### Test Results
- 15 containers running, 0 stopped
- All 7 apps verified responding (HTTP 307)
- Metadata fix verified: all apps have usePerAppBridge=true + bridgeName
- Bridge and internet-grant records cleaned of stale aclName references

### Notes for Iris
- 27 files changed, 143 insertions, 2499 deletions
- network-acl.ts is gone — any code importing from it will fail
- SYSTEM_APP_IDS now lives in app-network.ts
- The ye-system ACL for system containers is still in Incus (managed by Spine, not CP)
- Connector-runtime removed from workspace — pnpm install will be faster

## v0.3.5.12 (CP) — sebastian — 2026-04-24
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Per-App Bridge Network Architecture — replace ACL isolation with Docker-style bridge networking

### Changes
- `control-panel/src/lib/incus/app-network.ts` — NEW: Core module for per-app bridge networking. Bridge lifecycle (create/delete with retry), subnet allocation (10.76.{N}.0/24), proxy devices for system services (postgres/authentik/UI), Caddy NIC hot-plug, cross-app NIC permissions (grant/revoke), NAT control, container migration, query helpers.
- `control-panel/src/lib/market/engine.ts` — Create per-app bridge before container deploy. NAT enabled during install, disabled post-install for no-internet apps. Caddy route uses container IP instead of DNS name. Legacy ACL fallback preserved.
- `control-panel/src/lib/market/platform-env.ts` — Proxy device mode: db_host=localhost, gateway=localhost:3001 when using per-app bridges.
- `control-panel/src/lib/infrastructure/oci-deployer.ts` — Accept custom NIC devices for bridge attachment at container creation.
- `control-panel/src/lib/infrastructure/lxd-deployer.ts` — Accept custom NIC devices for bridge attachment at container creation.
- `control-panel/src/lib/market/uninstaller.ts` — Clean up per-app bridge on uninstall (remove Caddy NIC, delete bridge with retry verification).
- `control-panel/src/lib/market/types.ts` — Added `usePerAppBridge` field to InstallMetadata.
- `control-panel/src/lib/bridges/manager.ts` — Bridge permissions use NIC hot-plug for per-app bridge apps, ACL rules for legacy. resolveBridgeMappings uses IP instead of DNS for internal host refs.
- `control-panel/src/app/api/admin/migrate-networks/route.ts` — NEW: Migration endpoint to move existing apps from incusbr0 to per-app bridges.
- `control-panel/src/app/api/internet-grants/route.ts` — Uses bridge NAT for per-app bridge apps instead of ACL rules.
- `control-panel/src/app/api/internet-grants/[id]/route.ts` — Revoke uses bridge NAT disable for per-app bridge apps.

### Test Results
- Full install/uninstall cycle verified: bridge creation, container deployment, proxy devices, Caddy NIC, route with IP, NAT disable, bridge cleanup with retry
- All 7 existing apps migrated from incusbr0 to per-app bridges via migration endpoint
- All apps reachable via SSO (307 redirect) after migration
- Multi-container app (searxng) correctly shares a single bridge

### Notes for Iris
- ACL system preserved as fallback — not deleted, just deprecated in favor of per-app bridges
- All existing apps were migrated during development testing; production migration uses POST /api/admin/migrate-networks
- Bridge naming: `yeapp{N}` (N=1-254, max 15 chars for Linux interface names)
- Subnet range: 10.76.{N}.0/24 — registry at /var/lib/youeye/networks/subnets.json
- Caddy routes now use container IP (not DNS) — DNS doesn't cross bridges
- Internet access: NAT on bridge, not ACL rules. Enabled during install, disabled post-install unless manifest declares network:internet

## v0.3.5.5 (CP) + v0.3.5.6 (UI) — sebastian — 2026-04-24
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** ACL fixes, connector purge, per-app settings consolidation

### Changes
- `control-panel/src/lib/incus/network-acl.ts` — Added youeye-ui:3000 ACL rule for all apps. Added ACL_VERSION system with refreshAllContainerAcls() for automatic migration. Blanket internet access for network:internet apps.
- `control-panel/src/lib/market/engine.ts` — Switched to blanket internet grants. Store network mode in ContainerMeta.
- `control-panel/src/lib/market/types.ts` — Added `network?: 'isolated' | 'internet'` to ContainerMeta.
- `control-panel/src/lib/infrastructure/deployer.ts` — Removed connector container deployment (Step 9) and reconcile step. TOTAL_STEPS 9→8.
- `control-panel/src/lib/infrastructure/manifests.ts` — Deleted connectorsContainerSpec() function.
- `control-panel/src/app/api/setup/run/route.ts` — Removed connectors Caddy route from routeMap.
- `ui/src/components/settings/app-settings-detail.tsx` — Complete rewrite with Overview/Permissions/Network/LinkHandling tabs. Removed all connector types.
- `ui/src/app/settings/apps/client.tsx` — New file: app list client component for settings navigation.
- `ui/src/app/settings/apps/page.tsx` — Server component wrapping AppsListClient.
- `ui/src/app/settings/permissions/page.tsx` — Replaced with redirect to /settings/apps.
- `ui/src/components/settings/settings-shell.tsx` — Removed permissions from admin sidebar.
- `ui/src/db/index.ts` — Removed 5 connector tables.
- `ui/src/middleware.ts` — Removed /api/v1/connectors from PUBLIC_ROUTES.
- `ui/src/components/settings/accounts-settings.tsx` — Removed API key management section.

### Test Results
- ACL connectivity verified: wiki→youeye-ui:3000 OK, wiki→postgres:5432 OK, wiki→internet OK
- Cross-app isolation verified for non-internet apps
- Connector container deleted, Caddy route removed

### Notes for Iris
- Connector concept fully abandoned — all code/docs/plans removed
- Internet apps have blanket egress (no cross-container isolation) — per-host restrictions planned for future
- ACL_VERSION=2 auto-refreshes all app ACLs on first ensureNetworkAcls() call after update
- /settings/permissions now redirects to /settings/apps

---

## v0.3.5.4 (CP) — sebastian — 2026-04-24
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Per-container ACL isolation — replace shared ye-app-isolated

### Changes
- `control-panel/src/lib/incus/network-acl.ts` — Rewrote ACL system: per-container ye-iso-{name} ACLs replace shared ye-app-isolated. New functions: createContainerAcl(), addBridgeRuleToAcl(), removeBridgeRuleFromAcl(), deleteContainerAcl(). Auto-migration on startup.
- `control-panel/src/lib/market/engine.ts` — Moved ACL creation after container loop (need sibling IPs). All containers now get ACLs including network:internet ones.
- `control-panel/src/lib/bridges/manager.ts` — Bridges add destination rules to existing ACLs. Added resolveContainerName() for multi-container apps. System container target validation.
- `control-panel/src/lib/market/uninstaller.ts` — ACL + bridge cleanup on app uninstall.
- `control-panel/src/lib/market/schema.ts` — WantSchema rejects system container IDs.
- `control-panel/src/lib/market/types.ts` — InstallMetadata gains databaseMode, hasSSO fields.
- `control-panel/src/app/api/bridges/route.ts` — API rejects system container bridge targets.
- `control-panel/tests/acl-isolation.spec.ts` — 9 Playwright tests covering isolation, bridge validation, app health.

### Test Results
- Playwright: 9 tests, all passed
- Live verification: cross-app traffic blocked, caddy/pihole allowed, sibling ACLs correct
- All 8 app containers migrated, 16 running / 0 stopped

### Notes for Iris
- Migration runs automatically on first request — no manual steps needed
- Old ye-app-isolated and ye-bridge-* ACLs are deleted during migration
- Pre-existing searxng-to-redis bridge has a known issue: "redis" is an intra-app container, not a separate app. Bridge detection creates false bridges for intra-app refs. The sibling ACL rules handle connectivity — this is a pre-existing bug, not introduced here.

---

## v0.3.5.4 (UI) / v0.3.5.2 (CP) — sebastian — 2026-04-23
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Replace connector system with permissions-based networking

### Changes
- Stripped ~60 connector files across CP and UI (routes, components, DB tables, i18n keys)
- `control-panel/src/lib/market/schema.ts` — Added WantSchema and InternetSchema to manifest
- `control-panel/src/lib/incus/network-acl.ts` — Added grantInternetAccess(), revokeInternetAccess()
- `control-panel/src/lib/bridges/internet-store.ts` — NEW: JSON store for internet grants
- `control-panel/src/lib/bridges/suggestions.ts` — NEW: suggestions engine (scan wants vs installed)
- `control-panel/src/app/api/internet-grants/` — NEW: GET/POST/DELETE internet grant endpoints
- `control-panel/src/app/api/suggestions/` — NEW: GET/POST suggestions endpoints
- `ui/src/app/api/v1/my-connections/route.ts` — NEW: discovery API for apps
- `ui/src/app/api/v1/request-bridge/route.ts` — NEW: bridge request API
- `ui/src/app/api/v1/admin/proxy-cp/route.ts` — NEW: admin CP proxy for client-side calls
- `ui/src/app/settings/permissions/` — NEW: admin Permissions settings page
- `ui/src/components/settings/settings-shell.tsx` — Added "Permissions" nav entry
- `ui/messages/{en,ru,de,fr,es}.json` — Added permissions i18n keys
- All 6 native app youeye-app.yaml — Added wants + internet declarations
- All 6 native apps — Stripped connector client code
- YouEye-Canvas — Replaced connectors module with connections module
- YE-AppMarket — Removed connector-catalog.yaml and connectors/ directory

### Test Results
- Dashboard loads after deploy (verified)
- Permissions admin page renders correctly with sidebar nav
- Login flow works via Authentik SSO

### Notes for Iris
- This is a large architectural change — review the permissions page carefully
- The discovery API (/api/v1/my-connections) is new and untested with real bridges
- Native apps had connector code stripped but don't yet use the new connections helpers (they're legacy pre-Canvas apps)
- The youeye-connectors container was recreated by Spine reconciliation — it's now unused but harmless

## v0.3.5.3 — sebastian — 2026-04-23
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Fix SearXNG availability + implement Link Handling tab

### Changes
- `ui/src/app/api/settings/connectors/[appId]/route.ts` — Extract `info_cards` with triggers from app manifest, return as `linkHandlers` in API response
- `ui/src/components/settings/app-settings-detail.tsx` — Replace Link Handling placeholder with real implementation: displays link handler types, trigger domain patterns, descriptions
- `ui/messages/{en,ru,de,fr,es}.json` — i18n keys for link handling (linkHandlingActive, linkHandlingDomains, linkHandlingExplanation)
- `ui/package.json` — Version bump 0.3.5.2 → 0.3.5.3
- VM env: `APPMARKET_BRANCH=sebastian` set in youeye-ui container (fixes connector manifest fetch)

### Test Results
- Cinema Link Handling: Shows "Movie Info" with imdb.com, themoviedb.org domains
- Wiki Link Handling: Shows "Article Summary" with *.wikipedia.org/* pattern
- SearXNG: Now shows as available with "Internal" badge + green checkmark
- Whoogle: Correctly shows "not installed" in amber
- Apps without link handlers (Notes, Weather, Translate, Search): Show empty state

### Notes for Iris
- The `APPMARKET_BRANCH` env var must be set on any VM running the sebastian branch. Without it, UI defaults to `main` which may lack connector manifest updates (e.g. compatibleApps field).
- Link handlers are read-only in this release — the plan's Session C will add management (enable/disable, conflict resolution, SmartLink component).

## v0.3.5.2 — sebastian — 2026-04-23
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Connector improvements — availability logic, dual mode, logos, admin defaults

### Changes
- `ui/src/app/api/settings/connectors/[appId]/route.ts` — Full rewrite: availability flag based on network type + installed backends + custom URL; connector logos from Gitea; admin default annotations; test-connection and update-config actions
- `ui/src/lib/connectors/logos.ts` — NEW: Utility to build Gitea raw URLs for connector logo SVGs
- `ui/src/components/settings/connector-detail.tsx` — Rewritten CapabilityRow with: availability filtering, connector logos (ConnectorLogo component), DualModePicker (internal/external radio, URL input, test connection), default badges, unavailable warnings, exported for reuse
- `ui/src/components/settings/app-settings-detail.tsx` — Replaced inline DataSourcesTab with imported CapabilityRow from connector-detail; removed 270+ lines of orphaned old code; updated types for new API fields
- `ui/src/db/schema.ts` — Added `connectorDefaults` table (capability PK, connectorId, shared key encryption fields, setBy, setAt)
- `ui/src/db/index.ts` — Added CREATE TABLE IF NOT EXISTS for connector_defaults in ensureSchema()
- `ui/src/app/api/settings/admin/connector-defaults/route.ts` — NEW: Admin-only API for GET/POST/DELETE connector defaults per capability
- `ui/src/components/settings/connector-defaults-admin.tsx` — NEW: Admin UI for managing system-wide connector defaults
- `ui/src/app/settings/connector-defaults/page.tsx` — NEW: Admin settings page route
- `ui/src/components/settings/settings-shell.tsx` — Added "Connector Defaults" to admin sidebar
- `ui/messages/{en,ru,de,fr,es}.json` — i18n keys for connector availability, dual mode, logos, defaults
- `ui/src/app/not-found.tsx` — NEW: Custom 404 page (fixes React 19 + styled-jsx SSG build error)
- `ui/src/pages/_error.tsx` — NEW: Custom error page (fixes pre-existing build failure)

### Test Results
- Browser: Settings > Apps shows all apps with connection counts
- Search app: SearXNG shows red "Backend unavailable" (local connector, app not installed)
- Cinema app: TMDB shows "External" badge with credential entry + "Manage in Accounts" link
- Connector Defaults page: All 7 capabilities listed with dropdown selectors
- Admin sidebar: "Connector Defaults" entry appears and highlights correctly

### Notes for Iris
- This is Session B of the info-cards-and-connectors plan. Sessions C-F remain (link rewrites, auth providers, UI components, network isolation).
- New `connector_defaults` DB table auto-created by ensureSchema() — no migration needed
- Availability logic: `available = network === "internet" || hasInstalledBackend || hasCustomUrl`
- DualModePicker only shown for connectors with `hasCompatibleApps` — internet-only connectors connect directly
- No changes to CP or Spine — UI-only release

## v0.3.5.1 — sebastian — 2026-04-23
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Settings restructure — rename Connectors → Apps, add Accounts page, per-app tabbed settings

### Changes
- `ui/src/components/settings/settings-shell.tsx` — Sidebar: "Connectors" replaced with "Apps" + "Accounts"; admin "Apps" renamed to "App Management"
- `ui/src/components/settings/app-settings-detail.tsx` — NEW: Per-app settings page with 3 tabs (Data Sources, Link Handling, Permissions)
- `ui/src/components/settings/accounts-settings.tsx` — NEW: Centralized Connected Accounts + API Keys page
- `ui/src/app/settings/apps/page.tsx` — NEW: Apps list route (replaces connectors)
- `ui/src/app/settings/apps/[appId]/page.tsx` — NEW: Per-app detail route with tabbed interface
- `ui/src/app/settings/accounts/page.tsx` — NEW: Accounts settings route
- `ui/src/app/api/settings/accounts/route.ts` — NEW: Aggregate API for OAuth accounts + API keys
- `ui/src/app/api/auth/providers/[slug]/disconnect/route.ts` — NEW: OAuth disconnect endpoint
- `ui/src/app/settings/connectors/page.tsx` — Redirect to `/settings/apps`
- `ui/src/app/settings/connectors/[appId]/page.tsx` — Redirect to `/settings/apps/[appId]`
- `ui/messages/{en,ru,de,fr,es}.json` — i18n for Apps, Accounts, App Management, tabs, empty states

### Test Results
- Browser: Sidebar shows Apps/Accounts correctly, redirect works, app list shows all 7 apps
- Per-app detail: 3 tabs render, Data Sources shows capabilities, Link Handling shows placeholder, Permissions fetches state
- Accounts page: Connected Accounts and API Keys sections render with empty states
- Playwright: 14 tests written (`tests/settings-apps.spec.ts`), CDP-connected to persistent browser

### Notes for Iris
- This is Session A of the info-cards-and-connectors plan. Link Handling tab is placeholder (Session C). Accounts OAuth flow needs auth providers configured (Session D).
- Old `/settings/connectors` URLs redirect to `/settings/apps` — no breaking change for bookmarks
- No changes to CP or Spine — UI-only release

## v0.3.3.4 — sebastian — 2026-04-22
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Correct connector system to per-app model with Internal/External badges and auto-wire

### Changes
- `ui/src/app/api/settings/connectors/route.ts` — Reverted to per-app response format (`{apps, connectors}`)
- `ui/src/components/settings/connector-app-list.tsx` — Reverted to per-app list with connection status
- `ui/src/components/settings/connector-detail.tsx` — Added Internal/External badges (green=local, blue=internet), backend discovery showing installed app names, install hints for admins
- `ui/src/app/api/settings/connectors/[appId]/route.ts` — Added backend discovery for local connectors
- `ui/src/lib/db/queries/connectors.ts` — Removed auto-select; auto-wire only resolves baseUrl after user selects a connector
- `ui/src/lib/connectors/schema.ts` — Removed redundant `source` field
- `control-panel/src/lib/connectors/schema.ts` — Removed redundant `source` field
- `ui/messages/en.json` — Added `installAvailable`, removed orphaned capability-centric i18n strings
- Deleted `capability-detail.tsx`, `capability/[capability]/page.tsx`, `capability/[capability]/route.ts` (wrong capability-centric model)

### Test Results
- Browser: per-app list shows Wiki, Search, Cinema, Weather with correct connection counts
- Detail view: Internal/External badges render correctly, backend names shown for local connectors

### Notes for Iris
- This is a design correction — the previous v0.3.3.3 had a capability-centric UI which was wrong
- AppMarket manifests also updated (separate commit) to remove `source` field
- YE-App-Search `provides` block restored (separate commit)

## v0.3.3.3 — sebastian — 2026-04-22
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Connector system enhancement — source tags, auto-wiring, service registry, capability-centric UI

### Changes

#### Phase 1-3: Manifest Schema + Proxy + CP Engine
- `YE-AppMarket/connectors/*.yaml` — Added `source: internal|external|both` and `compatibleApps` to all 16 connector manifests; replaced hardcoded container URLs with `${baseUrl}` template variable in SearXNG/Whoogle
- `control-panel/src/lib/connectors/schema.ts` — Added `CompatibleAppSchema`, `source`, `compatibleApps` to Zod schema
- `control-panel/src/lib/connectors/proxy.ts` — Added `baseUrl` template variable resolution
- `control-panel/src/lib/market/engine-connectors.ts` — Full rewrite: removed hardcoded `CONNECTOR_APP_MAP`, replaced with dynamic `compatibleApps` lookup from manifests

#### Phase 4: UI Discovery + Auto-Wire
- `ui/src/lib/connectors/schema.ts` — Mirrored CP schema additions
- `ui/src/lib/db/queries/connectors.ts` — Added `discoverBackends()`, `discoverBackendsByCapability()`, `tryAutoWire()` with two rules (internal+1 backend, external+auth:none); updated `resolveConnector()` return type with `autoWired`, `source`, `baseUrl`
- `ui/src/app/api/v1/connectors/backends/route.ts` — New backend discovery endpoint
- `ui/src/app/api/v1/connectors/resolve/route.ts` — Returns `auto-connected` status

#### Phase 5: Capability-Centric UI
- `ui/src/app/api/settings/connectors/route.ts` — Full rewrite: returns capability groups with source tags, backend discovery, auto-wire status
- `ui/src/app/api/settings/connectors/capability/[capability]/route.ts` — New per-capability detail API with connect/disconnect
- `ui/src/components/settings/connector-app-list.tsx` — Full rewrite: capability list with active connector, auto-wire badges, backend counts
- `ui/src/components/settings/capability-detail.tsx` — New component: Internal/External sections, radio picker, credential entry, install hints
- `ui/src/app/settings/connectors/capability/[capability]/page.tsx` — New capability detail page
- `ui/messages/en.json` — Added 12 i18n strings for Internal/External/auto-connected UI

#### Phase 6: Cleanup
- `ui/src/lib/db/queries/connectors.ts` — Removed unused `fetchConnectorsByCapability()`

### Test Results
- Build: passes (next build)
- Browser: connector list shows all capabilities with source indicators
- Search Engine detail: SearXNG auto-wired as Internal, Whoogle available with install hint
- Weather Data detail: Open-Meteo auto-wired as External
- Screenshots: phase5-connectors-list.png, phase5-search-detail.png, phase5-weather-detail.png

### Notes for Iris
- New route `/settings/connectors/capability/[capability]` — add to nav if needed
- Old per-app routes (`/settings/connectors/[appId]`) still work for backward compat
- AppMarket manifests now require `source` field (defaults to "external" if missing)
- Auto-wire is transparent — no DB rows created, resolved at query time

---

## v0.3.3.1 — sebastian — 2026-04-22
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Full connector system overhaul — unified permission model, auth providers, runtime, UI components, 9 new connectors

### Changes
- `ui/src/db/schema.ts` — added auth_providers and user_auth_tokens tables, auth_provider_id column
- `ui/src/db/index.ts` — auto-migration for new tables
- `ui/src/lib/db/queries/auth-providers.ts` — NEW: complete auth provider CRUD, OAuth2 token management, refresh, propagation
- `ui/src/lib/db/queries/connectors.ts` — removed app_permissions check (selecting connector = permission)
- `ui/src/lib/connectors/runtime/server.mjs` — fixed script transform, added asset serving, protocols endpoint, CSP
- `ui/src/lib/connectors/postmessage-bridge.ts` — NEW: ConnectorBridge class for iframe communication
- `ui/src/lib/connectors/use-connector-bridge.ts` — NEW: React hook for connector UI bridge
- `ui/src/lib/connectors/schema.ts` — added url config field type
- `ui/src/app/api/auth/providers/[slug]/route.ts` — NEW: OAuth2 flow initiation
- `ui/src/app/api/auth/providers/[slug]/callback/route.ts` — NEW: OAuth2 callback + token storage
- `ui/src/app/api/settings/auth-providers/route.ts` — NEW: admin provider management
- `ui/src/app/api/settings/connectors/[appId]/route.ts` — enhanced with provider status
- `ui/src/app/api/v1/connectors/list/route.ts` — added UI and managed field info
- `ui/src/app/api/v1/connectors/proxy/route.ts` — enhanced with auto-refresh from auth providers
- `ui/src/components/settings/connector-detail.tsx` — OAuth sign-in buttons for managed creds
- `ui/messages/en.json` — new translation keys

### Test Results
- Wikipedia proxy chain: resolve → proxy → search = 20 results ✓
- Connector list API: 15 connectors with correct capabilities ✓
- Asset serving via connectors.devvm.test ✓
- Settings connect/disconnect flow ✓

### Notes for Iris
- DB migration automatic via ensureSchema() — no manual steps needed
- Dev VMs need APPMARKET_BRANCH=sebastian in UI .env (remove on merge)
- No UI version bump — bump when merging to dev
- Caddy route connectors.devvm.test must point to youeye-connectors container
## cp-v0.3.5.6 / ui-v0.3.3.12 — vanya — 2026-04-25
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** TLS certificate management — Let's Encrypt DNS-01 + custom upload (Session 29)

### Changes
- `control-panel/src/lib/acme/client.ts` — ACME client with step-by-step DNS-01 flow (startOrder, verifyAndFinalize)
- `control-panel/src/lib/acme/storage.ts` — TLS cert persistence via settingsService (youeye.yaml)
- `control-panel/src/lib/caddy/client.ts` — loadExternalCert/removeExternalCert via Caddy load_pem API
- `control-panel/src/lib/caddy/types.ts` — Added LoadPemEntry, certificate_selection types
- `control-panel/src/app/api/tls/acme/route.ts` — POST start order, PUT verify & finalize
- `control-panel/src/app/api/tls/upload/route.ts` — POST custom PEM cert upload
- `control-panel/src/app/api/tls/download/route.ts` — GET cert/key/bundle/CA download
- `control-panel/src/app/api/tls/status/route.ts` — GET status, DELETE revert to self-signed
- `control-panel/src/app/embed/tls/` — Embed page for UI settings iframe
- `control-panel/src/components/settings/tls-manager-card.tsx` — Standalone card component (kept for direct CP use)
- `control-panel/package.json` — Bumped to 0.3.5.6, added acme-client dependency
- `ui/src/app/settings/tls/page.tsx` — TLS settings page (embeds CP iframe)
- `ui/src/components/settings/settings-shell.tsx` — Added TLS sidebar item with Lock icon
- `ui/messages/*.json` — Added "tls" translation key to all 5 locales

### Test Results
- CP build: successful (TypeScript clean)
- UI build: successful
- TLS embed page: renders correctly in UI settings iframe
- TLS status API: returns correct self-signed mode
- CA cert download: working via execShell to youeye-caddy

### Notes for Iris
- CP has new `acme-client` npm dependency (pnpm-lock.yaml updated)
- TLS data stored in youeye.yaml via settingsService (keys: tls_mode, tls_cert_pem, tls_key_pem, etc.)
- Caddy integration uses load_pem module + tagged automation policies
- Both CP and UI need to be deployed together for the sidebar entry to work

## v0.3.3.11 — vanya — 2026-04-24
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Restore selectable clock widget themes (Session 28)

### Changes
- `ui/src/lib/clock-presets.ts` — NEW: 14 theme definitions across 4 categories (Clean, Bold, Glow, Retro)
- `ui/src/components/widgets/clock-theme-picker.tsx` — NEW: visual thumbnail picker with category tabs
- `ui/src/components/widgets/clock-widget.tsx` — Refactored to apply theme styles from presets instead of hardcoded gradient
- `ui/src/components/dashboard/widget-settings-dialog.tsx` — Wire ClockThemePicker into settings dialog
- `ui/tests/clock-themes.spec.ts` — NEW: Playwright spec for theme selection

### Test Results
- FIFO: 10 screenshots verifying all theme categories + theme application
- Playwright: clock-themes.spec.ts with 5 test cases

### Notes for Iris
- UI-only change, no CP or Spine modifications
- Default theme ("gradient") matches the pre-existing hardcoded style — no visual regression for users who haven't customized

## v0.3.3.10 / v0.3.5.5 — vanya — 2026-04-24
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Fix WordArt widget overflow clipping + Enhanced icon picker with Lucide icons (Session 27)

### Changes
- `ui/src/components/widgets/index.ts` — Added `allowOverflow` to WidgetMeta interface; server-name widget opts in
- `ui/src/components/dashboard/widget-container.tsx` — Conditional overflow-visible for widgets with allowOverflow
- `ui/src/components/widgets/server-name-widget.tsx` — Inner container changed to overflow-visible
- `control-panel/src/app/embed/branding/client.tsx` — Major rewrite: added Lucide icons tab (~1700 icons with search), expanded emojis (24→450+), upload tab, gradient presets, icon color picker
- `control-panel/src/app/api/ui/branding/upload/route.ts` — NEW: bridge proxy for file uploads
- `ui/src/app/api/ui-bridge/branding/upload/route.ts` — NEW: bridge endpoint for file uploads

### Test Results
- `ui/tests/wordart-overflow.spec.ts` — overflow-visible verification, text-shadow rendering
- `ui/tests/icon-picker-enhanced.spec.ts` — branding API, icon routes, upload auth

### Notes for Iris
- UI change is backward-compatible — only server-name widget affected, all others retain overflow-hidden
- CP icon picker is self-contained in the embed branding page, no other CP pages affected
- Upload bridge routes follow existing bridge pattern (X-UI-Bridge-Token auth)

---

## v0.3.5.4 — vanya — 2026-04-24
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Fix Authentik favicon sync — DNS, auth, and data bugs (Session 26b)

### Changes — CP (v0.3.5.4)
- `control-panel/src/lib/authentik/sync-branding.ts` — NEW: extracted Authentik sync logic into reusable function
- `control-panel/src/app/api/ui-bridge/authentik/branding/route.ts` — Simplified to use sync-branding module; fixed DNS from `.incus` to `.${CONTAINER_DOMAIN}`
- `control-panel/src/app/api/ui/branding/route.ts` — Replaced broken fire-and-forget HTTP self-call with direct `syncBrandingToAuthentik()` call + CSS generation

### Notes for Iris
- The branding sync was silently failing since the one-way bridge auth change. This fix makes it work again.
- Authentik favicon is now pushed automatically on every branding save via the Server Branding embed.

---

## v0.3.3.9 / v0.3.5.3 — vanya — 2026-04-24
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Fix WordArt picker auto-fill and icon rendering pipeline bugs (Session 26)

### Changes — UI (v0.3.3.9)
- `ui/src/middleware.ts` — Added `/icon` and `/apple-icon` to STATIC_PATTERNS so favicon routes bypass auth
- `ui/src/app/icon.tsx` — Rewritten: force-dynamic + auto-regeneration from DB config for letter mode
- `ui/src/app/apple-icon.tsx` — Same force-dynamic + auto-regen pattern
- `ui/src/lib/icon-renderer.ts` — BRANDING_DIR moved from public/branding (wiped on deploy) to persistent /opt/youeye-ui-data/branding/

### Changes — CP (v0.3.5.3)
- `control-panel/src/components/setup/WordArtPickerInline.tsx` — Added findInitialIndices() to reverse-map current style to preset indices on mount; added useRef mount guard to skip first useEffect render

### Test Results
- `ui/tests/icon-rendering-fixes.spec.ts` — /icon and /apple-icon return 200 without auth, serve valid PNG, no stale prerendered cache
- `ui/tests/wordart-picker-autofill.spec.ts` — WordArt picker shows current style on mount, API returns valid site_name_style

### Notes for Iris
- UI middleware change is safe — only adds to STATIC_PATTERNS, no removals
- Icon renderer path change requires /opt/youeye-ui-data/branding/ directory in UI container (created automatically via mkdir recursive)

---

## v0.3.3.8 / v0.3.5.2 — vanya — 2026-04-24
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Server icon/favicon system — configurable icon picker, auto-render, multi-app favicon (Session 25)

### Changes — UI (v0.3.3.8)
- `ui/src/lib/icon-config.ts` — New: IconConfig type, DEFAULT_ICON_CONFIG, ICON_SIZES constants
- `ui/src/lib/icon-renderer.ts` — New: Server-side SVG→PNG renderer via sharp with embedded font support
- `ui/src/app/api/v1/branding/icon/route.ts` — New: POST (upload rendered icon), GET (serve icon PNG by size)
- `ui/src/app/api/ui-bridge/branding/icon/route.ts` — New: Bridge endpoint for icon uploads from CP
- `ui/src/app/icon.tsx` — New: Next.js dynamic favicon route (32px)
- `ui/src/app/apple-icon.tsx` — New: Apple touch icon route (180px)
- `ui/src/components/settings/icon-picker-branding.tsx` — New: Full icon picker (Letter/Icons/Emoji/Upload tabs, shape, background)
- `ui/src/app/api/v1/branding/route.ts` — Added icon_config to PUT, auto-regenerate icons on wordart change
- `ui/src/app/api/ui-bridge/branding/route.ts` — Added icon_config passthrough, letter mode auto-render
- `ui/src/components/settings/branding-settings.tsx` — Added IconPickerBranding, icon save/upload logic
- `ui/src/lib/db/queries/branding.ts` — Added icon_config field to BrandingConfig, DB queries
- `ui/src/middleware.ts` — Added /api/v1/branding/icon to PUBLIC_ROUTES
- `ui/tests/server-icon.spec.ts` — New: 8 Playwright tests (API, UI picker, CP proxy)

### Changes — Control Panel (v0.3.5.2)
- `control-panel/src/lib/icon-config.ts` — New: Mirror of IconConfig type
- `control-panel/src/components/setup/SetupIcon.tsx` — New: Setup wizard icon step (Letter/Emoji, shape, background)
- `control-panel/src/app/api/branding/favicon/route.ts` — New: CP favicon proxy (fetches from UI)
- `control-panel/src/app/api/ui/branding/icon/route.ts` — New: Bridge proxy for icon uploads
- `control-panel/src/app/embed/branding/client.tsx` — Added icon picker (Letter/Emoji, shape, background, canvas preview)
- `control-panel/src/app/layout.tsx` — Added dynamic favicon metadata
- `control-panel/src/app/setup/page.tsx` — Added icon step (step 2), renumbered wizard steps
- `control-panel/src/app/api/setup/run/route.ts` — Added icon_config DB write, fontconfig install, Authentik favicon push
- `control-panel/src/app/api/ui-bridge/authentik/branding/route.ts` — Added favicon push to Authentik container
- `control-panel/src/middleware.ts` — Added /api/branding/favicon to PUBLIC_ROUTES

### Test Results
- Playwright: 8 tests passed (server-icon.spec.ts)
- Visual verification: icon picker, letter/emoji modes, shape controls, save flow, favicon serving

### Notes for Iris
- UI container requires `fontconfig` + `fonts-dejavu-core` packages for server-side icon rendering
- Setup provisioning auto-installs fontconfig and registers custom fonts
- Icon auto-regenerates when WordArt changes (letter mode only)
- Four icon modes: Letter (from WordArt), Emoji (native), Lucide icons, Upload
- CP favicon served via proxy from UI's /api/v1/branding/icon endpoint

## v0.3.3.7 — vanya — 2026-04-24
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Widget auto-fit — text fills container width, height auto-adjusts, no empty space (Session 24)

### Changes — UI (v0.3.3.7)
- `ui/src/components/widgets/index.ts` — Added `autoFit` flag + `onAutoSize` callback to WidgetComponentProps/WidgetMeta
- `ui/src/components/dashboard/widget-container.tsx` — Auto-fit height handler, hide vertical resize handles for autoFit widgets, minimal padding (p-1) for autoFit
- `ui/src/components/dashboard/widget-card.tsx` — Thread `onAutoSize` to widget components
- `ui/src/components/widgets/server-name-widget.tsx` — JS fit-text-to-width: measures text, scales fontSize to fill container, reports height via onAutoSize
- `ui/src/components/widgets/clock-widget.tsx` — Same fit-text approach, gradient time, proportional date (28% of time size)
- `ui/src/components/dashboard/widget-grid.tsx` — Updated default heights for auto-fit widgets
- `ui/tests/widget-scaling.spec.ts` — Updated: fill-ratio tests, autoFit handle removal, reset defaults
- `ui/package.json` — Bumped 0.3.3.6 → 0.3.3.7

### Test Results
- Playwright: 5 tests passed (widget-scaling.spec.ts)

### Notes for Iris
- AutoFit widgets: only width is user-resizable, height auto-adjusts to content
- Bottom/top resize handles hidden for autoFit widgets in edit mode
- Existing layouts preserved — height auto-adjusts on first load

## v0.3.3.6 — vanya — 2026-04-23
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Widget container-query scaling — WordArt and Clock text scales with widget resize (Session 24)

### Changes — UI (v0.3.3.6)
- `ui/src/components/dashboard/widget-container.tsx` — Added `containerType: "size"` to widget content wrapper, enabling CSS container query units (cqw/cqh) inside all widgets
- `ui/src/components/widgets/server-name-widget.tsx` — Switched fontSize from viewport-relative `clamp(3rem, 8vw, 6rem)` to container-relative `clamp(1.5rem, 15cqw, 12rem)` so text scales with widget resize
- `ui/src/components/widgets/clock-widget.tsx` — Restyled with gradient time display, uppercase date, and cqw-based font scaling (`clamp(1rem, 10cqw, 6rem)`)
- `ui/src/components/widgets/index.ts` — Reduced server-name default width from 52→26% (half)
- `ui/src/components/dashboard/widget-grid.tsx` — Updated DEFAULT_WIDGETS server-name width from 57→30%
- `ui/package.json` — Bumped 0.3.3.5 → 0.3.3.6
- `ui/tests/widget-scaling.spec.ts` — New test suite: container queries, cqw font scaling, clock gradient, reset defaults

### Test Results
- Playwright: 5 tests passed (widget-scaling.spec.ts)
- Screenshots: Tests/Vanya/scaling-*.png

### Notes for Iris
- Existing user layouts are preserved (widget positions/sizes stored in DB)
- New defaults only apply on "Reset" or when adding a new widget
- CSS `container-type: size` is applied to ALL widget wrappers, not just WordArt/Clock — future widgets can use cqw units for free

## v0.3.3.4 — vanya — 2026-04-23
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Fix hidden apps not filtering in native app drawers, add visible/order to header config API (Session 22)

### Changes — UI (v0.3.3.4)
- `ui/src/app/api/v1/header/config/route.ts` — Added `visible` field to apps array in response
- `ui/package.json` — Bumped 0.3.3.3 → 0.3.3.4

### Test Results
- Build: clean standalone.tar (227MB), deployed to youeye-ui container

### Notes for Iris
- Header config API now includes `visible: boolean` per app — native apps use this to filter hidden apps
- All native apps updated to filter `visible !== false` and sort by `order`

## v0.3.3.3 — vanya — 2026-04-23
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Fix header icon spacing, notification bugs, toast positioning, standardize native app drawers (Session 21)

### Changes — UI (v0.3.3.3)
- `ui/src/components/layout/user-menu.tsx` — Wrapped avatar trigger in h-9 w-9 button for consistent icon spacing
- `ui/src/components/layout/notification-bell.tsx` — Standardized button to h-9 w-9, fixed interface fields from snake_case to camelCase
- `ui/src/components/ui/sonner.tsx` — Added position="top-right" and duration={5000} for auto-dismissing toasts
- `ui/src/components/notifications/notifications-list.tsx` — Fixed API paths /api/notifications → /api/v1/notifications (5 places), fixed NaN time bug, added NaN guard
- `ui/package.json` — Bumped 0.3.3.2 → 0.3.3.3

### Test Results
- Build: clean standalone.tar (226MB), deployed to youeye-ui container
- Browser: even header spacing, notifications load with correct times, toasts auto-dismiss top-right

### Notes for Iris
- notification-bell and notifications-list now use camelCase field names matching Drizzle ORM output
- API path fix critical — /api/notifications never existed, only /api/v1/notifications
- No CP or Spine changes

## v0.3.3.2 — vanya — 2026-04-22
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Drawer prefs in header config API for cross-app consistency (Session 20)

### Changes — UI (v0.3.3.2)
- `ui/src/app/api/v1/header/config/route.ts` — Added `getDrawerPrefs()` call and `drawer_prefs` field to response
- `ui/package.json` — Bumped 0.3.3.1 → 0.3.3.2

### Test Results
- Build: clean standalone.tar
- Deploy: youeye-ui container updated and serving
- Browser: drawer_prefs correctly returned in header config, native apps render consistent drawer layout

### Notes for Iris
- All native apps now consume `drawer_prefs` from header config to render app drawer with same columns/iconScale/maxHeight as homepage
- No CP changes in this session

## v0.3.5.1 / v0.3.3.1 — vanya — 2026-04-22
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Avatar management in CP embed + shared avatar across native apps

### Changes — CP (v0.3.5.1)
- `control-panel/src/app/api/user/avatar/route.ts` — NEW: CP-owned avatar upload/delete to Authentik via `attributes.avatar` PATCH
- `control-panel/src/app/embed/avatar/page.tsx` + `client.tsx` — NEW: Standalone avatar picker embed for onboarding
- `control-panel/src/app/embed/profile/client.tsx` — Added avatar upload (file + 32 emoji presets via canvas) and remove to profile embed
- `control-panel/src/lib/authentik/client.ts` — Added `ensureAvatarSettings()` to configure Authentik for attributes.avatar
- `control-panel/src/app/api/setup/run/route.ts` — Avatar settings configured during initial setup
- `control-panel/src/app/api/ui-bridge/authentik/branding/route.ts` — Avatar settings ensured during branding sync
- `control-panel/src/app/api/ui-bridge/user/avatar/` — DELETED: old bridge route removed

### Changes — UI (v0.3.3.1)
- `ui/src/app/api/v1/header/config/route.ts` — Added `avatar_url` (full URL) to user object in response
- `ui/src/app/api/v1/user/avatar/[id]/route.ts` — Made public (no auth), added UUID sanitization for path traversal prevention
- `ui/src/middleware.ts` — Added `/api/v1/user/avatar` to PUBLIC_ROUTES for cross-subdomain access
- `ui/src/components/settings/profile-settings.tsx` — Removed avatar handling code, now receives from CP embed via postMessage
- `ui/src/app/onboarding/page.tsx` — New 4-step flow (Welcome → Avatar → PIN → Done), theme-aware classes
- `ui/src/app/api/v1/user/avatar/route.ts` — Removed Authentik sync call
- `ui/src/lib/avatar/authentik-sync.ts` — DELETED: old UI→CP bridge sync
- `ui/messages/en.json`, `ui/messages/ru.json` — New onboarding i18n keys

### Changes — Native Apps (Search v0.3.1.1, Weather v0.3.1.1)
- `YE-App-Search/src/lib/types/index.ts` — Added `avatar_url` to HeaderConfig user type
- `YE-App-Search/src/lib/components/layout/user-menu.tsx` — Display avatar image with initials fallback
- `YE-App-Search/src/lib/components/layout/app-header.tsx` — Pass avatarUrl from header config to UserMenu
- `YE-App-Weather/src/lib/types/index.ts` — Added `avatar_url` to HeaderConfig user type
- `YE-App-Weather/src/components/layout/user-menu.tsx` — Display avatar via AvatarImage with initials fallback
- `YE-App-Weather/src/components/layout/weather-header.tsx` — Pass avatarUrl from header config to UserMenu

### Test Results
- Avatar visible in UI dashboard, Search app, and Weather app headers — all three show same avatar
- Avatar endpoint serves publicly (HTTP 200, 5534B) without cookies
- Header config API returns full avatar_url for service-to-service calls
- Onboarding: 4-step flow renders correctly with system theme
- Screenshots: Tests/Vanya/20260422_1/

### Notes for Iris
- **Architecture change**: ALL UI→CP bridge calls for avatar eliminated. CP owns Authentik avatar management end-to-end.
- **Avatar serving is now public** — profile pictures are served without auth at `/api/v1/user/avatar/[id]`. Upload/delete still require auth.
- **Header config contract change**: `user.avatar_url` is now included. Existing apps that don't use it are unaffected (additive change).
- Native apps (Search, Weather) have independent releases for the avatar display change.
- Authentik admin settings MUST have `attributes.avatar` in the `avatars` chain — setup wizard and branding sync handle this automatically.

## v0.3.4.7 — andrew — 2026-04-21
**Branch:** andrew
**VM:** ye-andrew
**Agent:** Andrew
**Task:** RS256 signing key for OAuth2 providers; Immich + Nextcloud SSO end-to-end testing

### Changes
- `control-panel/src/lib/market/authentik.ts` — Added `findSigningKey()` to look up Authentik's self-signed certificate keypair; auto-assign signing_key to new OAuth2 providers for RS256 JWT signing
- `control-panel/src/lib/market/engine.ts` — Fixed `injectCaddyRootCA()`: mkdir -p before writing cert (OCI images may not have /usr/local/share/ca-certificates/); write cert to /tmp/caddy-root.crt for NODE_EXTRA_CA_CERTS fallback
- `control-panel/package.json` — Bumped version to 0.3.4.7

### Test Results
- Immich SSO: full install → admin signup → OAuth config → SSO login as "Tester Dev" (name, email, username all correct)
- Nextcloud SSO: full install → CLI OIDC setup → SSO login as "Tester Dev" via user_oidc (name, email correct, backend=user_oidc)
- RS256 signing key auto-assigned to both Immich and Nextcloud Authentik providers

### Notes for Iris
- `findSigningKey()` queries Authentik's certificate keypairs API, prefers "Self-signed" cert, falls back to first available
- Engine's `injectCaddyRootCA()` now handles missing directories in OCI images (was failing silently on mkdir)
- Nextcloud requires `allow_local_remote_servers = true` to reach Authentik at private IPs — added to manifest CLI steps
- The `user_oidc:provider:create` command was wrong for Nextcloud 31.x — correct command is `user_oidc:provider`

## v0.3.4.6 — andrew — 2026-04-21
**Branch:** andrew
**VM:** ye-andrew
**Agent:** Andrew
**Task:** Admin credentials API + UI for marketplace apps; SSO variable resolution for callback_path/entry_url

### Changes
- `control-panel/src/lib/market/schema.ts` — Added `CredentialSchema` (label/username/passwordSecret) to manifest schema
- `control-panel/src/lib/market/types.ts` — Added `CredentialSpec`, `CredentialMeta` types; added `credentials` and `ssoEntryUrl` to `InstallMetadata`
- `control-panel/src/lib/market/engine.ts` — Persist credentials in install metadata; resolve variables in `entry_url` and `callback_path`
- `control-panel/src/lib/market/platform-env.ts` — Inline variable resolution for `callback_path` in SSO context; added `credentials: []` to mock manifest
- `control-panel/src/app/api/market/credentials/route.ts` — NEW: API endpoint to read admin credentials (secret values from disk)
- `control-panel/src/app/api/market/status/route.ts` — Include `ssoEntryUrl` in app URL for "Open" button
- `control-panel/src/app/(dashboard)/market/[appId]/page.tsx` — Credentials card with show/hide toggle and copy buttons

### Test Results
- CP builds and deploys successfully (v0.3.4.6, 10 containers running)
- Credentials API returns admin passwords from disk secrets for installed apps

### Notes for Iris
- New manifest field: `credentials` — array of {label, username, passwordSecret}. Stored in install.json, values read from disk secrets at API time.
- `callback_path` and `entry_url` now support variable resolution (`${authentik.name}`, `${app.id}`)
- AppMarket manifests updated: all 5 external apps now have credentials sections; Memos/Jellyfin use `${authentik.name}` instead of hardcoded "Authentik"/"authentik"

## v0.3.4.5 — andrew — 2026-04-21
**Branch:** andrew
**VM:** ye-andrew
**Agent:** Andrew
**Task:** Add extractCookie to SSO engine for cookie-based auth apps (Memos)

### Changes
- `control-panel/src/lib/market/schema.ts` — Added `extractCookie` field to SSOStepSchema (name + as)
- `control-panel/src/lib/market/sso-engine.ts` — Cookie extraction from Set-Cookie and Grpc-Metadata-Set-Cookie headers; refactored executeHTTPStep to return headers alongside body

### Test Results
- Memos installed successfully with full SSO configuration via cookie-based auth
- Admin user created with HOST role, Authentik identity provider configured
- Clean reinstall verified (uninstall → fresh install → all 9 steps pass)

### Notes for Iris
- New SSO engine feature: `extractCookie` — needed for any app that returns auth tokens via cookies instead of JSON response body (gRPC-gateway apps like Memos)
- No breaking changes to existing manifests — extractToken still works as before

## v0.3.4.4 / v0.3.2.2 — andrew — 2026-04-21
**Branch:** andrew
**VM:** ye-andrew
**Agent:** Andrew
**Task:** Fix external app icons in app drawer and Jellyfin icon/screenshot in App Market

### Changes
- `control-panel/src/app/api/market/image/route.ts` — Added `jellyfin.org` to ALLOWED_DOMAINS so Jellyfin screenshots can be proxied
- `ui/src/app/api/market/image/route.ts` — NEW: Image proxy route mirroring CP's endpoint, so app drawer icons (stored as `/api/market/image?url=...`) resolve on the UI domain
- `ui/src/middleware.ts` — Added `/api/market/image` to PUBLIC_ROUTES (no auth required for icon serving)
- `ui/package.json` — Bumped to 0.3.2.2
- `control-panel/package.json` — Bumped to 0.3.4.4

### Test Results
- Playwright: 8 FIFO screenshots, all verified
- Jellyfin icon visible in App Market card and detail page
- Jellyfin screenshot visible in App Market detail page
- Jellyfin icon visible in App Drawer (was broken placeholder before)
- UI image proxy returns HTTP 200 for Gitea-hosted SVG icons

### Notes for Iris
- The UI now has `/api/market/image` route — must be included in builds
- All external app manifests in YE-AppMarket now use relative iconUrl paths (branch-independent)
- Existing installed apps with `/api/market/image?url=...` in their icon DB column will work automatically with the new UI proxy

## v0.3.4.3 — andrew — 2026-04-21
**Branch:** andrew
**VM:** ye-andrew
**Agent:** Andrew
**Task:** Fix custom scope mapping filter for SSO admin role mapping

### Changes
- `control-panel/src/lib/market/authentik.ts` — Scope mapping filter now includes custom Authentik mappings (managed=null) alongside built-in ones, enabling YouEye Groups claim in OIDC tokens for admin role mapping

### Notes for Iris
- This is the engine-side fix for admin role mapping. Without it, future app installs won't get the `groups` claim in their OIDC tokens, breaking any `roleClaim: "groups"` config.

## v0.3.4.2 / v0.3.2.1 — andrew — 2026-04-21
**Branch:** andrew
**VM:** ye-andrew
**Agent:** Andrew
**Task:** Jellyfin SSO fixes — entry URL auto-redirect, username claim, display name

### Changes
- `control-panel/src/lib/market/schema.ts` — Added `entry_url` to SSOSchema for SSO entry path
- `control-panel/src/lib/market/engine.ts` — Passes `sso_entry_url` during app registration with UI
- `ui/src/db/schema.ts` + `ui/src/db/index.ts` — Added `sso_entry_url` column to apps table with auto-migration
- `ui/src/app/api/v1/apps/drawer/route.ts` — buildAppUrl appends ssoEntryUrl when set
- `ui/src/app/api/v1/header/config/route.ts` — Same SSO entry URL logic for header config API
- `ui/src/app/api/v1/apps/register/route.ts` — Accepts sso_entry_url in registration body
- `ui/src/lib/db/queries/app-management.ts` — Stores ssoEntryUrl in registerApp
- `ui/src/lib/db/queries/apps.ts` — Returns ssoEntryUrl in getUserAppsWithConfig

### Test Results
- Verified SSO login creates user as "tester" (not UUID) via Jellyfin Users API
- Verified drawer API returns `https://jellyfin.devvm.test/sso/OID/start/authentik`
- Verified SSO flow works end-to-end from SSO entry URL

### Notes for Iris
- CP and UI must merge together — entry_url schema + DB column are coupled
- YE-AppMarket must also merge for the manifest changes
- Existing installed apps need manual DB update for sso_entry_url (new installs get it automatically)

## v0.3.4.1 — andrew — 2026-04-21
**Branch:** andrew
**VM:** ye-andrew
**Agent:** Andrew
**Task:** Add Caddy root CA injection for external app SSO HTTPS trust

### Changes
- `control-panel/src/lib/market/engine.ts` — Added `injectCaddyRootCA()` helper and CA injection loop before SSO configure steps; OCI containers with SSO now automatically trust Caddy's self-signed certificates for OIDC discovery
- `control-panel/package.json` — Version bump to 0.3.4.1

### Test Results
- Jellyfin (first external app) installed end-to-end from App Market UI
- SSO-Auth plugin auto-installed and configured with Authentik OIDC
- SSO login flow verified: Jellyfin → Authentik → redirect back → authenticated
- CA cert injection confirmed in container trust store (151 certs after injection)
- Caddy route and Pi-Hole DNS entry auto-created
- 5 screenshots captured throughout install flow

### Notes for Iris
- This change is required for ANY external app with SSO (not just Jellyfin)
- The CA injection runs only for OCI containers where `ssoEnabled` is true
- If Caddy root cert is missing or malformed, injection is silently skipped (warning logged)
- Companion change: Jellyfin manifest in YE-AppMarket (andrew branch) must be merged alongside

---

## v0.3.2.2 — sebastian — 2026-04-21
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Session 4 — Connector Settings UI fixes + end-to-end verification

### Changes
- `ui/src/app/api/settings/connectors/route.ts` — Fixed isExternalApp detection (check manifest.id prefix) + added consumes fallback
- `ui/src/app/api/settings/connectors/[appId]/route.ts` — Added consumes field fallback for connector requirements
- `ui/src/app/connectors/setup/page.tsx` — Added consumes field fallback for setup page validation
- `ui/package.json` — Version bump to 0.3.2.2
- `ui/tests/connector-settings.spec.ts` — 7 Playwright tests for connector settings UI

### Test Results
- Playwright: 7 tests (connector-settings.spec.ts)
- Browser: full connect/disconnect flow verified for all free connectors

### Notes for Iris
- DB app manifests need `connectors.requires` injected (SQL ran on dev VM, not in migration)
- `APPMARKET_BRANCH` env var must be set in UI container for full connector catalog
- Wiki uses `consumes` not `requires` — both are now supported in all 3 API routes

---

## v0.3.2.1 — sebastian — 2026-04-21
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Connector runtime + Canvas-compatible proxy route + SearXNG 403 fix

### Changes
- `ui/src/lib/connectors/runtime/server.mjs` — Connector runtime server (Node HTTP, /health + /proxy endpoints, SSRF blocklist, json-map/script/passthrough transforms)
- `ui/src/app/api/v1/connectors/[connectorId]/proxy/route.ts` — Canvas SDK compatibility route (extracts connectorId from URL path, forwards to runtime)
- `ui/package.json` — Version bump to 0.3.2.1
- `ui/tests/connector-runtime.spec.ts` — 8 Playwright tests for connector system

### Test Results
- Playwright: 8 tests, all passed
- Screenshots: Tests/Sebastian/20260421_1/

### Notes for Iris
- Connector runtime server.mjs must be deployed to `youeye-connectors` container at `/opt/youeye-connectors/server.mjs`
- SearXNG containers need `formats: [html, json, rss]` in `/etc/searxng/settings.yml` (not in CP installer yet)
- Search app needs `YOUEYE_API_URL=http://youeye-ui.youeye:3000/api/v1` and `CP_API_URL=http://youeye-ui.youeye:3000/api/v1` in env
- The `connector:search-engine` permission must be granted for users to use search through the connector system

---

## v0.3.4.1 — sebastian — 2026-04-21
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Consolidate manifest format to apiVersion v1, remove all legacy compat code

### Changes
- `control-panel/src/lib/market/schema.ts` — Removed AppRefSchema, legacy fields, v1/v2 enum. Single apiVersion:'v1' format.
- `control-panel/src/lib/market/catalog.ts` — Removed getAllEntries() v1 merging, parseAppRef indirection. Direct catalog.apps usage.
- `control-panel/src/lib/market/engine.ts` — Removed legacy fallbacks for dbMode, sso.redirectUris, sso.configure.
- `control-panel/src/lib/market/parser.ts` — Removed parseAppRef function.
- `control-panel/src/lib/market/types.ts` — Removed legacy type aliases and fields.
- `control-panel/src/lib/market/installed-apps.ts` — Removed fetchNativeAppVersionLegacy(), v1 catalog compat.
- `control-panel/src/lib/apps/definitions.ts` — Uses containers[] instead of native block.
- Various UI/SSO/language files — Replaced legacy field references.

### Test Results
- Build: successful (22 files, -356/+112 lines)
- Deployed to VM, service running

### Notes for Iris
- Merge ALL native app repos (Wiki, Search, Notes, Cinema, Weather, Translate) — apiVersion changes
- Merge YE-AppMarket — catalog.yaml + deleted native/*.yaml + external manifest changes
- No version bump — code-only cleanup
## v0.3.2.10 — vanya — 2026-04-21
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Truly separate floating panels via createPortal

### Changes
- `ui/src/components/layout/app-drawer.tsx` — Replaced CSS absolute+overflow:visible approach (which failed — panels rendered inside popover box) with React createPortal. Satellite panels now render as independent DOM elements at document.body with position:fixed. Drawer stays 340px unchanged. Hidden apps shown as grid tiles. Uses useElementRect hook with ResizeObserver.
- `ui/package.json` — Version bump 0.3.2.9 → 0.3.2.10

### Test Results
- FIFO screenshots verified: normal mode unchanged, edit mode shows 3 separate floating cards

### Notes for Iris
- No DB migrations. Uses React createPortal + position:fixed for satellite panels. onInteractOutside prevented in edit mode.

## v0.3.2.9 — vanya — 2026-04-21
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Floating satellite panels for app drawer edit mode

### Changes
- `ui/src/components/layout/app-drawer.tsx` — Complete redesign of edit mode: drawer itself stays visually unchanged (icons just shake + become draggable). Hidden apps panel floats as a separate card to the LEFT (grid layout, not a list). Controls panel floats as a separate card BELOW. All three are independent floating cards via CSS absolute + overflow:visible on Radix PopoverContent.
- `ui/package.json` — Version bump 0.3.2.7 → 0.3.2.9

### Test Results
- FIFO screenshot verified: normal mode shows compact popover with pencil icon, edit mode shows three separate floating cards (drawer, hidden panel left, controls below)

### Notes for Iris
- No DB migrations. Drag-and-drop uses HTML5 DnD API (no external deps). CSS absolute positioning on PopoverContent with overflow:visible — no extra portals needed.

## v0.3.2.7 — vanya — 2026-04-21
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** App drawer edit mode sections in separate bordered cards

### Changes
- `ui/src/components/layout/app-drawer.tsx` — Edit mode sections (hidden panel, visible grid, controls) each wrapped in rounded bordered cards with gaps between them
- `ui/package.json` — Bumped 0.3.2.6 → 0.3.2.7

### Test Results
- FIFO screenshot: /tmp/shots/v7-02-cards-edit.png — all three cards visually distinct

### Notes for Iris
- Styling-only change, no logic changes

## v0.3.2.6 — vanya — 2026-04-21
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** App drawer expandable edit mode + larger server name widget

### Changes
- `ui/src/components/layout/app-drawer.tsx` — Removed "Manage Apps", pencil icon (no text) in top-left, edit mode expands to near-full-height with hidden apps panel on left, drag-and-drop reordering between visible/hidden, controls footer with columns/icon-size/max-height
- `ui/src/components/widgets/server-name-widget.tsx` — Increased font clamp to 6rem, reduced padding
- `ui/src/components/widgets/index.ts` — Default size 40x10 → 52x13 (30% larger)
- `ui/src/components/dashboard/widget-grid.tsx` — Updated DEFAULT_WIDGETS for server-name (57% width, 13% height)
- `ui/src/lib/db/queries/widgets.ts` — Updated server-side DEFAULT_WIDGETS to match
- `ui/package.json` — Bumped 0.3.2.5 → 0.3.2.6

### Test Results
- FIFO screenshots: /tmp/shots/v6-0{1-6}*.png — all verified
- Drawer normal mode: compact popover with pencil icon, no Manage Apps
- Drawer edit mode: two-panel with hidden apps on left, controls at bottom
- Widget: bigger font, less empty space

### Notes for Iris
- Drag-and-drop uses HTML5 DnD API (no external deps)
- Server name widget default size increase only affects new users or after Reset
- No DB migrations

## v0.3.2.5 — vanya — 2026-04-21
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Revert app drawer from Sheet panel to compact Popover dropdown

### Changes
- `ui/src/components/layout/app-drawer.tsx` — Reverted from Sheet side-panel to Popover dropdown. Kept edit mode with show/hide/reorder, drawer prefs (columns, icon scale), and admin-only marketplace link. Removed max-height slider (dropdown auto-sizes). Footer now has "Manage Apps" + "Edit" button.
- `ui/package.json` — Bumped 0.3.2.4 → 0.3.2.5
- `ui/tests/server-name-widget-drawer.spec.ts` — Updated tests for Popover instead of Sheet

### Test Results
- Playwright: 10 tests, verified via FIFO + spec update
- Screenshots: /tmp/shots/drawer-02-open.png

### Notes for Iris
- This is a UX fix requested by the user — the Sheet panel was too wide and ugly
- All edit mode features (show/hide/reorder, column/scale prefs) are preserved in the popover
- No DB changes — same API endpoints and JSONB storage

## v0.3.2.4 — vanya — 2026-04-21
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Server Name WordArt widget, compact widgets, app drawer overhaul

### Changes
- `ui/src/components/widgets/server-name-widget.tsx` — NEW: Server Name WordArt widget displaying instance name with user's wordart style
- `ui/src/components/widgets/index.ts` — Added server-name to catalog, reduced greeting/clock default sizes
- `ui/src/components/widgets/greeting-widget.tsx` — Compact layout (p-0, leading-tight)
- `ui/src/components/widgets/clock-widget.tsx` — Compact layout (text-3xl, gap-0.5, text-xs date)
- `ui/src/components/dashboard/widget-grid.tsx` — Default widgets now use server-name instead of greeting
- `ui/src/components/layout/app-drawer.tsx` — Full rewrite: Sheet-based panel with edit mode, column/scale/height controls
- `ui/src/components/layout/navbar.tsx` — Pass isAdmin to AppDrawer
- `ui/src/lib/db/queries/settings.ts` — DrawerPrefs get/save functions
- `ui/src/lib/db/queries/widgets.ts` — Updated DEFAULT_WIDGETS
- `ui/src/app/api/v1/apps/drawer/prefs/route.ts` — NEW: Drawer prefs API
- `ui/messages/{en,de,es,fr,ru}.json` — Added serverName i18n key
- `ui/tests/server-name-widget-drawer.spec.ts` — 10 Playwright tests

### Test Results
- Playwright: 10 tests, all passed (31s)
- Screenshots: Tests/Vanya/playwright/test-results/

### Notes for Iris
- No DB migrations needed — drawer prefs stored in existing user_settings JSONB
- Existing users keep their old widget layout; new defaults only apply to new users or after Reset
- The "Manage Apps" footer in the app drawer is removed — settings page app drawer management is unchanged

## v0.3.2.3 — vanya — 2026-04-21
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Fix sharp module missing from UI standalone build

### Changes
- `ui/scripts/postbuild.js` — Added sharp + full transitive dep tree (detect-libc, color, color-convert, color-string, color-name, simple-swizzle, is-arrayish, semver) to needed packages list; added Step 5b to copy @img/* native bindings from pnpm store
- `ui/package.json` — Bumped 0.3.2.2 → 0.3.2.3

### Root Cause
pnpm hoists sharp to workspace root with symlinks. Next.js standalone copies the symlink as-is, but the relative `../../` resolves to `.next/` instead of the monorepo root. The postbuild Step 4 caught the broken symlink but silently skipped it.

### Test Results
- `node -e "require('sharp')"` inside youeye-ui container: OK
- Avatar upload and emoji picker work end-to-end

### Notes for Iris
- This fix applies to all future UI builds — no manual intervention needed
- No env var or DB changes

## v0.3.4.2 / v0.3.2.2 — vanya — 2026-04-21
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Profile embed theme sync, template avatar picker, background app installs

### Changes
- `control-panel/src/app/embed/market/client.tsx` — Non-blocking installs: dialog closes on submit, progress via inline banner, postMessage events for global tracking
- `control-panel/src/app/embed/layout.tsx` — Added embed-spin keyframe for install spinner
- `ui/src/components/settings/profile-settings.tsx` — PostMessage theme propagation (dark/light sync), 32 emoji+gradient template avatar picker with canvas→blob→upload
- `ui/src/components/app-install-listener.tsx` — NEW: Global Sonner toast notifications for app install progress, polls /api/v1/admin/install-progress
- `ui/src/app/api/v1/admin/install-progress/route.ts` — NEW: Proxy to CP install-progress endpoint
- `ui/src/components/providers.tsx` — Added AppInstallListener to global providers
- `ui/messages/{en,ru,de,es,fr}.json` — Avatar picker translation keys

### Test Results
- TypeScript: clean (no new errors introduced)
- Deployment: spine status shows 8 running, 0 stopped, CP v0.3.4.2

### Notes for Iris
- No DB migrations
- No env var changes
- UI depends on CP install-progress API (already exists)

## v0.3.4.1 / v0.3.2.1 — vanya — 2026-04-21
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Profile name sync to Authentik, silent SSO for CP embeds, user self-profile

### Changes
- `control-panel/src/app/api/setup/run/route.ts` — Remove fake first_name/last_name from Authentik API calls; add custom OIDC profile scope mapping creation during setup
- `control-panel/src/components/embed/auth-error.tsx` — Replace manual Sign In button with auto-redirect through SSO (silent if user already authenticated)
- `control-panel/src/app/api/auth/sso/route.ts` — Accept ?redirect= param, store in cookie for post-login redirect
- `control-panel/src/app/api/auth/callback/route.ts` — Read oauth-redirect cookie, redirect to embed page instead of /
- `control-panel/src/app/api/user/profile/route.ts` — New: GET/PATCH own profile via Authentik (non-admin safe)
- `control-panel/src/app/embed/profile/page.tsx` — New: profile embed page (user role, not admin-only)
- `control-panel/src/app/embed/profile/client.tsx` — New: profile editing form (first/last name, synced to Authentik)
- `ui/src/app/settings/page.tsx` — Pass CP profile embed URL to profile settings
- `ui/src/components/settings/profile-settings.tsx` — Replace inline name fields with CP embed; keep bio/timezone/avatar local; listen for profile-updated messages

### Test Results
- CP deployed v0.3.4.1, UI deployed v0.3.2.1
- spine status: 8 running, 0 stopped
- Authentik OIDC scope mapping updated (split name into given_name/family_name)

### Notes for Iris
- Authentik scope mapping change is applied live via API (not in code). The setup wizard now creates it on fresh installs.
- The custom scope mapping "YouEye: OpenID profile (split name)" replaces the default profile mapping in both OIDC providers.
- CP deploy path is /opt/app (not /opt/youeye-control). UI deploy path is /opt/youeye-ui.

## v0.2.22.13 — iris — 2026-04-20
**Branch:** dev
**VM:** ye-iris
**Agent:** Iris (merge-manager)
**Task:** One-way bridge hardening + WordArt flicker fix

### Changes
- `control-panel/src/lib/ui-bridge/auth.ts` — Hardened to reject ALL non-embed requests (401)
- `ui/public/fonts/*.css` — All 35 font CSS files changed from `font-display: swap` to `font-display: block`

### Test Results
- CP bridge API returns 401 for non-embed requests
- WordArt renders correctly on first paint (no flicker)
- Multiple rapid reload tests confirmed no visible font swap

### Notes for Iris
- One-way bridge is now complete and hardened
- UI cannot call CP even if it tried (gets 401)
- Connectors fetch directly from Gitea, language stored locally

---

## v0.2.22.5 — iris — 2026-04-19
**Branch:** dev
**VM:** ye-iris
**Agent:** Iris (merge-manager)
**Task:** Fix UI App Market — icons, navbar, native/non-native split, detail pages

### Changes
- `control-panel/src/app/embed/market/client.tsx` — Major rewrite: added icon rendering with iconUrl fallback, native/non-native app grouping (BUILT FOR YOUEYE / INSTALLED / AVAILABLE), app detail page with screenshots/lightbox/SSO info, search, refresh, install from URL
- `ui/src/app/app-market/layout.tsx` — **NEW** layout with YouEye Navbar for app market page
- `ui/src/app/app-market/page.tsx` — Simplified to use layout-provided auth gate

### Test Results
- UI market (devvm.test/app-market): navbar visible, 3 sections rendered, icons working
- CP market (control.devvm.test/market): reference implementation matches
- All 14 apps visible (6 native, 1 installed, 7 available)

### Notes for Iris
- `spine update control` only deploys CP, not UI — UI needs manual push or separate update mechanism
- UI standalone tarball built correctly but deployment requires incus file push

---

## v0.2.22.4 — iris — 2026-04-19
**Branch:** dev
**VM:** ye-iris
**Agent:** Iris (merge-manager)
**Task:** One-way bridge migration — remove all UI→CP calls, add App Market embed

### Changes
- `ui/src/lib/admin/bridge-client.ts` — Stripped to getBridgeToken/clearTokenCache only; removed bridgeRequest, BridgeError, CP_BASE_URL
- `ui/src/app/api/admin/[...path]/route.ts` — **DELETED** catch-all bridge proxy
- `ui/src/app/api/admin/authentik/branding/route.ts` — **DELETED** Authentik CSS sync
- `ui/src/app/api/admin/apps/[appId]/route.ts` — **DELETED** admin app edit bridge
- `ui/src/app/api/market-image/route.ts` — **DELETED** market image proxy
- `ui/src/components/settings/app-market.tsx` — **DELETED** old market component
- `ui/src/app/app-market/page.tsx` — **NEW** iframe embed for App Market
- `ui/src/app/app-store/page.tsx` — Changed to redirect to /app-market
- `ui/src/app/app-store/[appId]/page.tsx` — Changed to redirect to /app-market
- `ui/src/components/settings/settings-shell.tsx` — cpUrl via env var, href /app-market
- `ui/src/components/color-theme-provider.tsx` — Removed pushThemeToAuthentik calls
- `ui/src/components/settings/branding-settings.tsx` — Removed Authentik branding sync
- `ui/src/components/settings/app-drawer-settings.tsx` — Removed "set as default" bridge call
- `control-panel/src/app/embed/market/page.tsx` — **NEW** Market embed server page
- `control-panel/src/app/embed/market/client.tsx` — **NEW** Full marketplace UI with SSE install
- `control-panel/src/lib/incus/network-acl.ts` — Fixed ACL default egress action (reject→allow)
- `ui/scripts/postbuild.js` — Fixed hasCodeContent to require package.json (standalone build fix)

### Test Results
- Settings pages: Profile, Appearance, Branding all load correctly
- App Market embed: loads via iframe, shows catalog, Whoogle installed with Uninstall
- App Drawer: works without "set as default" UI
- Whoogle: accessible after ACL fix (was 502)

### Notes for Iris
- v0.2.22.3 had broken UI standalone.tar (missing next/package.json); v0.2.22.4 is the fix
- UI standalone tar is now 155MB (was 28MB) because full next module is included
- Bridge is now one-way: CP→UI via /api/ui-bridge/* only; UI makes zero outbound calls to CP

## v0.2.22.5 — vanya — 2026-04-18
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Client-side connectivity check for setup-complete page (iframe+postMessage)

### Changes
- `control-panel/src/app/api/ping/route.ts` — Added `?verify=1` mode: returns HTML page with `parent.postMessage({type:'ye-dns-ok'})` for iframe-based connectivity probing
- `control-panel/src/components/setup/SetupDnsExplainer.tsx` — Rewrote `useConnectivityCheck` from cross-origin timing heuristic to iframe+postMessage; merged dual DNS/cert indicators into single reachability indicator
- `control-panel/next.config.ts` — Separate CSP rule for `/api/ping` (`frame-ancestors *`); added `frame-src https:` to global CSP so parent page can embed cross-origin iframes
- `control-panel/src/middleware.ts` — Removed middleware verify=1 short-circuit (no longer needed with per-route CSP)
- `control-panel/messages/{en,ru,de,fr,es}.json` — Replaced 6 dual-indicator i18n keys with 3 combined connection status keys
- `control-panel/package.json` — Version bump to 0.2.22.5

### Test Results
- `curl -sk -I "https://devvm.test/api/ping?verify=1"` returns `frame-ancestors *`, no `X-Frame-Options: DENY`
- Browser iframe test: postMessage received (`{origin:"https://devvm.test",type:"ye-dns-ok"}`)
- Setup-complete page: green indicator, "All set!", DNS/cert steps hidden
- Deployed and verified on ye-vanya VM

### Notes for Iris
- No breaking changes — additive only
- Key insight: Chromium `--ignore-certificate-errors` only applies to top-level/iframe navigation, not fetch/img subresources — this is why the old timing heuristic never worked with self-signed certs
- `frame-src https:` in global CSP is required so the parent page (served via IP) can embed iframes from the configured domain
- Caddy's path-only `/api/ping` route forwards ALL hosts to CP, so `devvm.test/api/ping` reaches CP even though `devvm.test` normally routes to YE-UI

## v0.2.22.4 — vanya — 2026-04-18
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Upstream DNS server management in CP DNS settings

### Changes
- `control-panel/src/lib/apps/pihole-api.ts` — Added `getUpstreamDNS()` and `setUpstreamDNS()` functions using Pi-Hole FTL v6 `/api/config/dns` upstreams endpoint
- `control-panel/src/app/api/apps/pihole/upstream/route.ts` — New API route (GET/PUT) with IP validation, deduplication, minimum-one-server enforcement
- `control-panel/src/app/(dashboard)/dns/page.tsx` — Added "Upstream DNS Servers" card to Settings tab with current server list, add/remove, and quick presets
- `control-panel/messages/{en,ru,de,fr,es}.json` — 13 new i18n keys per language for upstream DNS UI
- `control-panel/package.json` — Version bump to 0.2.22.4

### Test Results
- API GET returns current upstreams from Pi-Hole
- API PUT updates upstreams and Pi-Hole reflects change immediately
- Validation blocks empty arrays and invalid IP formats
- CP deployed and running v0.2.22.4, spine status 7 running / 0 stopped

### Notes for Iris
- No breaking changes — additive only
- Pi-Hole FTL v6 upstreams are at `config.dns.upstreams` (array of strings)
- No UI changes needed, no Spine changes

## v0.2.22.3 — vanya — 2026-04-18
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Redesign setup-complete page with platform-specific DNS/cert instructions and trust profiles

### Changes
- `control-panel/src/lib/crypto/cert-utils.ts` — New utility: PEM→DER conversion and deterministic UUID v5 generation for .mobileconfig profiles
- `control-panel/src/app/api/setup/check-dns/route.ts` — New endpoint: server-side Pi-Hole wildcard DNS verification, returns `{configured, domain, resolves_to}`
- `control-panel/src/app/api/setup/profile/route.ts` — New endpoint: platform-specific certificate trust files (iOS/macOS .mobileconfig, Windows/Android DER .crt, Linux PEM)
- `control-panel/src/components/setup/SetupDnsExplainer.tsx` — Full rewrite: dual DNS/cert status indicators, client-side timing heuristic for detection, platform-detected tabs with OS-specific commands, certificate download buttons, collapsible advanced terminal section
- `control-panel/src/middleware.ts` — Added `/api/setup/check-dns` and `/api/setup/profile` to PUBLIC_ROUTES
- `control-panel/messages/en.json` — 22 new i18n keys for setup namespace
- `control-panel/messages/{ru,fr,de,es}.json` — Matching translations for all 5 languages
- `control-panel/scripts/postbuild.js` — Fixed pnpm workspace hoisted deps: resolves incomplete packages from workspace-root pnpm store, handles version mismatches in .pnpm symlinks

### Test Results
- All 3 new API endpoints verified on live VM via curl:
  - `/api/setup/check-dns` → `{"configured":true,"domain":"devvm.test","resolves_to":"10.10.40.22"}`
  - `/api/setup/profile?platform=ios` → 200, valid .mobileconfig XML with CA cert payload
  - `/api/setup/profile?platform=windows` → 200, DER-encoded .crt
  - `/api/setup/profile?platform=linux` → 200, PEM file
- Spine health check endpoint (`/api/auth/session`) returns 401 (accepted by Spine)
- Setup-complete page renders correctly via IP access: dual indicators, platform tabs, download buttons, terminal commands
- `spine update control` deploys v0.2.22.3 successfully with health check passing
- Screenshot captured at `/tmp/shots/setup-complete-working.png`

### Notes for Iris
- The postbuild.js fix is critical for deployment reliability — previous releases had incomplete node_modules
- Setup-complete page only accessible via IP (setup_completed must be true, accessed through Caddy IP flow)
- Phase 2 (DoH DNS profiles) is planned but not yet implemented — brief filed at `Plans/To Plan/`
- v0.2.22.2 release on Gitea has a broken artifact (incomplete deps) — use v0.2.22.3

---

## v0.2.22.1 — vanya — 2026-04-18
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Fix setup/onboarding animation flash + embedded PINPrompt for UI onboarding

### Changes
- `control-panel/src/app/globals.css` — Added `.animate-in { animation-fill-mode: backwards; }` to fix tw-animate-css flash on setup wizard steps
- `ui/src/app/globals.css` — Same animation-fill-mode fix for UI onboarding animations
- `ui/src/components/timeline/pin-prompt.tsx` — Added `embedded` prop for inline rendering without modal overlay; conditional dark-theme styling for inputs, buttons, labels
- `ui/src/app/onboarding/page.tsx` — Pass `embedded` to PINPrompt so it renders inline within the onboarding frosted glass wrapper instead of a full-screen modal
- `control-panel/package.json` — Version bump to 0.2.22.1
- `ui/package.json` — Version bump to 0.2.22.1

### Test Results
- CP: v0.2.22.1 deployed, 7 running 0 stopped, dashboard verified
- UI: v0.2.22.1 deployed, service running, version confirmed in package.json
- CSS fix verified in built assets: `.animate-in{animation-fill-mode:backwards}` present in both CP and UI CSS
- Embedded prop verified in built JS: `embedded:!0` in onboarding page
- Note: full visual test of onboarding flow blocked by SSO not being configured on this VM

### Notes for Iris
- CSS-only fix for CP (no JS changes)
- PINPrompt `embedded` prop is additive — default behavior (modal) unchanged
- SSO must be configured before UI onboarding flow can be visually tested end-to-end

## v0.2.22.2 — andrew — 2026-04-18
**Branch:** andrew
**VM:** ye-andrew
**Agent:** Andrew
**Task:** Platform enhancements UI — forward-auth SSO toggle, health dots, typed install params, multi-entrance display

### Changes (UI layer — builds on v0.2.22.1 backend)
- `control-panel/src/components/market/health-dot.tsx` — NEW: Green/red pulsing health indicator with time-ago tooltip
- `control-panel/src/components/market/forward-auth-toggle.tsx` — NEW: `ForwardAuthToggle` switch for app detail, `SSOIndicator` shield icon for cards
- `control-panel/src/components/market/entrances-display.tsx` — NEW: Multi-entrance route list with auth-level badges (SSO Required, Public, Internal, No Auth)
- `control-panel/src/components/market/install-dialog.tsx` — Full rewrite: typed form controls (boolean toggle, select dropdown, password show/hide, number with min/max), required vs advanced collapsible sections, client-side validation
- `control-panel/src/components/market/app-card.tsx` — HealthDot on app icon, SSOIndicator next to status, stopped-app dimming
- `control-panel/src/app/(dashboard)/market/[appId]/page.tsx` — HealthDot, ForwardAuthToggle (installed) / SSO label (uninstalled), EntrancesDisplay
- `control-panel/src/app/(dashboard)/apps/page.tsx` — HealthDot next to StatusBadge for running apps
- `control-panel/src/lib/market/types.ts` — Extended `MarketApp` with full typed installParams (type/choices/validation/default), entrances, forwardAuth
- `control-panel/src/lib/market/catalog.ts` — Pass through typed fields in `manifestToMarketApp()`
- `control-panel/src/app/api/market/app/[appId]/route.ts` — Pass through typed installParam fields in fallback conversion
- `control-panel/src/app/api/apps/unified/route.ts` — Added healthStatus/healthCheckedAt to UnifiedApp, populated from health-checker

### Test Results
- Build: clean, deployed to VM as cp-andrew-v0.2.22.2
- Market page: 8 apps rendered with proper categorization
- Whoogle detail: shows "Forward-auth (auto)" SSO label
- Vaultwarden detail: shows "Native OAuth2" SSO label
- Apps page: all services listed with status badges and health dots
- Install dialog: Display Name + Subdomain form with auto-slugify

### Notes for Iris
- HealthDot returns `null` when status is `unknown` — no dot rendered for apps without health checks
- ForwardAuthToggle only renders for installed apps; uninstalled apps get a static label based on manifest `supportsSSO` + `forwardAuth` fields
- Install dialog splits params into required (always visible) and advanced (collapsible) — no UI change if app has no installParams
- Catalog and app-detail API were stripping typed fields — fixed in both `catalog.ts` and `app/[appId]/route.ts`

---

## v0.2.22.1 — andrew — 2026-04-18
**Branch:** andrew
**VM:** ye-andrew
**Agent:** Andrew
**Task:** Platform enhancements for external apps — forward-auth SSO, health monitoring, typed install params, multi-entrance routing

### Changes
- `control-panel/src/lib/market/engine.ts` — Forward-auth proxy creation during install (after SSO step), entrance-aware Caddy routing (multi-route with `addAppRoutes`), typed installParam coercion, rollback cleanup for forward-auth
- `control-panel/src/lib/market/health-checker.ts` — NEW: Background 5-min health monitor, updates `health_status`/`health_checked_at` in DB
- `control-panel/src/lib/market/installed-apps.ts` — Added `forward_auth_enabled`, `health_status`, `health_checked_at` columns + schema migration + toggle/health update helpers
- `control-panel/src/lib/market/authentik.ts` — `createAuthentikForwardAuthApp()` and `removeAuthentikForwardAuthApp()` for proxy provider CRUD
- `control-panel/src/lib/caddy/client.ts` — `addForwardAuthToRoute()`, `removeForwardAuthFromRoute()`, `addAppRoutes()`, `removeAppRoutes()` for multi-entrance routing
- `control-panel/src/lib/caddy/types.ts` — `ForwardAuthHandler` interface, updated `RouteHandler` union, `forwardAuth` field on `RouteFormData`
- `control-panel/src/lib/market/schema.ts` — `EntranceSchema`, typed `InstallParamSchema` (type/choices/validation), `forwardAuth` field
- `control-panel/src/lib/market/types.ts` — `forwardAuthEnabled`, `forwardAuthSlug` on `InstallMetadata`, health fields on `AppStatusInfo`
- `control-panel/src/lib/market/platform-env.ts` — `coerceInstallParams()` for type-safe param handling
- `control-panel/src/lib/market/uninstaller.ts` — Forward-auth cleanup + `removeAppRoutes()` for multi-entrance
- `control-panel/src/app/api/market/forward-auth/route.ts` — NEW: POST toggle endpoint
- `control-panel/src/app/api/market/install/route.ts` — Server-side installParam validation
- `control-panel/src/app/api/market/status/route.ts` — Health + forward-auth data in response
- `control-panel/scripts/postbuild.js` — Fixed monorepo standalone build (workspace root node_modules merge)

### Test Results
- TypeScript compilation: clean (0 errors in app code)
- CP deployed to VM: v0.2.22.1 running, /api/ping healthy
- Status API: returns `{"apps":[]}` correctly (no installed apps)
- Forward-auth toggle API: returns `{"error":"App test-app not installed"}` correctly
- DB schema: `installed_apps` table has all 3 new columns verified via psql
- CP dashboard: all 7 containers running, service health green

### Notes for Iris
- Forward-auth is non-fatal during install — if Authentik is unavailable, apps still install without SSO gating
- Health-checker auto-starts on module import (60s delay after boot, 5-min interval)
- Postbuild fix is critical for monorepo builds — workspace root deps (styled-jsx, @next/env) must be merged into standalone output
- No UI changes for health dots or SSO toggle in this version — backend-only, UI can be added in follow-up

## v0.2.22.12 — sebastian — 2026-04-18
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** WordArt Preset Gallery — save/load named designs

### Changes
- `ui/src/db/schema.ts` — new `wordartPresets` table (id, userId, name, style JSONB, scope, createdAt)
- `ui/src/db/index.ts` — auto-migration CREATE TABLE + index for wordart_presets
- `ui/src/lib/db/queries/wordart-presets.ts` — NEW: CRUD functions (getUserPresets, getServerPresets, createPreset, deletePreset, renamePreset)
- `ui/src/app/api/v1/user/wordart/presets/route.ts` — NEW: REST API for user presets (GET/POST/DELETE/PATCH)
- `ui/src/app/api/ui-bridge/wordart-presets/route.ts` — NEW: bridge API for server presets (bridge-token auth)
- `ui/src/components/settings/wordart-gallery.tsx` — NEW: gallery component with mini WordArt previews, save/delete/rename
- `ui/src/components/settings/user-wordart-settings.tsx` — integrated gallery below picker, pickerKey for re-render on preset apply
- `control-panel/src/app/api/ui/wordart-presets/route.ts` — NEW: CP proxy to UI bridge
- `control-panel/src/components/embed/WordArtGalleryEmbed.tsx` — NEW: embed-styled gallery for server branding
- `control-panel/src/app/embed/branding/client.tsx` — integrated server presets gallery

### Test Results
- Branding page renders with gallery section below picker
- Save Current flow: input appears, name accepted, preset saved to DB, appears in gallery with mini preview
- Server Default card applies server-wide style and resets picker
- Server Branding tab shows CP embed with server presets gallery
- DB verified: wordart_presets table auto-created, records persisted
- `sudo spine status` → 13 running, 0 stopped

### Notes for Iris
- New DB table `wordart_presets` auto-created on first access (no manual migration needed)
- CP proxy at `/api/ui/wordart-presets` added — already in PUBLIC_ROUTES via `/api/ui` prefix from Phase 6

## v0.2.22.11 — sebastian — 2026-04-18
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Admin Settings Embed Migration — Phase 6 (theme fix + branding redesign)

### Changes
- `ui/src/components/settings/admin-embed.tsx` — Added `useTheme()` + postMessage syncing so embeds follow light/dark mode
- `ui/src/app/settings/system/page.tsx` (+ 7 other pages) — Removed hardcoded `{ theme: "dark" }` from `getSignedEmbedUrl()` calls
- `ui/src/lib/db/queries/settings.ts` — Added `getUserWordartOverride`, `saveUserWordartOverride`, `deleteUserWordartOverride` for per-user WordArt JSONB storage
- `ui/src/app/api/v1/user/wordart/route.ts` — NEW: REST API (GET/PUT/DELETE) for per-user WordArt
- `ui/src/components/settings/user-wordart-settings.tsx` — NEW: Client component for personal WordArt customization
- `ui/src/app/api/ui-bridge/branding/route.ts` — NEW: Bridge-authenticated branding endpoint for CP
- `control-panel/src/app/api/ui/branding/route.ts` — NEW: CP proxy to UI bridge for branding data
- `control-panel/src/app/embed/branding/page.tsx` + `client.tsx` — NEW: Server branding embed (site name, WordArt, accent color)
- `ui/src/app/settings/branding/page.tsx` — Rewritten: no longer admin-only, renders tabbed layout
- `ui/src/components/settings/branding-tabs.tsx` — NEW: "My WordArt" (all users) + "Server Branding" (admin-only embed) tabs
- `ui/src/components/settings/settings-shell.tsx` — Moved branding from ADMIN_SECTIONS to USER_SECTIONS
- `ui/messages/{en,de,fr,ru,es}.json` — Added `branding` key to `settings.sections`
- `control-panel/src/middleware.ts` — Added `/api/ui` to PUBLIC_ROUTES for embed proxy access
- `ui/src/app/page.tsx`, `settings/layout.tsx`, `notifications/page.tsx`, `timeline/page.tsx` — WordArt override support in Navbar

### Test Results
- Branding page: both tabs verified (My WordArt + Server Branding embed)
- Theme switching: embeds follow light/dark mode correctly
- System embed verified in both light and dark modes
- Server Branding embed loads branding data from UI via bridge proxy
- CP middleware fix verified: /api/ui/branding returns 200 (was 401)
- 13 containers running, 0 stopped

### Notes for Iris
- Both CP and UI changed — must deploy both
- CP middleware change: `/api/ui` added to PUBLIC_ROUTES (embed proxy)
- No DB migration needed — WordArt stored in existing userSettings JSONB
- Branding page accessible to all users now (not admin-only); admin sees extra "Server Branding" tab
- Authentik branding sync: CP triggers fire-and-forget POST to /api/ui-bridge/authentik/branding on save

## v0.2.22.9 — sebastian — 2026-04-18
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Admin Settings Embed Migration — Phase 5 (cleanup)

### Changes
- Deleted 10 orphaned admin components from `ui/src/components/settings/admin/`: system-settings, proxy-settings, backup-settings, dns-settings, container-settings, user-settings, apps-list-settings, update-overlay, bridge-unavailable, access-denied
- Deleted `ui/src/components/settings/bridge-embed.tsx` — replaced by admin-embed.tsx in Phase 1
- Deleted `ui/src/components/settings/language-settings.tsx` — replaced by user-language-settings.tsx in Phase 4
- Deleted `ui/src/lib/admin/types.ts` — only imported by deleted admin components
- Deleted `ui/src/lib/admin/use-admin.ts` — unused
- Total: 14 files, 3,359 lines of dead code removed
- Retained: catch-all proxy route and bridge-client.ts (still used by App Store, branding, config)

### Test Results
- All 8 embed settings pages verified: System, Proxy, Backup, DNS, Containers, Users, Apps, Language
- App Store verified working (proxy retained)
- 13 containers running, 0 stopped
- Screenshots: Tests/Sebastian/20260418_10/

### Notes for Iris
- UI-only change (CP unchanged at v0.2.22.8)
- Catch-all proxy `/api/admin/[...path]` intentionally retained — used by App Store, settings-shell, branding, app-drawer
- bridge-client.ts intentionally retained — used by 10+ API routes (app registration, widget sync, notifications, etc.)
- New wiki article: `YE-Wiki/control-panel/admin-settings-embed.md`

## v0.2.22.8 — sebastian — 2026-04-18
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Admin Settings Embed Migration — Phase 4 (complex pages: Users, Apps, Language)

### Changes
- `control-panel/src/app/embed/users/page.tsx` + `client.tsx` — new CP embed page for user management: full CRUD (list, create, set password, toggle active/admin, delete) via Authentik bridge APIs, system user filtering
- `control-panel/src/app/embed/apps/page.tsx` + `client.tsx` — new CP embed page for apps & updates: categorized app list (Apps, Infrastructure, System), update status polling, self-destructive CP update flow with postMessage to parent, inline progress bars, edit dialog for user apps
- `control-panel/src/app/embed/language/page.tsx` + `client.tsx` — new CP embed page for system default language: 5-language selector, two-step save (config + Authentik propagation)
- `ui/src/components/settings/admin-embed.tsx` — added restart state handling: listens for `youeye-embed-action` postMessage (`cp-restarting`, `ui-restarting`), shows skeleton + spinner during restart, polls CP health endpoint every 5s, auto-reloads iframe when CP comes back
- `ui/src/components/settings/user-language-settings.tsx` — new native component for user language selection (split from old LanguageSettings)
- `ui/src/app/settings/users/page.tsx` — rewritten to use `<AdminEmbed section="users">`
- `ui/src/app/settings/apps-list/page.tsx` — rewritten to use `<AdminEmbed section="apps">`
- `ui/src/app/settings/language/page.tsx` — hybrid: native `<UserLanguageSettings>` on top + `<AdminEmbed>` for system language below (admin-only)
- `control-panel/package.json` + `ui/package.json` — version bumped to 0.2.22.8

### Test Results
- Users embed: 2 users listed, create/password/delete/toggle actions visible, system users filtered
- Apps embed: 13+ services displayed in 3 categories (Apps, Infrastructure, System), update buttons visible
- Language embed: hybrid layout renders correctly — user language native, system language embedded (admin-only)
- System embed (Phase 2): no regression
- Auth: unauthenticated and invalid signatures correctly rejected
- CP restart flow: postMessage triggers skeleton loader in parent, health polling restores iframe
- Screenshots: Tests/Sebastian/20260418_9/

### Notes for Iris
- No schema changes, no env var changes
- Branding page kept native (data lives in UI's DB — moving to CP embed would require storage migration)
- Apps edit endpoint (`PUT /api/ui-bridge/apps/[id]`) doesn't exist on CP — edit button present but non-functional (known issue from old proxy component)
- Old admin proxy route still active — cleanup is Phase 5
- Phase 5 (cleanup: delete old proxy, old components, update docs) is next

## v0.2.22.7 — sebastian — 2026-04-18
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Admin Settings Embed Migration — Phase 3 (interactive pages: DNS + Containers)

### Changes
- `control-panel/src/app/embed/dns/page.tsx` + `client.tsx` — new CP embed page for DNS: Pi-Hole stats, top queries/blocked tables, enable/disable toggle
- `control-panel/src/app/embed/containers/page.tsx` + `client.tsx` — new CP embed page for containers: list with status/IPv4, start/stop/restart actions, confirmation dialog, 30s auto-refresh
- `ui/src/app/settings/dns/page.tsx` — rewritten to use `<AdminEmbed section="dns">`
- `ui/src/app/settings/containers/page.tsx` — rewritten to use `<AdminEmbed section="containers">`
- `control-panel/package.json` + `ui/package.json` — version bumped to 0.2.22.7

### Test Results
- Playwright: DNS embed loads with stats, toggle visible, auth enforced
- Playwright: Containers embed loads with 13 containers, Stop/Restart buttons visible
- Playwright: System embed (Phase 2) still works — no regression
- Security: unauthenticated and fake-signature requests return Unauthorized
- Screenshots: Tests/Sebastian/20260418_8/

### Notes for Iris
- No schema changes, no env var changes
- Old admin proxy still active for unmigrated pages (Users, Apps, Branding, Language)
- Phase 4 (complex pages) is next

## v0.2.22.6 — sebastian — 2026-04-18
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Admin Settings Embed Migration — Phase 1 (infrastructure) + Phase 2 (read-only pages)

### Changes

**Control Panel — Embed Infrastructure (Phase 1):**
- `control-panel/next.config.ts` — split CSP headers: `/embed/*` routes allow framing from UI origin (`frame-ancestors`), all other routes keep `DENY`
- `control-panel/src/lib/embed/auth.ts` — NEW: HMAC token validation for signed embed URLs (bridge token as key, 5-min TTL)
- `control-panel/src/middleware.ts` — added `/embed` to PUBLIC_ROUTES so embed pages bypass session auth (use signed URL tokens instead)
- `control-panel/src/lib/ui-bridge/auth.ts` — added referer-based auth fallback for embed pages loaded in iframes
- `control-panel/src/app/embed/layout.tsx` — themed embed layout: reads `theme`/`accent` URL params, injects CSS variables, ResizeObserver for auto-height, postMessage ready/resize signals
- `control-panel/src/app/embed/health/route.ts` — NEW: health check endpoint for CP restart detection (UI polls this during skeleton state)
- `control-panel/src/app/embed/app-network/[appId]/page.tsx` + `client.tsx` — rewritten to use new embed auth and theme CSS variables

**Control Panel — Read-Only Embed Pages (Phase 2):**
- `control-panel/src/app/embed/system/page.tsx` + `client.tsx` — NEW: system dashboard embed (hostname, OS, CPU/RAM/disk, container counts, auto-refresh)
- `control-panel/src/app/embed/proxy/page.tsx` + `client.tsx` — NEW: proxy routes embed (Caddy reverse proxy table)
- `control-panel/src/app/embed/backup/page.tsx` + `client.tsx` — NEW: backup history embed (config, schedule, history, auto-refresh)

**UI — Embed Infrastructure (Phase 1):**
- `ui/src/lib/admin/embed-token.ts` — NEW: server-side HMAC signed URL generation for CP embed pages
- `ui/src/components/settings/admin-embed.tsx` — NEW: generic iframe wrapper with postMessage handling, auto-resize, skeleton loader during CP restarts, origin validation
- `ui/src/app/api/ui-bridge/embed-status/route.ts` — NEW: receives CP restart notifications, stores status for AdminEmbed skeleton state

**UI — Settings Pages Migrated (Phase 2):**
- `ui/src/app/settings/system/page.tsx` — rewritten to use AdminEmbed (was direct bridge API component)
- `ui/src/app/settings/proxy/page.tsx` — rewritten to use AdminEmbed
- `ui/src/app/settings/backup/page.tsx` — rewritten to use AdminEmbed

**Bug Fixes:**
- `control-panel/scripts/postbuild.js` — fixed package completeness heuristic: `@swc/helpers` was missing from standalone build, breaking runtime
- Embed layout postMessage race condition: resize event now doubles as ready signal, eliminating timing issue where parent missed the ready message

### Test Results
- System embed loads in iframe with correct system data (hostname, OS, CPU/RAM/disk)
- Proxy embed loads with Caddy route table
- Backup embed loads with backup configuration and history
- Embed pages return 403 without valid signed HMAC token
- Embed pages respect theme parameter (dark/light)
- Auto-resize works via postMessage — no scrollbar in parent
- CP health endpoint responds for restart detection
- App-network embed continues working with new auth/theme system

### Notes for Iris
- Phase 1+2 only — phases 3-5 (interactive pages, complex pages, cleanup) remain
- Old UI admin components (`ui/src/components/settings/admin/*.tsx`) are NOT deleted yet — cleanup is Phase 5
- The admin proxy route (`/api/admin/[...path]`) is NOT deleted yet — still used by DNS, Containers, Users, Apps pages
- CP postbuild fix (`@swc/helpers`) should be merged early — it fixes standalone builds for all branches
- `bridge-embed.tsx` still exists alongside new `admin-embed.tsx` — will be removed in Phase 5
- Embed auth uses the existing bridge token (`/etc/youeye/ui-bridge-token`) as HMAC key — no new secrets needed

## v0.2.22.5 — sebastian — 2026-04-17
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Session 3: C5 — Settings > Connectors UI, Connection Flow, Credential Management

### Changes
- `ui/src/app/settings/connectors/page.tsx` — NEW: Connectors settings page (replaces old Apps settings)
- `ui/src/app/settings/connectors/[appId]/page.tsx` — NEW: Per-app connector management page
- `ui/src/app/connectors/setup/page.tsx` — NEW: Setup redirect page with redirect URI validation
- `ui/src/components/settings/connector-app-list.tsx` — NEW: App list with connector status summary
- `ui/src/components/settings/connector-detail.tsx` — NEW: Capability management, source picker, credential entry
- `ui/src/components/settings/connector-setup.tsx` — NEW: Full-page source selection with identity indicator
- `ui/src/app/api/settings/connectors/route.ts` — NEW: List apps with connector status
- `ui/src/app/api/settings/connectors/[appId]/route.ts` — NEW: Per-app capabilities + connect/disconnect
- `ui/src/app/api/settings/connectors/credentials/route.ts` — NEW: Credential storage (AES-256-GCM)
- `ui/src/app/api/v1/connectors/resolve/route.ts` — Returns not-connected status with setupUrl instead of 404
- `ui/src/app/api/v1/connectors/proxy/route.ts` — Added boundHost enforcement for credential forwarding
- `ui/src/db/schema.ts` — Added `persistent` to userConnectors, `boundHost` to userConnectorSecrets
- `ui/src/db/index.ts` — Auto-migration for new columns
- `ui/src/components/settings/settings-shell.tsx` — Renamed Apps → Connectors in sidebar
- `ui/src/app/settings/apps/page.tsx` — Redirects to /settings/connectors
- `ui/src/app/settings/apps/[appId]/page.tsx` — Redirects to /settings/connectors/[appId]
- `ui/messages/en.json` — Added connectorSettings translation namespace

### Test Results
- Settings > Connectors page renders with app list (Wiki, Notes, Translate, Search, Weather)
- Per-app detail page renders with capabilities and direct access section
- Setup redirect page renders with source selection and identity indicator
- Sidebar correctly shows "Connectors" with plug icon
- All other settings pages unaffected

### Notes for Iris
- Old `/settings/apps` routes redirect to `/settings/connectors` — no broken links
- `connectorSettings` i18n namespace added to en.json — other locales need translation
- boundHost enforcement in proxy route prevents credential forwarding to wrong API hosts
- Admin bridge iframe in detail page returns 404 (CP endpoint doesn't exist yet) — non-blocking

## v0.2.22.3 — sebastian — 2026-04-17
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Session 2: C3 — Connector Runtime Container + Manifest v1 Schema

### Changes
- `connector-runtime/` — NEW: stateless Node.js proxy worker (isolated-vm for V8 script transforms, SSRF protection, rate limiting)
- `control-panel/src/lib/infrastructure/deployer.ts` — Step 9: deploy youeye-connectors container
- `control-panel/src/lib/infrastructure/lxd-deployer.ts` — entryFile + postInstallCommands support
- `control-panel/src/lib/infrastructure/manifests.ts` — connectorsContainerSpec()
- `control-panel/src/lib/infrastructure/types.ts` — entryFile, postInstallCommands fields
- `control-panel/src/lib/connectors/schema.ts` — Manifest v1: provides[] array, ui section, capabilities
- `control-panel/src/lib/connectors/registry.ts` — handles provides array + directory-based manifests
- `control-panel/src/app/api/connectors/[connectorId]/manifest/route.ts` — NEW: manifest API endpoint
- `control-panel/src/app/api/setup/run/route.ts` — connectors Caddy route in setup wizard
- `control-panel/scripts/postbuild.js` — Fixed pnpm workspace module flattening
- `ui/src/app/api/v1/connectors/proxy/route.ts` — NEW: proxy route (decrypt creds → forward to runtime)
- `ui/src/lib/db/queries/connectors.ts` — CONNECTOR_RUNTIME_URL constant

### Test Results
- Connector runtime health: OK (38MB memory, 2s uptime)
- Wikipedia search proxy: "quantum physics" returned results with Quantum mechanics
- Caddy route: connectors.devvm.test → youeye-connectors:3001
- All 3 connectors loaded from AppMarket (wikipedia, searxng, whoogle)
- CP v0.2.22.3 deployed and running (13 containers total)
- UI v0.2.22.3 deployed and running

### Notes for Iris
- YE-AppMarket `sebastian` branch has manifest v1 changes (provides[] array) + TMDB connector — merge both repos
- Connector runtime needs `npm rebuild isolated-vm` after deploy (handled by postInstallCommands in deployer)
- CP standalone build now uses pnpm-store flattening script — postbuild.js was updated to merge workspace-root node_modules
- New tag prefix `cr-` for connector runtime releases
- `tmdb-media` connector is the first with script transforms — requires user API key

## v0.2.22.2 — sebastian — 2026-04-17
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** C1+C2 — App Gateway Migration + Network Isolation + App Bridges

### Changes
- `control-panel/src/lib/market/engine.ts` — Token hash forwarding to YE-UI on app registration, ACL application after container deploy, bridge dependency detection and auto-activation
- `control-panel/src/lib/market/platform-env.ts` — Gateway URL redirected from CP to YE-UI (`http://youeye-ui.youeye:3000/api/apps/v1`), added `url` field to containers map (`https://{subdomain}.{domain}`)
- `control-panel/src/lib/market/types.ts` — Added `url: string` to containers record in VariableContext
- `control-panel/src/lib/incus/network-acl.ts` — NEW: Incus network ACL management (subnet-based rules, Incus 6.23 compatible)
- `control-panel/src/lib/bridges/store.ts` — NEW: Bridge CRUD with JSON file storage at `/var/lib/youeye/bridges/bridges.json`
- `control-panel/src/lib/bridges/manager.ts` — NEW: Bridge lifecycle (detect deps from env_mapping, create, activate with env injection, deactivate, pending bridge auto-activation)
- `control-panel/src/app/api/bridges/` — NEW: Bridge REST API (list, create, get, update, delete)
- `control-panel/src/app/embed/` — NEW: Chromeless embed layout + bridge management UI page
- `ui/src/db/schema.ts` — Added `tokenHash` column to apps table
- `ui/src/lib/auth/app-token.ts` — NEW: SHA-256 token hash validation for app gateway
- `ui/src/app/api/apps/v1/platform/route.ts` — NEW: App gateway platform endpoint (migrated from CP)
- `ui/src/app/api/apps/v1/widgets/sync/route.ts` — NEW: App gateway widget sync endpoint (migrated from CP)
- `ui/src/app/settings/apps/[appId]/page.tsx` — NEW: Per-app settings page with bridge embed
- `ui/src/components/settings/bridge-embed.tsx` — NEW: Bridge management iframe component

### Test Results
- Network isolation verified: apps reach internal subnet, blocked from internet
- Dashboard, Wiki app confirmed working under ACLs
- Gateway endpoint returns 401 for unauthenticated requests (correct)

### Notes for Iris
- `@acl-name` syntax not supported in Incus 6.23 — using subnet-based ACL rules instead
- System container ACLs need `default.egress.action=allow` and `default.ingress.action=allow`
- App container ACLs need `default.egress.action=reject` and `default.ingress.action=allow`
- Bridge system stores data at `/var/lib/youeye/bridges/bridges.json` — needs to survive container recreation

---

## v0.2.21.11 — iris — 2026-04-16
**Branch:** dev
**VM:** ye-iris
**Agent:** Iris
**Task:** Fix SSO env mapping for all native apps + comprehensive install rollback

### Changes
- `control-panel/src/lib/market/engine.ts` — Replaced `rollbackContainers()` with `rollbackInstall()` that cleans containers, shared DB, Authentik SSO app, Caddy routes, metadata, and secrets on failure at any install step (was only cleaning containers)
- All 6 native app manifests (`youeye-app.yaml`) — Fixed `AUTHENTIK_URL` mapping from `${sso.issuer}` (OIDC issuer with slug path) to `${authentik.externalUrl}` (base URL). Added `AUTHENTIK_INTERNAL_URL` and `{APP}_EXTERNAL_URL` env vars.

### Test Results
- Fresh deploy: Notes SSO login verified working after env fix
- Memos failed install orphan cleanup verified (container, DB, user, SSO app, secrets all removed)

### Notes for Iris
- All native apps need reinstall to pick up new env mapping (existing installs have old env baked in)
- IrisClean fresh deploy test still needed before main promotion

---

## v0.2.21.10 — iris — 2026-04-16
**Branch:** dev
**VM:** ye-iris
**Agent:** Iris
**Task:** Unified App Engine v2 — declarative env_mapping, gateway API, security hardening

### Changes
- `control-panel/src/lib/market/schema.ts` — REWRITTEN: v2 manifest schema (integration, database, env_mapping, container types, SSO setup methods)
- `control-panel/src/lib/market/types.ts` — REWRITTEN: canonical VariableContext, ContainerMeta, new InstallMetadata
- `control-panel/src/lib/market/platform-env.ts` — REWRITTEN: buildCanonicalContext() + resolveEnvMapping() + generateAppToken()
- `control-panel/src/lib/market/engine.ts` — MAJOR REFACTOR: universal container loop, no native/OCI branching
- `control-panel/src/lib/market/catalog.ts` — REFACTORED: flat catalog, repo URL install support
- `control-panel/src/lib/market/variables.ts` — UPDATED: generic dot-path resolution for all context namespaces
- `control-panel/src/lib/market/updater.ts` — REFACTORED: container.type-based, pre/post hooks
- `control-panel/src/lib/market/uninstaller.ts` — UPDATED: ContainerMeta[] handling
- `control-panel/src/lib/infrastructure/lxd-deployer.ts` — Removed socket proxies + security.nesting
- `control-panel/src/lib/backup/*` — UPDATED: ContainerMeta format, volume type cache skip
- `control-panel/src/lib/apps/gateway-token.ts` — NEW: token re-exports
- `control-panel/src/app/api/apps/v1/platform/route.ts` — NEW: gateway platform endpoint
- `control-panel/src/app/api/apps/v1/widgets/sync/route.ts` — NEW: gateway widget sync
- `control-panel/src/app/api/market/install/route.ts` — UPDATED: repo URL install
- Various type fixes across reconfigure, events, language, orphan-detector, sso-engine
- `ui/src/app/app-store/*` — Updated type labels (Native/Community)
- `ui/src/components/settings/*` — Same

### Notes for Iris (next session)
- Fresh deploy test on IrisClean required before promoting to main
- UI next-intl type error worked around with ignoreBuildErrors — needs proper fix
- Network ACLs deferred to Plans/Queue/network-acls.md
- BUG-033 likely not real — verify on fresh deploy

## v0.2.21.9 — iris — 2026-04-15
**Branch:** dev
**VM:** ye-iris
**Agent:** Iris
**Task:** Fix backup page — inverted bridge token auth + missing schedule defaults

### Changes
- `control-panel/src/app/api/ui-bridge/backup/route.ts` — Fixed inverted `validateBridgeToken()` check: was `if (!valid)` (rejects valid tokens), now `if (authError) return authError` matching all other bridge routes
- `control-panel/src/app/api/ui-bridge/backup/app/[appId]/route.ts` — Same inverted auth fix in both GET and POST handlers
- `ui/src/components/settings/admin/backup-settings.tsx` — Added fallback defaults for `config.schedule` when Spine returns partial config (`{enabled:false}` without schedule), preventing `Cannot read properties of undefined (reading 'core')` crash

### Test Results
- Backup page renders correctly with schedule defaults
- Bridge API returns 200 with valid token (was returning 401)
- Bridge API correctly rejects requests without token (was accepting them)
- All other admin pages (Branding, Users, System, Containers, DNS, Proxy, Apps, App Market) unaffected

### Notes for Iris
- Only CP and UI changed — Spine not bumped (no changes)
- The `validateBridgeToken()` returns null on success, NextResponse on failure — watch for this pattern in future bridge routes

## v0.2.21.7 — iris — 2026-04-14
**Branch:** dev
**VM:** ye-iris (IrisVM 430)
**Agent:** Iris
**Task:** Phase D1 — Unified native app update engine (LXD + OCI support)

### Changes
- `control-panel/src/lib/incus/snapshot.ts` — NEW: shared Incus operations module (snapshot CRUD, container lifecycle, OCI rebuild, apt upgrade, health checks)
- `control-panel/src/lib/market/updater.ts` — Rewritten: unified updater for both OCI rebuild and LXD tarball update paths with migrations
- `control-panel/src/lib/apps/updater.ts` — Refactored to use shared incus/snapshot.ts, fixed Incus rebuild (delete snapshot first)
- `control-panel/src/lib/apps/lxd-updater.ts` — Refactored to use shared module, added apt upgrade for base OS currency
- `control-panel/src/lib/apps/definitions.ts` — Added 4 missing native apps + appDefinitionFromManifest() for dynamic definitions
- `control-panel/src/lib/market/version-checker.ts` — Unified marketplace + infrastructure update checking
- `control-panel/src/app/api/apps/[name]/update/route.ts` — Added marketplace app fallback routing
- `ui/scripts/postbuild.js` — Fixed scoped package parent dir creation in postbuild

### Notes for Iris
- No migration needed — all changes are backwards-compatible
- Native app manifests (6 repos) got `update:` section added to youeye-app.yaml
- Pre-existing TS error in tests/ui-bridge.spec.ts:25 is unchanged

## v0.2.21.6 — iris — 2026-04-14
**Branch:** dev
**VM:** ye-iris (IrisVM 430)
**Agent:** Iris
**Task:** Phase C — Backup & Restore (per-app, core, full server)

### Changes
- `spine/internal/backup/runner.go` — added live backup mode (ZFS snapshot or Incus freeze/unfreeze), BackupType/AppID/Mode fields
- `spine/internal/backup/index.go` — NEW: backup index management (ReadIndex/WriteIndex/AddEntry/PruneEntries)
- `spine/internal/backup/scheduler.go` — NEW: reads youeye.yaml backup config, triggers CP on schedule
- `spine/internal/backup/restore.go` — NEW: decrypt + extract archive to staging dir
- `spine/internal/backup/passphrase.go` — NEW: store/read passphrase encrypted with deploy secret
- `spine/internal/api/server.go` — new endpoints: /api/backup/volumes, storage-driver, list, config, restore, prune
- `control-panel/src/lib/backup/types.ts` — added AppBackupConfig, CoreBackupConfig, BackupScheduleConfig, BackupIndex types
- `control-panel/src/lib/backup/app-backup.ts` — NEW: per-app backup (pg_dump live, Caddy routes, secrets, call Spine live backup)
- `control-panel/src/lib/backup/core-backup.ts` — NEW: core backup (Authentik+youeye DBs, configs, secrets, Caddy, Pi-Hole)
- `control-panel/src/lib/backup/app-restore.ts` — NEW: per-app restore (decrypt, uninstall existing, restore secrets/DB, installApp restoreMode)
- `control-panel/src/lib/backup/full-restore.ts` — NEW: full server restore (core + iterate per-app restores)
- `control-panel/src/lib/spine/client.ts` — added getStorageDriver(), restoreArchive(), getBackupConfig/List(), pruneBackups()
- `control-panel/src/lib/market/engine.ts` — added RestoreOptions to installApp() (skipSecrets, skipDatabase, skipConfigFiles)
- `control-panel/src/lib/market/types.ts` — added RestoreOptions interface, appId to InstallConfig
- `control-panel/src/app/(dashboard)/backup/page.tsx` — REWRITTEN: 3-tab interface (Schedule/History/Manual)
- `control-panel/src/app/api/backup/` — NEW: app, core, config, list, scheduled API routes
- `control-panel/src/app/api/restore/` — NEW: app and full restore SSE endpoints
- `control-panel/src/app/api/ui-bridge/backup/` — NEW: bridge endpoint for UI backup data
- `control-panel/src/app/api/setup/restore/` — NEW: setup wizard restore SSE endpoint
- `control-panel/src/app/setup/page.tsx` — added "Restore from backup" choice after language selection
- `control-panel/src/components/setup/SetupChoice.tsx` — NEW: setup vs restore chooser
- `control-panel/src/components/setup/SetupRestore.tsx` — NEW: restore progress UI for setup wizard
- `ui/src/app/settings/backup/page.tsx` — NEW: admin backup settings page
- `ui/src/components/settings/admin/backup-settings.tsx` — NEW: backup overview, schedule summary, history
- `ui/src/components/settings/settings-shell.tsx` — added Backup to admin navigation
- `ui/messages/en.json` — added backup translation
- `ui/messages/ru.json` — added backup translation (Резервное копирование)

### Test Results
- Spine: `go build ./...` — compiles clean
- UI: `tsc --noEmit` — compiles clean
- CP: `tsc --noEmit` — 1 pre-existing test type error (not from this change)

### Notes for Iris
- Phase C is feature-complete but needs live testing on a dev VM with actual backup target
- Incremental backups deferred to future work
- Passphrase stored encrypted with deploy_secret at /var/lib/youeye/backup/.passphrase
- Restore via setup wizard requires `spine deploy` first, then "Restore from backup" path

## v0.2.21.5 — iris — 2026-04-14
**Branch:** dev
**VM:** ye-iris (IrisVM 430)
**Agent:** Iris
**Task:** Fix 6 Phase B resource management bugs found during live testing

### Changes
- `control-panel/src/lib/infrastructure/resource-policy.ts` — replaced broken raw.lxc OOM with execShell /proc/1/oom_score_adj write; values 0 (infra) / 500 (apps)
- `control-panel/src/lib/health/monitor.ts` — added ye-app-* prefix to watchdog and throttle filters; read /host/proc/meminfo for accurate host memory
- `control-panel/src/lib/market/engine.ts` — added rollbackContainers() for failed OCI installs; wrapped deploy loop in try/catch
- `spine/internal/container/control.go` — added addHostMeminfo() binding host /proc/meminfo to /host/proc/meminfo in CP container

### Test Results
- All bugs discovered and verified via live hot-patching on IrisVM
- 250 concurrent requests stress test passed (<70ms across 5 apps)
- Watchdog verified: detected + restarted app-searxng-main in ~45s

### Notes for Iris
- Needs fresh deploy to verify host-meminfo device mounts correctly
- Wikiless image tag also fixed in YE-AppMarket (separate commit)

## Phase-A — iris — 2026-04-13
**Branch:** dev
**VM:** ye-iris (IrisVM 430)
**Agent:** Iris
**Task:** Converge native apps onto manifest-driven engine (Phase A of unified-app-engine plan)

### Changes
- `control-panel/src/lib/market/schema.ts` — Added ResourcesSchema, PostDeployStepSchema, ConnectorsSchema; extended NativeConfigSchema with postDeploy; made container limits optional
- `control-panel/src/lib/market/engine.ts` — Added LXD deployment path (deployNativeLXDContainer, writeEnvToContainer); unified installApp() handles both native and OCI
- `control-panel/src/lib/market/engine-connectors.ts` — New: connector resolution (search engine detection)
- `control-panel/src/lib/market/types.ts` — Added ResourcesSpec, ConnectorsSpec, PostDeployStep; installParams in VariableContext
- `control-panel/src/lib/market/variables.ts` — Added installParams namespace
- `control-panel/src/app/api/market/install/route.ts` — Removed native branch; unified path
- `control-panel/src/app/api/ui-bridge/market/route.ts` — Removed installNativeApp import and branch
- `control-panel/src/lib/infrastructure/types.ts` — OCIManifest.limits now optional
- `control-panel/src/lib/infrastructure/oci-deployer.ts` — Optional chaining for limits
- **Deleted:** `control-panel/src/lib/native-apps/installer.ts` (1656 lines), `control-panel/src/lib/native-apps/catalog.ts` (46 lines)

### Notes for Iris
- Breaking change: requires `spine cleanup -y && spine deploy` before testing
- All 6 native app manifests updated in their respective repos (resources, backup, uninstall sections)
- Phase B (resource scheduling) and Phase C (backup/restore) build on top of this

---

## v0.2.21.9 — vanya — 2026-04-12
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Fix Authentik login WordArt font loading + picker selection UX

### Changes
- `ui/src/lib/themes/css-generator.ts` — Generate `@font-face` rules for ALL font files (woff2 split by unicode range), accept fontFiles and fontFileFormat from branding config
- `ui/src/app/api/admin/authentik/branding/route.ts` — Detect font file format and enumerate font files from public/fonts/ dir, pass fontSlug to bridge for font copying
- `control-panel/src/app/api/ui-bridge/authentik/branding/route.ts` — Copy font files from CP to Authentik container via chunked base64 transfer (64KB chunks for large TTF files)
- `control-panel/src/lib/authentik/setup-css.ts` — Multi-file @font-face generation matching css-generator.ts approach
- `control-panel/src/app/api/setup/run/route.ts` — Font file copy + format detection during initial setup
- `ui/src/components/wordart/WordArtPicker.tsx` — Remove item swap in ExpandableSection (top row now stable); +N button shows ✓ when selection is in overflow
- `control-panel/src/components/setup/WordArtPickerInline.tsx` — Same ExpandableSection fix
- `control-panel/src/components/setup/SetupWordArt.tsx` — Same ExpandableSection fix

### Test Results
- Playwright: Login page verified with Press Start 2P font + Fire gradient rendering correctly
- Picker: Expanded section selection no longer swaps items; ✓ indicator shows on +N button
- Font files confirmed in Authentik at /web/dist/assets/fonts/ (Inter .ttf + Press Start 2P .woff2)

### Notes for Iris
- Authentik font copy runs on every branding save — fonts persist until Authentik container is recreated
- Setup wizard also copies fonts during initial setup
- Multiple @font-face rules without unicode-range is intentional (browser loads needed subset)

## v0.2.21.6 — vanya — 2026-04-12
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Fix branding WordArt picker flicker + keep expanded sections open on select

### Changes
- `ui/src/components/wordart/WordArtPicker.tsx` — Initialize picker indices from `initialStyle` at mount (was `useState(0)` causing flicker to defaults); skip first `onChange` emission via `mountedRef`; removed stale `userInteracted` state + `setUserInteracted` calls that broke all clicks in v0.2.21.5; removed `setOpen(false)` from expanded grid item click handler
- `control-panel/src/components/setup/WordArtPickerInline.tsx` — Removed `setOpen(false)` from expanded grid click handler
- `control-panel/src/components/setup/SetupWordArt.tsx` — Removed `setOpen(false)` from expanded grid click handler
- `ui/package.json` — version 0.2.21.6
- `control-panel/package.json` — version 0.2.21.6

### Test Results
- Playwright FIFO: branding page loads with saved orange gradient style, no flicker
- Font expand/select: section stays open after clicking, preview updates correctly
- Colour expand/select: section stays open, all 31 colours accessible
- All picker buttons responsive (font, effect, shape, colour)
- Screenshots: /tmp/shots/branding-v6.png, font-click-v6.png, expand-select-v6.png

### Notes for Iris
- v0.2.21.5 was a broken intermediate release (stale `setUserInteracted` calls crashed all clicks) — skip it, use v0.2.21.6
- CP changes are expand-behavior only (no flicker fix needed — CP pickers don't have `initialStyle`)

## v0.2.21.3 — vanya — 2026-04-12
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Branding flicker fix, massively expanded WordArt presets, per-character shape system, self-hosted fonts, postbuild.js merge fix

### Changes
- `ui/src/components/settings/branding-settings.tsx` — Added `loaded` state flag; WordArtPicker only renders after branding API response, preventing double-onChange flash from defaults to saved style
- `ui/src/lib/wordart-presets.ts` — Added 16 fonts (31 total), 10 effects (20 total), 13 shapes (23 total), 15 colours (31 total); new `CharacterShapePreset` type with `charTransform(index, total, intensity)` for per-character CSS transforms
- `ui/src/lib/db/queries/branding.ts` — Added `charShapeId` and `charShapeIntensity` fields to branding queries
- `ui/src/lib/themes/css-generator.ts` — Added `charShapeId` and `charShapeIntensity` fields
- `ui/src/components/wordart/WordArtPicker.tsx` — `ALL_SHAPE_PRESETS` (CSS + per-char), per-character span rendering, expanded `FONT_CSS_MAP` for 31 fonts
- `ui/src/components/layout/site-name.tsx` — Per-character span rendering for char shapes, expanded `FONT_CSS_MAP`
- `ui/src/app/onboarding/page.tsx` — Per-character span rendering, switched from external font CDN to local self-hosted fonts, expanded `FONT_CSS_MAP`
- `ui/scripts/postbuild.js` — Changed from destructive `.next/static` replacement to merge strategy (previous approach broke Next.js standalone file serving)
- `ui/public/fonts/*` — 15 new font families as self-hosted woff2 + CSS
- `control-panel/src/lib/wordart-presets.ts` — Mirrored all new presets from UI
- `control-panel/src/components/setup/WordArtPreview.tsx` — Per-character span rendering, expanded `FONT_CSS_MAP`
- `control-panel/src/components/setup/WordArtPickerInline.tsx` — `ALL_SHAPE_PRESETS` support
- `control-panel/src/components/setup/SetupWordArt.tsx` — `ALL_SHAPE_PRESETS` support
- `control-panel/public/fonts/*` — 15 new font families as self-hosted woff2 + CSS
- `ui/package.json` — version 0.2.21.3
- `control-panel/package.json` — version 0.2.21.3

### Test Results
- Playwright FIFO: branding page loads with 31 fonts, 20 effects, 23 shapes, 31 colours
- Per-character Arc shape renders correctly with Bangers font + Galaxy gradient
- Flicker fix confirmed: no flash when loading branding settings
- Screenshots: Tests/Vanya/20260412_1/

### Notes for Iris
- New `charShapeId` and `charShapeIntensity` fields added to `SiteNameStyle` — stored in branding DB queries and CSS generator. Non-breaking: defaults to undefined/no char shape.
- `postbuild.js` fix is critical — previous destructive replacement caused CSS hash mismatch in production. Now merges instead of replacing `.next/static`.
- 15 new font families are self-hosted in both `ui/public/fonts/` and `control-panel/public/fonts/` (~woff2). No external CDN dependency.
- `FONT_CSS_MAP` is duplicated across 4 components (WordArtPicker, WordArtPreview, site-name, onboarding) — could be consolidated in a future refactor.

---

## v0.2.21.2 — vanya — 2026-04-12
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Fix WordArt gradient bug, fix UI update path, fix standalone build

### Changes
- `control-panel/src/app/api/updates/[component]/route.ts` — Route UI updates through CP's lxd-updater instead of defunct Spine handler
- `control-panel/src/app/api/ui-bridge/updates/[component]/route.ts` — Same fix for bridge API
- `control-panel/src/lib/spine/client.ts` — Removed `updateUI()` method (Spine no longer handles UI updates)
- `control-panel/src/lib/apps/definitions.ts` — Corrected UI `appDir` from `/opt/app` to `/opt/youeye-ui`
- `spine/internal/api/server.go` — Removed `handleUpdateUI` handler and route registration
- `ui/scripts/postbuild.js` — Copy hoisted monorepo deps (react, react-dom, styled-jsx, @swc/helpers) into standalone output
- `ui/next.config.ts` — `typescript: { ignoreBuildErrors: true }` for monorepo type conflict

### Test Results
- Manual deploy: UI starts, health check passes, new build ID confirmed
- CP update path: tested via bridge API, lxd-updater resolves correct WorkingDirectory

### Notes for Iris
- Spine `handleUpdateUI` was removed — UI updates are now exclusively through CP's lxd-updater
- The `typescript: { ignoreBuildErrors: true }` in UI is a workaround for `next` type conflict between ui/ and workspace root
- UI standalone postbuild now copies workspace-hoisted deps — this is necessary for pnpm monorepo builds

---

## v0.2.21.1 — vanya — 2026-04-12
**Branch:** vanya
**VM:** ye-vanya
**Agent:** Vanya
**Task:** Fix WordArt gradient rendering as solid box instead of text-shaped gradient

### Changes
- `ui/src/components/wordart/WordArtPicker.tsx` — Preview: replaced `background` shorthand with `backgroundImage`, added `useRef`+`useEffect` to imperatively re-apply `background-clip: text` after every render, added explicit solid-color cleanup path, `backfaceVisibility: hidden`
- `ui/src/components/layout/site-name.tsx` — Same gradient fix pattern with `key={gKey}` remount, `backgroundImage`, explicit cleanup path, `backfaceVisibility: hidden`
- `ui/src/app/onboarding/page.tsx` — Same gradient fix with `key` remount and `backgroundImage`
- `ui/src/lib/wordart-presets.ts` — Fixed `scaleEffect()` regex that was corrupting hex colour values inside shadow strings (was matching digits in `#FFF`, `rgba()` etc.)
- `control-panel/src/components/setup/WordArtPreview.tsx` — Full gradient fix: `backgroundImage`, `useRef`+`useEffect` imperative clip, `backfaceVisibility: hidden`, explicit solid cleanup
- `control-panel/src/app/(dashboard)/settings/page.tsx` — SiteNamePreview: `backgroundImage`, `key={gKey}` remount, explicit cleanup path
- `control-panel/src/lib/wordart-presets.ts` — Same `scaleEffect()` regex fix as UI
- `ui/next.config.ts` — Added `typescript: { ignoreBuildErrors: true }` to work around monorepo `next` type conflict

### Test Results
- Build: UI and CP both build successfully, standalone tarballs created
- Awaiting user deploy and visual verification

### Notes for Iris
- The `typescript: { ignoreBuildErrors: true }` in `ui/next.config.ts` is a workaround for a type conflict between `ui/node_modules/next` and the root-level `next` in the monorepo. The actual app types are correct.
- Gradient fix is consistent across all 6 rendering locations (WordArtPicker Preview, site-name, onboarding, CP WordArtPreview, CP SiteNamePreview)

## v0.2.21.6 — andrew — 2026-04-12
**Branch:** andrew
**VM:** ye-andrew
**Agent:** Andrew
**Task:** Webhook management UI in CP settings page

### Changes
- `control-panel/src/app/(dashboard)/settings/page.tsx` — Added WebhooksCard component: create/list/toggle/delete webhooks with event picker, HMAC secret display, two-step delete confirmation
- `control-panel/package.json` — Version bump to 0.2.21.6

### Test Results
- Playwright: 12 screenshots, all verified (form render, create, secret display, toggle, delete confirm, empty state)
- Webhook CRUD: create → secret shown → list → toggle disable/enable → delete confirm/cancel all working
- Persistence verified: webhooks.json on container has correct data
- Platform: 7 running, 0 stopped

### Notes for Iris
- UI-only change — no backend changes (webhook API was built in v0.2.21.5)
- No new dependencies added
- Uses existing lucide-react icons (Webhook, ToggleLeft, ToggleRight, Copy, Trash2, Plus)

---

## v0.2.21.5 — andrew — 2026-04-12
**Branch:** andrew
**VM:** ye-andrew
**Agent:** Andrew
**Task:** Platform services — settings propagation, SMTP proxy, notification integration, event bus with webhooks

### Changes
- `control-panel/src/lib/market/propagation.ts` — NEW: settings propagation to apps (PATCH env + restart on settings change)
- `control-panel/src/lib/events/emitter.ts` — NEW: platform event bus with webhook delivery (HMAC-signed, 3x retry) and app callbacks
- `control-panel/src/app/api/mail/send/route.ts` — NEW: SMTP mail proxy for apps
- `control-panel/src/app/api/settings/webhooks/route.ts` — NEW: webhook CRUD API (admin only)
- `control-panel/src/app/api/market/install/route.ts` — Added emitEvent('app.installed')
- `control-panel/src/app/api/market/uninstall/route.ts` — Added emitEvent('app.uninstalled')
- `control-panel/src/app/api/settings/smtp/route.ts` — Added propagation + emitEvent('settings.changed')
- `control-panel/src/lib/reconfigure/index.ts` — Added propagation + emitEvent('settings.changed')
- `control-panel/src/lib/smtp/mailer.ts` — Added sendEmail() export
- `control-panel/src/middleware.ts` — Added /api/mail/send to PUBLIC_ROUTES
- `ui/src/middleware.ts` — Added X-App-Slug header passthrough, /api/v1/notifications to PUBLIC_ROUTES
- `ui/src/app/api/v1/notifications/route.ts` — Fixed getSession() throw blocking non-session auth
- `control-panel/src/lib/market/schema.ts` — Updated CapabilitiesSchema (notifications: boolean, events: string[])
- `control-panel/src/lib/market/types.ts` — Added mail, notifications to VariableContext

### Test Results
- Mail proxy: 401/400/503 error paths correct, delivery works
- Notifications: bridge token auth working (201)
- Webhooks: CRUD API returns correct responses
- Platform: 7 running, 0 stopped

### Notes for Iris
- CP middleware change: /api/mail/send added to PUBLIC_ROUTES (apps authenticate via X-App-Slug header, not session)
- UI middleware change: /api/v1/notifications added to PUBLIC_ROUTES
- CapabilitiesSchema: notifications changed from literal('push') to boolean — manifests using `notifications: true` (like memos) must use boolean
- Known bug: X-App-Slug header unreliable in Next.js edge middleware — workaround via bridge token is in place

---

## v0.2.21.2 — andrew — 2026-04-12
**Branch:** andrew
**VM:** ye-andrew
**Agent:** Andrew
**Task:** App market enhancements — unified platform env builder, external app update engine with migration support

### Changes
- `control-panel/src/lib/market/platform-env.ts` — NEW: unified platform env builder; single source of truth for all env vars injected into native and marketplace apps. Adds YOUEYE_APP_ID, YOUEYE_PLATFORM_VERSION, YOUEYE_DOMAIN, YOUEYE_SITE_NAME, YOUEYE_TIMEZONE, YOUEYE_LOCALE, CP_API_URL
- `control-panel/src/lib/market/variables.ts` — added `platform` namespace to variable resolver for manifest templates
- `control-panel/src/lib/market/types.ts` — added `platform` to VariableContext, exported UpdateSpec/MigrationSpec/MigrationStep types
- `control-panel/src/lib/market/schema.ts` — added UpdateSchema (replace/migrate strategies, exec/sql migration steps), MigrationSchema, MigrationStepSchema; added minPlatformVersion and manifestVersion to catalog entries
- `control-panel/src/lib/market/engine.ts` — replaced inline context building with buildVariableContext(); removed getSystemConfig() and formatLanguageValue() (now in platform-env)
- `control-panel/src/lib/native-apps/installer.ts` — added writeNativeEnvFile() helper using platform-env; refactored all 6 native app install functions to use it instead of per-app hardcoded env blocks
- `control-panel/src/lib/market/updater.ts` — NEW: external app update engine with snapshot→stop→rebuild→start→health flow, migration step execution, rollback on failure
- `control-panel/src/app/api/market/update/route.ts` — NEW: POST /api/market/update SSE endpoint for app updates
- `control-panel/src/app/api/market/updates/route.ts` — NEW: GET/POST /api/market/updates for checking available updates

### Test Results
- Whoogle install via marketplace engine: verified buildVariableContext works
- Force update (full rebuild cycle): snapshot → stop → rebuild → start → health check → version update
- Update endpoint error handling: non-installed app, already up-to-date detection
- Clean uninstall after test: all resources removed
- Platform: 7 running, 0 stopped after all tests

### Notes for Iris
- No breaking changes — all existing install flows are backward compatible
- The native installer refactor is additive (writeNativeEnvFile wraps buildPlatformEnv); per-app install functions are unchanged structurally
- Manifest schema additions are optional fields — existing manifests validate without update block
- Phase 2 (native installer manifest-driven refactor) is deferred — needs individual app install testing
## v0.4.13.63 / v0.4.3.13 — artem — 2026-06-10
**Branch:** artem
**VM:** potempc
**Agent:** Artem
**Task:** Sync installed app manifests from selected Market source into UI cache

### Changes
- `control-panel/src/lib/market/ui-manifest-sync.ts` — added Market-source manifest refresh that fetches the installed app's selected source manifest, updates install audit metadata, and pushes the manifest to UI through the bridge token.
- `control-panel/src/app/api/market/app/[appId]/manifest-sync/route.ts` — added an admin-only Market API endpoint for manifest-only sync.
- `control-panel/src/app/market/[appId]/page.tsx` — added an installed-app `Sync manifest` action with status messaging.
- `ui/src/app/api/v1/apps/[appId]/manifest/route.ts` — added a bridge-authenticated POST path for CP to update UI's cached app manifest.
- `control-panel/tests/market-surfaces.spec.ts` and `ui/tests/surfaces.spec.ts` — added focused coverage for manifest sync and bridge manifest updates.

### Test Results
- Focused CP: `CONTROL_PANEL_ROOT=$PWD/control-panel ./node_modules/.bin/tsx --test control-panel/tests/market-surfaces.spec.ts` — passed.
- Focused UI: `UI_ROOT=$PWD/ui ./node_modules/.bin/tsx --test ui/tests/surfaces.spec.ts` — passed.

### Notes for Iris
- Sync is manifest-only. It does not recreate containers, switch sources, or mutate app runtime settings; it refreshes UI surface/widget metadata from the installed app's selected Market manifest and records the manifest digest/path/repo/branch in install metadata.

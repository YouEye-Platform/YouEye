# AGENTS.md — YouEye Monorepo

## v0.4.0 — sebastian — 2026-05-15
**Branch:** main (merged from sebastian)
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** v0.4.0 not-so-public beta release — merge all components to main, unified version bump

### Changes
- `spine/internal/cmd/root.go` — Version bump to 0.4.0
- `control-panel/package.json` — Version bump to 0.4.0
- `ui/package.json` — Version bump to 0.4.0
- `README.md` — Rewritten for public beta: Gitea install URLs, TUI installer docs, breaking changes warning, GitHub migration reference, "not so public beta" branding

### Releases Created
- `spine-v0.4.0` (Gitea release ID: 1540) — spine-linux-amd64, 12.7MB
- `cp-v0.4.0` (Gitea release ID: 1541) — standalone.tar, 105MB
- `ui-v0.4.0` (Gitea release ID: 1542) — standalone.tar, 204MB

### Notes for Iris
- All repos merged sebastian → main directly (bypassing dev)
- Dev branch NOT updated — left as-is per user instruction
- All 9 component releases + AppMarket/Canvas/Wiki merges done in one session

---

## v0.3.2.16 — sebastian — 2026-05-15
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Migrate YouEye-Installer TUI into Spine as `youeye installer` subcommand

### Changes
- `spine/internal/installer/theme/theme.go` — CRT-style terminal theme (Amber, Magenta, NeonGreen, etc.)
- `spine/internal/installer/snake/snake.go` — Snake game with epoch-based tick invalidation
- `spine/internal/installer/pong/pong.go` — Pong vs CPU with float64 ball physics and mouse support
- `spine/internal/installer/tetris/tetris.go` — Classic Tetris, 10x20 board, NES scoring, wall-kick
- `spine/internal/installer/twofortyeight/twofortyeight.go` — 2048 game, 4x4 grid, canonical slide
- `spine/internal/installer/types.go` — Install mode/path/config types
- `spine/internal/installer/detect.go` — Environment detection (OS, arch, Proxmox, container) with animated TUI
- `spine/internal/installer/engine.go` — Installation engine (LXC/VM/Host paths), removed self-download for host mode
- `spine/internal/installer/wizard.go` — Multi-step wizard (kept for future Proxmox support)
- `spine/internal/installer/progress.go` — Progress screen with game picker; added autoStart for bare Linux
- `spine/internal/installer/complete.go` — Success/error summary screens
- `spine/internal/installer/installer.go` — Phase orchestrator; added phaseProxmoxNotReady, autoStart on bare Linux
- `spine/internal/installer/tui.go` — Root Bubble Tea program wrapper with `Run()` entry point
- `spine/internal/cmd/installer_cmd.go` — Cobra `youeye installer` subcommand
- `spine/internal/cmd/root.go` — Version bump to 0.3.2.16
- `spine/install.sh` — Auto-launch `youeye installer` when running interactively
- `spine/go.mod` / `spine/go.sum` — Added bubbletea, lipgloss, bubbles as direct dependencies

### Test Results
- Build: compiles successfully (`go build ./cmd/youeye/`)
- No Playwright testing (TUI-only, no web UI changes)

### Notes for Iris
- All 4 games (Snake, Pong, Tetris, 2048) migrated from YouEye-Installer repo with identical visuals
- Proxmox detection now shows "not ready yet" message instead of entering wizard
- Bare Linux skips "Press Enter" confirmation, goes straight to install with games
- `engine.go` installHost() no longer downloads Spine binary (already installed by install.sh)
- Game packages kept as separate sub-packages to avoid Model type name collisions

## v0.3.2.15 — sebastian — 2026-05-15
**Branch:** sebastian
**VM:** ye-sebastian
**Agent:** Sebastian
**Task:** Add GitHub releases provider support to Spine

### Changes
- `spine/internal/releases/releases.go` — Add `buildReleasesAPIURL()` for provider-specific API URL construction; refactor `fetchReleases()` to use `http.NewRequest` with GitHub-specific headers (`Accept`, `User-Agent`) when provider is "github"
- `spine/internal/releases/releases_test.go` — Add tests for `buildReleasesAPIURL` (both providers), GitHub download URLs, header validation, tag prefix filtering with component prefixes
- `spine/install.sh` — Add `--provider` flag, configurable `RELEASE_BASE_URL`/`RELEASE_ORG`/`RELEASE_REPO` env vars; persist provider to `/etc/youeye/config.yaml` on install when using GitHub
- `spine/internal/cmd/root.go` — Bump version to 0.3.2.15

### Test Results
- Go tests: 20 passed, 0 failed (`go test ./internal/releases/ -v`)
- Live GitHub API format verified (neovim/neovim as test target)

### Notes for Iris
- Gitea defaults unchanged — zero breaking changes for existing installs
- The `Provider` config field already existed in config.go but was never read by fetchReleases; now it is
- install.sh now accepts `--provider github` but defaults to gitea

# AGENTS.md — YouEye Monorepo

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

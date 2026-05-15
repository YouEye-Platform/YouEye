// Package releases provides shared release-fetching logic for YouEye.
// Used by both the deploy path (container/) and update path (cmd/) to ensure
// consistent branch-aware release selection across all Spine operations.
//
// Supports both Gitea and GitHub as release providers, controlled by the
// releases.provider config field ("gitea" or "github"). The JSON response
// format is compatible (tag_name, assets[].name, assets[].browser_download_url)
// and the download URL format is identical for both providers.
//
// In the YouEye monorepo, Spine, Control Panel, and UI all publish releases
// to the same repo ("YouEye") with component-prefixed tags:
//
//	spine-v0.2.21, cp-v0.2.21, ui-v0.2.21
//	spine-dev-v0.2.21.1, cp-dev-v0.2.21.1
//
// The tagPrefix parameter in all public functions filters releases to a
// specific component. When tagPrefix is empty, functions behave as before
// (no prefix stripping — backwards compatible with single-repo setups).
package releases

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/YouEye-Platform/YouEye/spine/internal/config"
	"github.com/YouEye-Platform/YouEye/spine/internal/version"
	"gopkg.in/yaml.v3"
)

// NewIPv4Client returns an HTTP client that forces IPv4 connections.
// On fresh VMs without IPv6 routes, Go's default dialer tries AAAA records
// first and hangs until timeout. Forcing tcp4 avoids this entirely.
func NewIPv4Client(timeout time.Duration) *http.Client {
	dialer := &net.Dialer{
		Timeout:   10 * time.Second,
		KeepAlive: 30 * time.Second,
	}
	return &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
				return dialer.DialContext(ctx, "tcp4", addr)
			},
			TLSClientConfig:     &tls.Config{},
			TLSHandshakeTimeout: 10 * time.Second,
			MaxIdleConns:        10,
			IdleConnTimeout:     30 * time.Second,
		},
	}
}

// YouEyeConfigPath is the path to the runtime youeye.yaml config file.
const YouEyeConfigPath = "/var/lib/youeye/config/youeye.yaml"

// youeyeConfig is a minimal struct for reading release_branch from youeye.yaml.
type youeyeConfig struct {
	ReleaseBranch string `yaml:"release_branch"`
}

// ReadReleaseBranch reads the release_branch from youeye.yaml.
// Returns empty string if not set or file doesn't exist (meaning "main").
func ReadReleaseBranch() string {
	data, err := os.ReadFile(YouEyeConfigPath)
	if err != nil {
		return ""
	}
	var cfg youeyeConfig
	if yaml.Unmarshal(data, &cfg) != nil {
		return ""
	}
	return cfg.ReleaseBranch
}

// stripTagPrefix removes the component prefix from a tag.
// "spine-v0.2.21" with prefix "spine" → "v0.2.21", true
// "spine-dev-v0.2.21.1" with prefix "spine" → "dev-v0.2.21.1", true
// "cp-v0.2.21" with prefix "spine" → "", false (wrong component)
// When prefix is empty, returns the tag unchanged (backwards compat).
func stripTagPrefix(tag, prefix string) (string, bool) {
	if prefix == "" {
		return tag, true
	}
	p := prefix + "-"
	if strings.HasPrefix(tag, p) {
		return strings.TrimPrefix(tag, p), true
	}
	return "", false
}

// IsMainTag returns true if the tag is a main release (e.g., "v0.1.50").
// Operates on a tag that has already had its component prefix stripped.
func IsMainTag(tag string) bool {
	return len(tag) >= 2 && tag[0] == 'v' && tag[1] >= '0' && tag[1] <= '9'
}

// IsBranchTag returns true if the tag belongs to a specific branch (e.g., "john-v0.1.50").
// Operates on a tag that has already had its component prefix stripped.
func IsBranchTag(tag, branch string) bool {
	return strings.HasPrefix(tag, branch+"-v")
}

// ExtractVersion extracts the version number from a tag.
// Handles both main tags ("v0.1.50" → "0.1.50") and branch tags ("john-v0.1.50" → "0.1.50").
// Operates on a tag that has already had its component prefix stripped.
func ExtractVersion(tag, branch string) string {
	if branch != "" && branch != "main" {
		prefix := branch + "-v"
		if strings.HasPrefix(tag, prefix) {
			return strings.TrimPrefix(tag, prefix)
		}
	}
	return strings.TrimPrefix(tag, "v")
}

// BuildTag builds the full tag name for a version, branch, and component prefix.
// Examples:
//
//	BuildTag("0.2.21", "main", "spine")  → "spine-v0.2.21"
//	BuildTag("0.2.21.1", "dev", "cp")   → "cp-dev-v0.2.21.1"
//	BuildTag("0.2.21", "", "")           → "v0.2.21"  (backwards compat)
func BuildTag(ver, branch, tagPrefix string) string {
	var tag string
	if branch == "" || branch == "main" {
		tag = "v" + ver
	} else {
		tag = branch + "-v" + ver
	}
	if tagPrefix != "" {
		return tagPrefix + "-" + tag
	}
	return tag
}

// BuildDownloadURL constructs the direct download URL for a release asset.
// The URL format is identical for Gitea and GitHub:
//
//	{BaseURL}/{org}/{repo}/releases/download/{tag}/{asset}
func BuildDownloadURL(cfg *config.Config, repo, tag, assetName string) string {
	return fmt.Sprintf("%s/%s/%s/releases/download/%s/%s",
		cfg.Releases.BaseURL,
		cfg.Releases.Organization,
		repo,
		tag,
		assetName)
}

// buildReleasesAPIURL constructs the API URL for fetching releases based on provider.
// Gitea:  {BaseURL}/api/v1/repos/{org}/{repo}/releases?limit=50
// GitHub: https://api.github.com/repos/{org}/{repo}/releases?per_page=50
func buildReleasesAPIURL(cfg *config.Config, repo string) string {
	if cfg.Releases.Provider == "github" {
		return fmt.Sprintf("https://api.github.com/repos/%s/%s/releases?per_page=50",
			cfg.Releases.Organization, repo)
	}
	return fmt.Sprintf("%s%s/repos/%s/%s/releases?limit=50",
		cfg.Releases.BaseURL,
		cfg.Releases.APIPath,
		cfg.Releases.Organization,
		repo)
}

// fetchReleases fetches releases from the configured provider's API.
// Supports both Gitea and GitHub providers. Retries up to 3 times with
// backoff on network errors. Uses IPv4-only client to avoid IPv6 hangs
// on fresh VMs without IPv6 routes.
func fetchReleases(cfg *config.Config, repo string) ([]Release, error) {
	client := NewIPv4Client(30 * time.Second)

	apiURL := buildReleasesAPIURL(cfg, repo)

	var lastErr error
	for attempt := 1; attempt <= 3; attempt++ {
		req, err := http.NewRequest("GET", apiURL, nil)
		if err != nil {
			return nil, fmt.Errorf("failed to create request: %w", err)
		}

		// GitHub API requires Accept and User-Agent headers
		if cfg.Releases.Provider == "github" {
			req.Header.Set("Accept", "application/vnd.github+json")
			req.Header.Set("User-Agent", "youeye-spine")
		}

		resp, err := client.Do(req)
		if err != nil {
			lastErr = err
			if attempt < 3 {
				time.Sleep(time.Duration(attempt*2) * time.Second)
				continue
			}
			return nil, fmt.Errorf("failed to fetch releases after %d attempts: %w", attempt, lastErr)
		}
		defer resp.Body.Close()

		if resp.StatusCode != 200 {
			return nil, fmt.Errorf("releases API returned status: %d", resp.StatusCode)
		}

		var rels []Release
		if err := json.NewDecoder(resp.Body).Decode(&rels); err != nil {
			return nil, fmt.Errorf("failed to decode releases: %w", err)
		}

		return rels, nil
	}

	return nil, fmt.Errorf("failed to fetch releases: %w", lastErr)
}

// GetLatestVersionForBranch fetches all releases and returns the highest version
// matching the given branch and component tag prefix. Falls back to main releases
// if no branch-specific releases exist. Returns "unknown" on failure.
//
// tagPrefix filters releases to a specific component (e.g. "spine", "cp", "ui").
// When empty, no prefix filtering is applied (backwards compatible).
func GetLatestVersionForBranch(cfg *config.Config, repo, branch, tagPrefix string) string {
	rels, err := fetchReleases(cfg, repo)
	if err != nil || len(rels) == 0 {
		return "unknown"
	}

	// If no branch or "main", find the highest main release version
	if branch == "" || branch == "main" {
		var mainVersions []string
		for _, r := range rels {
			stripped, ok := stripTagPrefix(r.TagName, tagPrefix)
			if !ok {
				continue
			}
			if IsMainTag(stripped) {
				mainVersions = append(mainVersions, strings.TrimPrefix(stripped, "v"))
			}
		}
		if len(mainVersions) > 0 {
			version.SortVersionsDesc(mainVersions)
			return mainVersions[0]
		}
		return "unknown"
	}

	// Collect branch-specific and main releases
	branchPrefix := branch + "-v"
	var branchVersions []string
	var mainVersions []string
	for _, r := range rels {
		stripped, ok := stripTagPrefix(r.TagName, tagPrefix)
		if !ok {
			continue
		}
		if strings.HasPrefix(stripped, branchPrefix) {
			branchVersions = append(branchVersions, strings.TrimPrefix(stripped, branchPrefix))
		} else if IsMainTag(stripped) {
			mainVersions = append(mainVersions, strings.TrimPrefix(stripped, "v"))
		}
	}

	// Find highest of each
	var bestBranch, bestMain string
	if len(branchVersions) > 0 {
		version.SortVersionsDesc(branchVersions)
		bestBranch = branchVersions[0]
	}
	if len(mainVersions) > 0 {
		version.SortVersionsDesc(mainVersions)
		bestMain = mainVersions[0]
	}

	// Compare branch winner vs main winner — use whichever is newer
	if bestBranch != "" && bestMain != "" {
		if version.CompareVersions(bestBranch, bestMain) >= 0 {
			return bestBranch
		}
		return bestMain
	}
	if bestBranch != "" {
		return bestBranch
	}
	if bestMain != "" {
		return bestMain
	}

	return "unknown"
}

// GetLatestTagForBranch returns the full release tag (e.g. "spine-v0.2.12" or
// "spine-dev-v0.2.12.1") for the highest matching release on the given branch,
// with fallback to main. Returns ("", "") on failure.
//
// The second return value indicates which branch was actually used ("main" or
// the requested branch), so callers can log the fallback.
//
// tagPrefix filters releases to a specific component (e.g. "spine", "cp", "ui").
func GetLatestTagForBranch(cfg *config.Config, repo, branch, tagPrefix string) (tag string, effectiveBranch string) {
	rels, err := fetchReleases(cfg, repo)
	if err != nil || len(rels) == 0 {
		return "", ""
	}

	type taggedRelease struct {
		ver     string // version number only (e.g. "0.2.21")
		fullTag string // original full tag (e.g. "spine-v0.2.21")
	}

	// No branch or "main" — find highest main release
	if branch == "" || branch == "main" {
		var mainCandidates []taggedRelease
		for _, r := range rels {
			stripped, ok := stripTagPrefix(r.TagName, tagPrefix)
			if !ok {
				continue
			}
			if IsMainTag(stripped) {
				mainCandidates = append(mainCandidates, taggedRelease{
					ver:     strings.TrimPrefix(stripped, "v"),
					fullTag: r.TagName,
				})
			}
		}
		if len(mainCandidates) > 0 {
			best := mainCandidates[0]
			for _, c := range mainCandidates[1:] {
				if version.CompareVersions(c.ver, best.ver) > 0 {
					best = c
				}
			}
			return best.fullTag, "main"
		}
		return "", ""
	}

	// Branch set — collect branch-specific and main releases
	branchPrefix := branch + "-v"
	var branchCandidates []taggedRelease
	var mainCandidates []taggedRelease
	for _, r := range rels {
		stripped, ok := stripTagPrefix(r.TagName, tagPrefix)
		if !ok {
			continue
		}
		if strings.HasPrefix(stripped, branchPrefix) {
			branchCandidates = append(branchCandidates, taggedRelease{
				ver:     strings.TrimPrefix(stripped, branchPrefix),
				fullTag: r.TagName,
			})
		} else if IsMainTag(stripped) {
			mainCandidates = append(mainCandidates, taggedRelease{
				ver:     strings.TrimPrefix(stripped, "v"),
				fullTag: r.TagName,
			})
		}
	}

	bestOf := func(candidates []taggedRelease) taggedRelease {
		if len(candidates) == 0 {
			return taggedRelease{}
		}
		best := candidates[0]
		for _, c := range candidates[1:] {
			if version.CompareVersions(c.ver, best.ver) > 0 {
				best = c
			}
		}
		return best
	}

	bestBranch := bestOf(branchCandidates)
	bestMain := bestOf(mainCandidates)

	// Compare branch winner vs main winner — use whichever is newer
	if bestBranch.fullTag != "" && bestMain.fullTag != "" {
		if version.CompareVersions(bestBranch.ver, bestMain.ver) >= 0 {
			return bestBranch.fullTag, branch
		}
		return bestMain.fullTag, "main"
	}
	if bestBranch.fullTag != "" {
		return bestBranch.fullTag, branch
	}
	if bestMain.fullTag != "" {
		return bestMain.fullTag, "main"
	}

	return "", ""
}

// ExtractVersionFromFullTag extracts the version number from a full tag
// that may include a component prefix and branch.
// Examples:
//
//	ExtractVersionFromFullTag("spine-v0.2.21", "main", "spine")     → "0.2.21"
//	ExtractVersionFromFullTag("spine-dev-v0.2.21.1", "dev", "spine") → "0.2.21.1"
//	ExtractVersionFromFullTag("v0.2.21", "main", "")                → "0.2.21"
func ExtractVersionFromFullTag(fullTag, effectiveBranch, tagPrefix string) string {
	stripped, ok := stripTagPrefix(fullTag, tagPrefix)
	if !ok {
		stripped = fullTag
	}
	return ExtractVersion(stripped, effectiveBranch)
}

// GetAssetURLForBranch reads the release branch from youeye.yaml, finds the
// latest matching release, and returns the download URL for the named asset.
// This is the primary entry point for branch-aware asset downloads.
//
// tagPrefix filters releases to a specific component (e.g. "spine", "cp", "ui").
func GetAssetURLForBranch(cfg *config.Config, repo, assetName, tagPrefix string) (string, error) {
	branch := ReadReleaseBranch()

	rels, err := fetchReleases(cfg, repo)
	if err != nil {
		return "", err
	}
	if len(rels) == 0 {
		return "", fmt.Errorf("no releases found")
	}

	// Find the best matching release based on branch
	type taggedRelease struct {
		ver   string
		index int
	}

	var matched *Release
	if branch != "" && branch != "main" {
		// Collect branch-specific and main releases
		var branchCandidates []taggedRelease
		var mainCandidates []taggedRelease
		branchPrefix := branch + "-v"
		for i, r := range rels {
			stripped, ok := stripTagPrefix(r.TagName, tagPrefix)
			if !ok {
				continue
			}
			if strings.HasPrefix(stripped, branchPrefix) {
				branchCandidates = append(branchCandidates, taggedRelease{
					ver:   strings.TrimPrefix(stripped, branchPrefix),
					index: i,
				})
			} else if IsMainTag(stripped) {
				mainCandidates = append(mainCandidates, taggedRelease{
					ver:   strings.TrimPrefix(stripped, "v"),
					index: i,
				})
			}
		}

		// Sort both by version descending
		sortTagged := func(c []taggedRelease) {
			for i := 1; i < len(c); i++ {
				for j := i; j > 0 && version.CompareVersions(c[j].ver, c[j-1].ver) > 0; j-- {
					c[j], c[j-1] = c[j-1], c[j]
				}
			}
		}
		sortTagged(branchCandidates)
		sortTagged(mainCandidates)

		// Compare branch winner vs main winner — use whichever is newer
		if len(branchCandidates) > 0 && len(mainCandidates) > 0 {
			if version.CompareVersions(branchCandidates[0].ver, mainCandidates[0].ver) >= 0 {
				matched = &rels[branchCandidates[0].index]
			} else {
				matched = &rels[mainCandidates[0].index]
			}
		} else if len(branchCandidates) > 0 {
			matched = &rels[branchCandidates[0].index]
		} else if len(mainCandidates) > 0 {
			matched = &rels[mainCandidates[0].index]
		}
	}

	// No branch set or no candidates found — use highest main release
	if matched == nil {
		var mainCandidates []taggedRelease
		for i, r := range rels {
			stripped, ok := stripTagPrefix(r.TagName, tagPrefix)
			if !ok {
				continue
			}
			if IsMainTag(stripped) {
				mainCandidates = append(mainCandidates, taggedRelease{
					ver:   strings.TrimPrefix(stripped, "v"),
					index: i,
				})
			}
		}
		if len(mainCandidates) > 0 {
			for i := 1; i < len(mainCandidates); i++ {
				for j := i; j > 0 && version.CompareVersions(mainCandidates[j].ver, mainCandidates[j-1].ver) > 0; j-- {
					mainCandidates[j], mainCandidates[j-1] = mainCandidates[j-1], mainCandidates[j]
				}
			}
			matched = &rels[mainCandidates[0].index]
		}
	}

	// Last resort: first release with correct prefix
	if matched == nil {
		for i, r := range rels {
			if _, ok := stripTagPrefix(r.TagName, tagPrefix); ok {
				matched = &rels[i]
				break
			}
		}
	}

	if matched == nil {
		return "", fmt.Errorf("no releases found matching prefix %q", tagPrefix)
	}

	// Find the requested asset
	asset := matched.FindAsset(assetName)
	if asset != nil {
		return asset.BrowserDownloadURL, nil
	}

	return "", fmt.Errorf("asset %s not found in release %s", assetName, matched.TagName)
}

// Package releases provides shared release-fetching logic for YouEye.
// Used by both the deploy path (container/) and update path (cmd/) to ensure
// consistent branch-aware release selection across all Spine operations.
//
// Supports both forge-compatible and GitHub release repositories, derived from the
// releases.repo_url config field. The JSON response format is compatible
// (tag_name, assets[].name, assets[].browser_download_url) and the download URL
// format is identical for both providers.
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
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/youeye-platform/YouEye/spine/internal/channels"
	"github.com/youeye-platform/YouEye/spine/internal/config"
	"gopkg.in/yaml.v3"
)

const (
	githubReleasePageSize = 100
	forgeReleasePageSize  = 50
	maxReleasePages       = 200
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
// The URL format is identical for forge-compatible and GitHub release APIs:
//
//	{BaseURL}/{org}/{repo}/releases/download/{tag}/{asset}
func BuildDownloadURL(cfg *config.Config, repo, tag, assetName string) string {
	source := cfg.CoreReleaseRepo()
	if cfg.Releases.RepoURL != "" || repo == "" {
		repo = source.Repository
	}
	return buildDownloadURLFromSource(source, repo, tag, assetName)
}

// buildDownloadURLFromSource builds a release asset download URL against an
// explicit source repo (channel-aware). When repo is empty the source's own
// repository name is used.
func buildDownloadURLFromSource(source config.ReleaseRepo, repo, tag, assetName string) string {
	if repo == "" {
		repo = source.Repository
	}
	return fmt.Sprintf("%s/%s/%s/releases/download/%s/%s",
		source.BaseURL,
		source.Organization,
		repo,
		tag,
		assetName)
}

// buildReleasesAPIURL constructs the API URL for fetching releases based on provider.
// Forge-compatible: {BaseURL}/api/v1/repos/{org}/{repo}/releases?limit=50
// GitHub: https://api.github.com/repos/{org}/{repo}/releases?per_page=100
func buildReleasesAPIURL(cfg *config.Config, repo string) string {
	source := cfg.CoreReleaseRepo()
	if cfg.Releases.RepoURL != "" || repo == "" {
		repo = source.Repository
	}
	return buildReleasesAPIURLFromSource(source, repo)
}

// buildReleasesAPIURLFromSource is the source-explicit variant used by the
// channel-aware resolver. When repo is empty the source's repository is used.
func buildReleasesAPIURLFromSource(source config.ReleaseRepo, repo string) string {
	if repo == "" {
		repo = source.Repository
	}
	if source.Provider == "github" {
		return fmt.Sprintf("https://api.github.com/repos/%s/%s/releases?per_page=%d",
			source.Organization, repo, githubReleasePageSize)
	}
	return fmt.Sprintf("%s%s/repos/%s/%s/releases?limit=%d",
		source.BaseURL,
		source.APIPath,
		source.Organization,
		repo,
		forgeReleasePageSize)
}

// fetchReleases fetches releases from the configured provider's API.
// Supports both forge-compatible and GitHub providers. Retries up to 3 times with
// backoff on network errors. Uses IPv4-only client to avoid IPv6 hangs
// on fresh VMs without IPv6 routes.
func fetchReleases(cfg *config.Config, repo string) ([]Release, error) {
	return fetchReleasesFromSource(cfg, cfg.CoreReleaseRepo(), repo)
}

// fetchReleasesFromSource fetches releases from an explicit source repo,
// generalizing fetchReleases for channel-aware resolution. Provider is
// auto-detected from the source (github vs forge), like config does.
func fetchReleasesFromSource(_ *config.Config, source config.ReleaseRepo, repo string) ([]Release, error) {
	client := NewIPv4Client(30 * time.Second)
	baseURL, err := url.Parse(buildReleasesAPIURLFromSource(source, repo))
	if err != nil {
		return nil, fmt.Errorf("failed to parse releases API URL: %w", err)
	}
	pageSize := forgeReleasePageSize
	if source.Provider == "github" {
		pageSize = githubReleasePageSize
	}

	var releases []Release
	seenTags := make(map[string]struct{})
	for page := 1; page <= maxReleasePages; page++ {
		pageURL := *baseURL
		query := pageURL.Query()
		query.Set("page", fmt.Sprint(page))
		pageURL.RawQuery = query.Encode()
		pageReleases, err := fetchReleasePage(client, source, pageURL.String(), page)
		if err != nil {
			return nil, err
		}
		for _, release := range pageReleases {
			if _, exists := seenTags[release.TagName]; exists {
				return nil, fmt.Errorf("releases API returned duplicate tag %q", release.TagName)
			}
			seenTags[release.TagName] = struct{}{}
			releases = append(releases, release)
		}
		if len(pageReleases) < pageSize {
			return releases, nil
		}
		if page == maxReleasePages {
			return nil, fmt.Errorf("release discovery exceeded %d pages; configure an exact tag", maxReleasePages)
		}
	}
	return nil, fmt.Errorf("release discovery did not terminate")
}

func fetchReleasePage(client *http.Client, source config.ReleaseRepo, apiURL string, page int) ([]Release, error) {
	var lastErr error
	for attempt := 1; attempt <= 3; attempt++ {
		req, err := http.NewRequest(http.MethodGet, apiURL, nil)
		if err != nil {
			return nil, fmt.Errorf("failed to create releases page %d request: %w", page, err)
		}
		if source.Provider == "github" {
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
			return nil, fmt.Errorf("failed to fetch releases page %d after %d attempts: %w", page, attempt, lastErr)
		}
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			return nil, fmt.Errorf("releases API page %d returned status: %d", page, resp.StatusCode)
		}
		var releases []Release
		decodeErr := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&releases)
		closeErr := resp.Body.Close()
		if decodeErr != nil {
			return nil, fmt.Errorf("failed to decode releases page %d: %w", page, decodeErr)
		}
		if closeErr != nil {
			return nil, fmt.Errorf("failed to close releases page %d: %w", page, closeErr)
		}
		return releases, nil
	}
	return nil, fmt.Errorf("failed to fetch releases page %d: %w", page, lastErr)
}

// legacyChannel builds the channel that reproduces the historical
// [branch, main] union/newest-wins behavior for a bare branch name. When branch
// is empty or "main", the fallback would duplicate the own branch and is
// deduped by the resolver.
func legacyChannel(branch string) channels.Channel {
	if branch == "" {
		branch = "main"
	}
	return channels.Channel{Branch: branch, Fallback: []string{"main"}}
}

// GetLatestVersionForBranch fetches all releases and returns the highest version
// matching the given branch and component tag prefix. Falls back to main releases
// if no branch-specific releases exist. Returns "unknown" on failure.
//
// Retained as a thin shim over the channel-aware resolver so existing callers
// keep working; the default-channel behavior is identical to before.
func GetLatestVersionForBranch(cfg *config.Config, repo, branch, tagPrefix string) string {
	cand, err := resolveWithChannel(cfg, legacyChannel(branch), repo, tagPrefix)
	if err != nil {
		return "unknown"
	}
	return cand.Version
}

// GetAssetURLForBranch reads the release branch from youeye.yaml, finds the
// latest matching release, and returns the download URL for the named asset.
// This is the primary entry point for branch-aware asset downloads.
//
// Retained as a thin shim over the channel-aware resolver. It reads the default
// channel branch (mirrored from youeye.yaml) to preserve today's behavior.
func GetAssetURLForBranch(cfg *config.Config, repo, assetName, tagPrefix string) (string, error) {
	branch := ReadReleaseBranch()
	return AssetURLForChannel(cfg, legacyChannel(branch), repo, assetName, tagPrefix)
}

// AssetURLForChannel resolves the newest release for a given channel and
// returns the download URL for the named asset. When the release list carries
// a matching asset entry (browser_download_url) it is used verbatim; otherwise
// the URL is constructed from the resolved source + tag, so downloads work even
// when the API omits per-asset URLs.
func AssetURLForChannel(cfg *config.Config, eff channels.Channel, repo, assetName, tagPrefix string) (string, error) {
	src := resolveSource(cfg, eff.Source)
	rels, err := fetchReleasesFromSource(cfg, src, repo)
	if err != nil {
		return "", err
	}
	if len(rels) == 0 {
		return "", fmt.Errorf("no releases found")
	}

	cand, err := resolveWithChannel(cfg, eff, repo, tagPrefix)
	if err != nil {
		return "", err
	}

	for i := range rels {
		if rels[i].TagName != cand.Tag {
			continue
		}
		if asset := rels[i].FindAsset(assetName); asset != nil && asset.BrowserDownloadURL != "" {
			return asset.BrowserDownloadURL, nil
		}
		break
	}
	return buildDownloadURLFromSource(src, repo, cand.Tag, assetName), nil
}

// VerifyFileSHA256 checks a downloaded release artifact before it is used.
// An empty expected digest keeps the legacy unpinned channel behaviour.
func VerifyFileSHA256(path, expected string) error {
	if strings.TrimSpace(expected) == "" {
		return nil
	}
	want, err := hex.DecodeString(strings.TrimSpace(expected))
	if err != nil || len(want) != sha256.Size {
		return fmt.Errorf("invalid expected SHA-256 digest")
	}
	f, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open release artifact for digest verification: %w", err)
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return fmt.Errorf("hash release artifact: %w", err)
	}
	if !bytes.Equal(h.Sum(nil), want) {
		return fmt.Errorf("release artifact SHA-256 mismatch")
	}
	return nil
}

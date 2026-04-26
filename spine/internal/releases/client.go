// Package releases provides a client for fetching release information.
package releases

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"git.byka.wtf/potemsla/YouEye/spine/internal/config"
)

// Release represents a software release.
type Release struct {
	TagName string  `json:"tag_name"`
	Version string  // Parsed version without 'v' prefix
	Assets  []Asset `json:"assets"`
}

// Asset represents a release asset (downloadable file).
type Asset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
	Size               int64  `json:"size"`
}

// Client handles fetching release information from a release source.
type Client struct {
	cfg        *config.Config
	httpClient *http.Client
}

// NewClient creates a new releases client.
func NewClient(cfg *config.Config) *Client {
	return &Client{
		cfg:        cfg,
		httpClient: NewIPv4Client(30 * time.Second),
	}
}

// GetLatestRelease fetches the latest release for a repository.
func (c *Client) GetLatestRelease(repo string) (*Release, error) {
	releases, err := c.GetReleases(repo, 1)
	if err != nil {
		return nil, err
	}
	if len(releases) == 0 {
		return nil, fmt.Errorf("no releases found for %s", repo)
	}
	return &releases[0], nil
}

// GetReleases fetches releases for a repository, limited to maxResults.
func (c *Client) GetReleases(repo string, maxResults int) ([]Release, error) {
	apiURL := fmt.Sprintf("%s%s/repos/%s/%s/releases",
		c.cfg.Releases.BaseURL,
		c.cfg.Releases.APIPath,
		c.cfg.Releases.Organization,
		repo)

	resp, err := c.httpClient.Get(apiURL)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch releases: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("releases API returned status: %d", resp.StatusCode)
	}

	var releases []Release
	if err := json.NewDecoder(resp.Body).Decode(&releases); err != nil {
		return nil, fmt.Errorf("failed to decode releases: %w", err)
	}

	// Parse versions
	for i := range releases {
		releases[i].Version = strings.TrimPrefix(releases[i].TagName, "v")
	}

	// Limit results
	if maxResults > 0 && len(releases) > maxResults {
		releases = releases[:maxResults]
	}

	return releases, nil
}

// GetLatestVersion returns just the version string for the latest release.
func (c *Client) GetLatestVersion(repo string) (string, error) {
	release, err := c.GetLatestRelease(repo)
	if err != nil {
		return "", err
	}
	return release.Version, nil
}

// GetSpineLatestVersion returns the latest Spine version.
func (c *Client) GetSpineLatestVersion() (string, error) {
	return c.GetLatestVersion(c.cfg.Releases.Repositories.Spine)
}

// GetControlPanelLatestVersion returns the latest Control Panel version.
func (c *Client) GetControlPanelLatestVersion() (string, error) {
	return c.GetLatestVersion(c.cfg.Releases.Repositories.ControlPanel)
}

// GetSpineDownloadURL returns the download URL for a specific Spine version and architecture.
func (c *Client) GetSpineDownloadURL(version, arch string) string {
	return fmt.Sprintf("%s/%s/%s/releases/download/v%s/spine-linux-%s",
		c.cfg.Releases.BaseURL,
		c.cfg.Releases.Organization,
		c.cfg.Releases.Repositories.Spine,
		version,
		arch)
}

// GetControlPanelDownloadURL returns the download URL for the Control Panel standalone tarball.
func (c *Client) GetControlPanelDownloadURL(version string) string {
	return fmt.Sprintf("%s/%s/%s/releases/download/v%s/standalone.tar",
		c.cfg.Releases.BaseURL,
		c.cfg.Releases.Organization,
		c.cfg.Releases.Repositories.ControlPanel,
		version)
}

// FindAsset finds an asset by name in a release.
func (r *Release) FindAsset(name string) *Asset {
	for i := range r.Assets {
		if r.Assets[i].Name == name {
			return &r.Assets[i]
		}
	}
	return nil
}

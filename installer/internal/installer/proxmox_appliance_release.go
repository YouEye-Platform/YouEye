package installer

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/youeye-platform/YouEye/releasecache"
)

const (
	applianceISOFilename        = "youeye-appliance-amd64.iso"
	applianceManifestFilename   = "appliance-manifest.json"
	coreReleaseFilename         = "core-release.json"
	applianceGitHubPageSize     = 100
	applianceCompatiblePageSize = 50
	applianceReleaseMaxPages    = 200
)

type applianceReleaseAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
	Size               int64  `json:"size"`
}

type applianceRelease struct {
	core        *releasecache.CoreRelease
	coreRaw     []byte
	coreSHA256  string
	TagName     string                  `json:"tag_name"`
	Draft       bool                    `json:"draft"`
	Prerelease  bool                    `json:"prerelease"`
	PublishedAt time.Time               `json:"published_at"`
	Assets      []applianceReleaseAsset `json:"assets"`
}

type verifiedApplianceRelease struct {
	Release      applianceRelease
	Manifest     applianceBundleManifest
	ManifestSHA  string
	ISOSHA       string
	ISOPath      string
	ManifestPath string
}

// resolveApplianceRelease lists the repository's releases and accepts exactly
// one core-release.json. Channel rules (shared with install.sh):
//   - stable: newest non-prerelease youeye-v tag whose document names branch main
//   - development: newest prerelease youeye-v tag containing "-dev." on branch dev
//   - branch:<name>: newest youeye-v tag whose document names that branch
//   - exact: the given youeye-v tag
//
// Integrity comes from HTTPS and the document digest; every artifact named by
// the document is later checked by sha256 and size.
func resolveApplianceRelease(ctx context.Context, client *http.Client, provider, apiURL, channel, exactTag string) (applianceRelease, error) {
	provider, baseURL, err := normalizeApplianceReleaseSource(provider, apiURL)
	if err != nil {
		return applianceRelease{}, err
	}
	source, err := coreAnswerSource(applianceReleasePolicy{Provider: provider, ReleasesAPI: baseURL.String()})
	if err != nil {
		return applianceRelease{}, err
	}
	channel = strings.TrimSpace(channel)
	branch := ""
	switch {
	case channel == "stable":
		branch = "main"
	case channel == "dev" || channel == "development":
		channel, branch = "development", "dev"
	case strings.HasPrefix(channel, "branch:"):
		branch = strings.TrimPrefix(channel, "branch:")
		if !validApplianceReleaseBranch(branch) {
			return applianceRelease{}, fmt.Errorf("branch-associated release track is invalid")
		}
		channel = "branch"
	case channel == "exact":
		if !validCoreTag(exactTag) {
			return applianceRelease{}, fmt.Errorf("exact selection requires a youeye-v release tag")
		}
	default:
		return applianceRelease{}, fmt.Errorf("unsupported release channel %q", channel)
	}
	releases, err := listApplianceReleases(ctx, client, provider, baseURL)
	if err != nil {
		return applianceRelease{}, err
	}
	var candidates []applianceRelease
	for _, release := range releases {
		if release.Draft || !validCoreTag(release.TagName) {
			continue
		}
		switch channel {
		case "stable":
			if release.Prerelease {
				continue
			}
		case "development":
			if !release.Prerelease || !strings.Contains(release.TagName, "-dev.") {
				continue
			}
		case "exact":
			if release.TagName != exactTag {
				continue
			}
		}
		candidates = append(candidates, release)
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		if c := compareCoreTags(candidates[i].TagName, candidates[j].TagName); c != 0 {
			return c > 0
		}
		return candidates[i].PublishedAt.After(candidates[j].PublishedAt)
	})
	for _, candidate := range candidates {
		asset, err := findApplianceReleaseAsset(candidate, coreReleaseFilename)
		if err != nil {
			if channel == "exact" {
				return applianceRelease{}, err
			}
			continue
		}
		if err := validateApplianceReleaseAssetURL(provider, baseURL, candidate.TagName, asset.Name, asset.BrowserDownloadURL); err != nil {
			return applianceRelease{}, err
		}
		raw, err := readCoreAsset(ctx, client, asset, 1<<20)
		if err != nil {
			return applianceRelease{}, err
		}
		manifest, digest, err := releasecache.ParseCoreRelease(raw)
		if err != nil {
			return applianceRelease{}, fmt.Errorf("release %s: %w", candidate.TagName, err)
		}
		if manifest.Source != source || manifest.Tag != candidate.TagName {
			return applianceRelease{}, fmt.Errorf("core release document differs from selected source/tag")
		}
		if branch != "" && manifest.Branch != branch {
			continue
		}
		candidate.core, candidate.coreRaw, candidate.coreSHA256 = &manifest, raw, digest
		return candidate, nil
	}
	if channel == "exact" {
		return applianceRelease{}, fmt.Errorf("exact release %q was not found", exactTag)
	}
	if channel == "branch" {
		return applianceRelease{}, fmt.Errorf("no release was found for branch track %q", branch)
	}
	return applianceRelease{}, fmt.Errorf("no %s release was found", channel)
}

func listApplianceReleases(ctx context.Context, client *http.Client, provider string, baseURL *url.URL) ([]applianceRelease, error) {
	pageSize := applianceCompatiblePageSize
	pageSizeKey := "limit"
	if provider == defaultApplianceProvider {
		pageSize = applianceGitHubPageSize
		pageSizeKey = "per_page"
	}
	var releases []applianceRelease
	seenTags := make(map[string]struct{})
	for page := 1; page <= applianceReleaseMaxPages; page++ {
		pageURL := *baseURL
		query := pageURL.Query()
		query.Del("limit")
		query.Del("per_page")
		query.Del("page")
		query.Set(pageSizeKey, fmt.Sprint(pageSize))
		query.Set("page", fmt.Sprint(page))
		pageURL.RawQuery = query.Encode()
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, pageURL.String(), nil)
		if err != nil {
			return nil, fmt.Errorf("create releases request: %w", err)
		}
		if provider == defaultApplianceProvider {
			req.Header.Set("Accept", "application/vnd.github+json")
			req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
		} else {
			req.Header.Set("Accept", "application/json")
		}
		req.Header.Set("User-Agent", "youeye-installer/"+InstallerVersion)
		resp, err := client.Do(req)
		if err != nil {
			return nil, fmt.Errorf("query releases page %d: %w", page, err)
		}
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			return nil, fmt.Errorf("releases API page %d returned %s", page, resp.Status)
		}
		var releasePage []applianceRelease
		decodeErr := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&releasePage)
		closeErr := resp.Body.Close()
		if decodeErr != nil {
			return nil, fmt.Errorf("decode releases page %d: %w", page, decodeErr)
		}
		if closeErr != nil {
			return nil, fmt.Errorf("close releases page %d: %w", page, closeErr)
		}
		if len(releasePage) == 0 {
			return releases, nil
		}
		for _, release := range releasePage {
			if _, exists := seenTags[release.TagName]; exists {
				return nil, fmt.Errorf("releases API returned duplicate tag %q", release.TagName)
			}
			seenTags[release.TagName] = struct{}{}
			releases = append(releases, release)
		}
	}
	return nil, fmt.Errorf("release discovery exceeded %d pages; select an exact tag", applianceReleaseMaxPages)
}

func normalizeApplianceReleaseSource(provider, raw string) (string, *url.URL, error) {
	provider = strings.ToLower(strings.TrimSpace(provider))
	if provider == "" {
		provider = defaultApplianceProvider
	}
	if provider != "github" && provider != "custom" {
		return "", nil, fmt.Errorf("release provider must be a supported repository URL")
	}
	raw = strings.TrimSpace(raw)
	if raw == "" && provider == defaultApplianceProvider {
		raw = defaultApplianceReleasesAPI
	}
	if raw == "" {
		return "", nil, fmt.Errorf("%s release provider requires an explicit HTTPS releases API", provider)
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" {
		return "", nil, fmt.Errorf("appliance releases API must be an HTTPS URL without credentials or a fragment")
	}
	if parsed.RawQuery != "" {
		query := parsed.Query()
		for key := range query {
			if key != "limit" && key != "per_page" && key != "page" {
				return "", nil, fmt.Errorf("appliance releases API contains unsupported query parameter %q", key)
			}
		}
	}
	if parsed.Host == "api.github.com" {
		provider = defaultApplianceProvider
	}
	if provider == defaultApplianceProvider {
		parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
		if !strings.EqualFold(parsed.Hostname(), "api.github.com") || len(parts) != 4 || parts[0] != "repos" || parts[1] == "" || parts[2] == "" || parts[3] != "releases" {
			return "", nil, fmt.Errorf("GitHub release provider requires an api.github.com repository releases URL")
		}
	}
	return provider, parsed, nil
}

func validateApplianceReleaseAssetURL(provider string, apiURL *url.URL, tag, name, raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return fmt.Errorf("download URL must use HTTPS without credentials, query, or fragment")
	}
	escapedPath := parsed.EscapedPath()
	lowerEscaped := strings.ToLower(escapedPath)
	escapedName := pathBaseEscaped(escapedPath)
	if strings.Contains(strings.ToLower(escapedName), "%2f") || strings.Contains(lowerEscaped, "%5c") || strings.Contains(escapedPath, "//") {
		return fmt.Errorf("download URL contains an unsafe encoded or nested path")
	}
	decodedName, err := url.PathUnescape(escapedName)
	if err != nil || decodedName != name || filepath.Base(decodedName) != decodedName || decodedName == "." || decodedName == ".." {
		return fmt.Errorf("download URL asset identity does not match %q", name)
	}
	decodedPath, err := url.PathUnescape(escapedPath)
	if err != nil || !strings.HasSuffix(decodedPath, "/releases/download/"+tag+"/"+name) {
		return fmt.Errorf("download URL is not scoped to the selected release")
	}
	if provider == defaultApplianceProvider {
		if !strings.EqualFold(parsed.Hostname(), "github.com") {
			return fmt.Errorf("GitHub asset URL must use github.com")
		}
		apiParts := strings.Split(strings.Trim(apiURL.Path, "/"), "/")
		if len(apiParts) < 4 || !strings.HasPrefix(decodedPath, "/"+apiParts[1]+"/"+apiParts[2]+"/") {
			return fmt.Errorf("GitHub asset URL does not match the configured repository")
		}
	} else if !strings.EqualFold(parsed.Host, apiURL.Host) {
		return fmt.Errorf("asset origin does not match the configured release API")
	}
	return nil
}

func pathBaseEscaped(path string) string {
	if index := strings.LastIndex(path, "/"); index >= 0 {
		return path[index+1:]
	}
	return path
}

func findApplianceReleaseAsset(release applianceRelease, name string) (applianceReleaseAsset, error) {
	for _, asset := range release.Assets {
		if asset.Name == name {
			return asset, nil
		}
	}
	return applianceReleaseAsset{}, fmt.Errorf("appliance release %s is missing %s", release.TagName, name)
}

func downloadVerifiedApplianceRelease(ctx context.Context, client *http.Client, release applianceRelease, cacheRoot, exactISOSHA string) (verifiedApplianceRelease, error) {
	if release.core == nil {
		return verifiedApplianceRelease{}, fmt.Errorf("release %s has no core release document", release.TagName)
	}
	r, digest, err := releasecache.ParseCoreRelease(release.coreRaw)
	if err != nil || digest != release.coreSHA256 {
		return verifiedApplianceRelease{}, fmt.Errorf("core release document changed after selection")
	}
	copy := *client
	transport, err := releasecache.CoreTransport(client.Transport, r)
	if err != nil {
		return verifiedApplianceRelease{}, err
	}
	copy.Transport = releasecache.Wrap(transport)
	client = &copy

	members := map[string]releasecache.CoreMember{}
	for _, member := range r.Members {
		members[member.Role] = member
	}
	host, media := members["appliance"], members["media"]
	if media.Source != host.Source || media.Branch != host.Branch || media.BuildVersion != host.BuildVersion || media.Tag != host.Tag {
		return verifiedApplianceRelease{}, fmt.Errorf("core media differs from selected host source")
	}
	cacheDir := filepath.Join(cacheRoot, safeReleaseCacheName(release.TagName))
	if err := os.MkdirAll(cacheDir, 0o700); err != nil {
		return verifiedApplianceRelease{}, fmt.Errorf("create appliance cache: %w", err)
	}
	manifestPath := filepath.Join(cacheDir, applianceManifestFilename)
	if err := downloadCoreBlob(ctx, client, host.Artifact, manifestPath, 16<<20, false); err != nil {
		return verifiedApplianceRelease{}, err
	}
	manifestRaw, err := os.ReadFile(manifestPath)
	if err != nil {
		return verifiedApplianceRelease{}, fmt.Errorf("read appliance manifest: %w", err)
	}
	manifest, err := parseApplianceBundleManifest(manifestRaw)
	if err != nil {
		return verifiedApplianceRelease{}, err
	}
	if host.BuildVersion != manifest.ImageVersion || host.SourceCommit != manifest.SourceCommit || host.Source != manifest.ReleaseSet.Source || host.Branch != manifest.ReleaseSet.Branch {
		return verifiedApplianceRelease{}, fmt.Errorf("image differs from complete core selection")
	}
	isoSHA := media.Artifact.SHA256
	exactISOSHA = strings.ToLower(strings.TrimSpace(exactISOSHA))
	if exactISOSHA != "" && exactISOSHA != isoSHA {
		return verifiedApplianceRelease{}, fmt.Errorf("exact ISO SHA-256 mismatch: release has %s, requested %s", isoSHA, exactISOSHA)
	}
	isoPath := filepath.Join(cacheDir, applianceISOFilename)
	if err := downloadCoreBlob(ctx, client, media.Artifact, isoPath, 8<<30, true); err != nil {
		if removeErr := os.Remove(isoPath); removeErr != nil && !os.IsNotExist(removeErr) {
			return verifiedApplianceRelease{}, fmt.Errorf("discard corrupt cached ISO: %w", removeErr)
		}
		if downloadErr := downloadCoreBlob(ctx, client, media.Artifact, isoPath, 8<<30, false); downloadErr != nil {
			return verifiedApplianceRelease{}, downloadErr
		}
	}
	return verifiedApplianceRelease{
		Release: release, Manifest: manifest, ManifestSHA: coreManifestDigest(manifestRaw),
		ISOSHA: isoSHA, ISOPath: isoPath, ManifestPath: manifestPath,
	}, nil
}

// downloadCoreBlob downloads one digest-bound blob and checks size and sha256.
func downloadCoreBlob(ctx context.Context, client *http.Client, blob releasecache.CoreBlob, destination string, maxBytes int64, useCache bool) error {
	asset := applianceReleaseAsset{Name: blob.Name, BrowserDownloadURL: blob.URL, Size: blob.SizeBytes}
	if err := downloadApplianceAsset(ctx, client, asset, destination, maxBytes, useCache); err != nil {
		return err
	}
	return verifyFileIdentity(destination, blob.SizeBytes, blob.SHA256)
}

func downloadApplianceAsset(ctx context.Context, client *http.Client, asset applianceReleaseAsset, destination string, maxBytes int64, useCache bool) error {
	if info, err := os.Stat(destination); useCache && err == nil && info.Mode().IsRegular() && (asset.Size <= 0 || info.Size() == asset.Size) {
		return nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, asset.BrowserDownloadURL, nil)
	if err != nil {
		return fmt.Errorf("create download request for %s: %w", asset.Name, err)
	}
	req.Header.Set("User-Agent", "youeye-installer/"+InstallerVersion)
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("download %s: %w", asset.Name, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download %s returned %s", asset.Name, resp.Status)
	}
	if resp.ContentLength > maxBytes || asset.Size > maxBytes {
		return fmt.Errorf("download %s exceeds the %d-byte safety limit", asset.Name, maxBytes)
	}
	tmp, err := os.CreateTemp(filepath.Dir(destination), "."+filepath.Base(destination)+"-*")
	if err != nil {
		return fmt.Errorf("create temporary download for %s: %w", asset.Name, err)
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	written, copyErr := io.Copy(tmp, io.LimitReader(resp.Body, maxBytes+1))
	closeErr := tmp.Close()
	if copyErr != nil {
		return fmt.Errorf("download %s: %w", asset.Name, copyErr)
	}
	if closeErr != nil {
		return fmt.Errorf("close download %s: %w", asset.Name, closeErr)
	}
	if written > maxBytes || (asset.Size > 0 && written != asset.Size) {
		return fmt.Errorf("download %s size mismatch: got %d, expected %d", asset.Name, written, asset.Size)
	}
	if err := os.Chmod(tmpPath, 0o600); err != nil {
		return fmt.Errorf("protect download %s: %w", asset.Name, err)
	}
	if err := os.Rename(tmpPath, destination); err != nil {
		return fmt.Errorf("publish download %s: %w", asset.Name, err)
	}
	return nil
}

func verifyPathSHA256(path, expected string) error {
	file, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open %s: %w", filepath.Base(path), err)
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return fmt.Errorf("hash %s: %w", filepath.Base(path), err)
	}
	got := hex.EncodeToString(hash.Sum(nil))
	if got != expected {
		return fmt.Errorf("%s SHA-256 mismatch: got %s, expected %s", filepath.Base(path), got, expected)
	}
	return nil
}

func safeReleaseCacheName(tag string) string {
	var out strings.Builder
	for _, char := range tag {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char == '.' || char == '-' || char == '_' {
			out.WriteRune(char)
		} else {
			out.WriteByte('_')
		}
	}
	if out.Len() == 0 {
		return "release"
	}
	return out.String()
}

func applianceHTTPClient() *http.Client {
	return &http.Client{
		Transport: releasecache.Wrap(nil),
		Timeout:   45 * time.Minute,
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return fmt.Errorf("appliance download exceeded five redirects")
			}
			if request.URL.Scheme != "https" || request.URL.Host == "" || request.URL.User != nil || request.URL.Fragment != "" {
				return fmt.Errorf("appliance download redirect must use HTTPS without credentials or a fragment")
			}
			origin := via[0].URL
			if strings.EqualFold(origin.Hostname(), "github.com") {
				host := strings.ToLower(request.URL.Hostname())
				if host != "github.com" && host != "release-assets.githubusercontent.com" && host != "objects.githubusercontent.com" {
					return fmt.Errorf("GitHub appliance download redirected to an untrusted host %q", request.URL.Hostname())
				}
				return nil
			}
			if !strings.EqualFold(request.URL.Host, origin.Host) {
				return fmt.Errorf("appliance download redirected across origins")
			}
			return nil
		},
	}
}

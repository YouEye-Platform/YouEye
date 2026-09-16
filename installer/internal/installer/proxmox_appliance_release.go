package installer

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	_ "embed"
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

	"github.com/youeye-platform/YouEye/appliance/ordering"
)

const (
	applianceISOFilename       = "youeye-appliance-amd64.iso"
	applianceManifestFilename  = "appliance-manifest.json"
	applianceManifestSigName   = "appliance-manifest.json.sig"
	applianceChecksumsFilename = "SHA256SUMS"
	applianceChecksumsSigName  = "SHA256SUMS.sig"
	applianceGitHubPageSize    = 100
	applianceForgejoPageSize   = 50
	applianceReleaseMaxPages   = 200
)

var applianceSignedAssetNames = []string{
	"appliance-development.pub",
	applianceManifestFilename,
	applianceManifestSigName,
	"internal-recovery.img.zst",
	"provenance.json",
	"recovery.efi",
	"sbom.spdx.json",
	"system-a.efi",
	"system-b.efi",
	"system-root.img.zst",
	"system-update-manifest.json",
	"system-update-manifest.json.sig",
	applianceISOFilename,
	"youeye-installer-linux-amd64",
	"youeye-system-update-bootstrap",
	"youeye-system-updater-linux-amd64",
}

//go:embed appliance-development.pub
var embeddedApplianceDevelopmentTrust []byte

type applianceReleaseAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
	Size               int64  `json:"size"`
}

type applianceRelease struct {
	sourceProvider   string
	sourceRepository string
	TagName          string                  `json:"tag_name"`
	Draft            bool                    `json:"draft"`
	Prerelease       bool                    `json:"prerelease"`
	PublishedAt      time.Time               `json:"published_at"`
	Assets           []applianceReleaseAsset `json:"assets"`
}

type verifiedApplianceRelease struct {
	Release       applianceRelease
	Manifest      applianceBundleManifest
	ManifestSHA   string
	ISOSHA        string
	ISOPath       string
	ManifestPath  string
	SignaturePath string
	ChecksumsPath string
	ChecksumsSig  string
}

func resolveApplianceRelease(ctx context.Context, client *http.Client, provider, apiURL, channel, exactTag string) (applianceRelease, error) {
	provider, baseURL, err := normalizeApplianceReleaseSource(provider, apiURL)
	if err != nil {
		return applianceRelease{}, err
	}
	pageSize := applianceForgejoPageSize
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
			return applianceRelease{}, fmt.Errorf("create appliance releases request: %w", err)
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
			return applianceRelease{}, fmt.Errorf("query appliance releases page %d: %w", page, err)
		}
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			return applianceRelease{}, fmt.Errorf("appliance releases API page %d returned %s", page, resp.Status)
		}
		var releasePage []applianceRelease
		decodeErr := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&releasePage)
		closeErr := resp.Body.Close()
		if decodeErr != nil {
			return applianceRelease{}, fmt.Errorf("decode appliance releases page %d: %w", page, decodeErr)
		}
		if closeErr != nil {
			return applianceRelease{}, fmt.Errorf("close appliance releases page %d: %w", page, closeErr)
		}
		if len(releasePage) == 0 {
			break
		}
		for _, release := range releasePage {
			if _, exists := seenTags[release.TagName]; exists {
				return applianceRelease{}, fmt.Errorf("appliance releases API returned duplicate tag %q", release.TagName)
			}
			seenTags[release.TagName] = struct{}{}
			release.sourceProvider = provider
			if provider == "forgejo" {
				parts := strings.Split(strings.Trim(baseURL.Path, "/"), "/")
				if len(parts) == 6 && parts[0] == "api" && parts[1] == "v1" && parts[2] == "repos" && parts[5] == "releases" {
					release.sourceRepository = baseURL.Scheme + "://" + baseURL.Host + "/" + parts[3] + "/" + parts[4]
				}
			}
			releases = append(releases, release)
		}
		if page == applianceReleaseMaxPages {
			return applianceRelease{}, fmt.Errorf("appliance release discovery exceeded %d pages; select an exact tag", applianceReleaseMaxPages)
		}
	}
	channel = strings.ToLower(strings.TrimSpace(channel))
	branchTrack := ""
	if strings.HasPrefix(channel, "branch:") {
		branchTrack = strings.TrimPrefix(channel, "branch:")
		if !validApplianceReleaseBranch(branchTrack) {
			return applianceRelease{}, fmt.Errorf("branch-associated appliance track is invalid")
		}
		channel = "branch"
	}
	type candidate struct {
		release applianceRelease
		version ordering.Version
	}
	var candidates []candidate
	for _, release := range releases {
		if release.Draft || release.PublishedAt.IsZero() {
			continue
		}
		switch channel {
		case "stable":
			version, ok := parseApplianceReleaseTag(release.TagName, "appliance-v")
			if ok && len(version.Pre) == 0 && !release.Prerelease {
				candidates = append(candidates, candidate{release: release, version: version})
			}
		case "development", "dev":
			if version, ok := parseApplianceReleaseTag(release.TagName, "appliance-dev-v"); ok {
				candidates = append(candidates, candidate{release: release, version: version})
			}
		case "branch":
			if version, ok := parseApplianceReleaseTag(release.TagName, "appliance-"+branchTrack+"-v"); ok {
				candidates = append(candidates, candidate{release: release, version: version})
			}
		case "exact":
			if exactTag != "" && release.TagName == exactTag && validExactApplianceRelease(release) {
				if err := validateApplianceReleaseAssets(provider, baseURL, release); err != nil {
					return applianceRelease{}, err
				}
				return release, nil
			}
		default:
			return applianceRelease{}, fmt.Errorf("unsupported appliance channel %q", channel)
		}
	}
	if channel == "exact" {
		return applianceRelease{}, fmt.Errorf("exact appliance release %q was not found", exactTag)
	}
	if len(candidates) > 0 {
		sort.Slice(candidates, func(i, j int) bool {
			if !candidates[i].release.PublishedAt.Equal(candidates[j].release.PublishedAt) {
				return candidates[i].release.PublishedAt.After(candidates[j].release.PublishedAt)
			}
			return ordering.CompareVersion(candidates[i].version, candidates[j].version) > 0
		})
		if err := validateApplianceReleaseAssets(provider, baseURL, candidates[0].release); err != nil {
			return applianceRelease{}, err
		}
		return candidates[0].release, nil
	}
	if channel == "branch" {
		return applianceRelease{}, fmt.Errorf("no signed appliance release was found for branch track %q", branchTrack)
	}
	return applianceRelease{}, fmt.Errorf("no %s appliance release was found", channel)
}

func normalizeApplianceReleaseSource(provider, raw string) (string, *url.URL, error) {
	provider = strings.ToLower(strings.TrimSpace(provider))
	if provider == "" {
		provider = defaultApplianceProvider
	}
	if provider != "github" && provider != "forgejo" && provider != "custom" {
		return "", nil, fmt.Errorf("release provider must be github, forgejo, or custom")
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
	if provider == defaultApplianceProvider {
		parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
		if !strings.EqualFold(parsed.Hostname(), "api.github.com") || len(parts) != 4 || parts[0] != "repos" || parts[1] == "" || parts[2] == "" || parts[3] != "releases" {
			return "", nil, fmt.Errorf("GitHub release provider requires an api.github.com repository releases URL")
		}
	}
	return provider, parsed, nil
}

func validExactApplianceRelease(release applianceRelease) bool {
	if release.Draft || release.PublishedAt.IsZero() {
		return false
	}
	if version, ok := parseApplianceReleaseTag(release.TagName, "appliance-v"); ok {
		return len(version.Pre) == 0 && !release.Prerelease
	}
	if _, ok := parseApplianceReleaseTag(release.TagName, "appliance-dev-v"); ok {
		return true
	}
	if !strings.HasPrefix(release.TagName, "appliance-") {
		return false
	}
	marker := strings.LastIndex(release.TagName, "-v")
	if marker <= len("appliance-") {
		return false
	}
	branch := release.TagName[len("appliance-"):marker]
	_, versionOK := parseApplianceReleaseTag(release.TagName, "appliance-"+branch+"-v")
	return validApplianceReleaseBranch(branch) && versionOK
}

func parseApplianceReleaseTag(tag, prefix string) (ordering.Version, bool) {
	if !strings.HasPrefix(tag, prefix) {
		return ordering.Version{}, false
	}
	version, err := ordering.ParseVersion(strings.TrimPrefix(tag, prefix))
	return version, err == nil
}

func validateApplianceReleaseAssets(provider string, apiURL *url.URL, release applianceRelease) error {
	required := make(map[string]bool, len(applianceSignedAssetNames)+2)
	for _, name := range applianceSignedAssetNames {
		required[name] = false
	}
	required[applianceChecksumsFilename] = false
	required[applianceChecksumsSigName] = false
	for _, asset := range release.Assets {
		if _, ok := required[asset.Name]; !ok {
			return fmt.Errorf("appliance release %s contains unexpected asset %s", release.TagName, asset.Name)
		}
		if required[asset.Name] {
			return fmt.Errorf("appliance release %s has duplicate asset %s", release.TagName, asset.Name)
		}
		if err := validateApplianceReleaseAssetURL(provider, apiURL, release.TagName, asset.Name, asset.BrowserDownloadURL); err != nil {
			return fmt.Errorf("appliance release %s asset %s: %w", release.TagName, asset.Name, err)
		}
		required[asset.Name] = true
	}
	for name, found := range required {
		if !found {
			return fmt.Errorf("appliance release %s is missing %s", release.TagName, name)
		}
	}
	return nil
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
	embeddedTrust, trustErr := applianceReleaseAnchor(release)
	if trustErr != nil {
		return verifiedApplianceRelease{}, trustErr
	}
	cacheDir := filepath.Join(cacheRoot, safeReleaseCacheName(release.TagName))
	if err := os.MkdirAll(cacheDir, 0o700); err != nil {
		return verifiedApplianceRelease{}, fmt.Errorf("create appliance cache: %w", err)
	}
	paths := make(map[string]string)
	for _, name := range []string{applianceChecksumsFilename, applianceChecksumsSigName, applianceManifestFilename, applianceManifestSigName} {
		asset, err := findApplianceReleaseAsset(release, name)
		if err != nil {
			return verifiedApplianceRelease{}, err
		}
		path := filepath.Join(cacheDir, name)
		if err := downloadApplianceAsset(ctx, client, asset, path, 16<<20, false); err != nil {
			return verifiedApplianceRelease{}, err
		}
		paths[name] = path
	}

	publicKey, err := parseEd25519PublicKey(embeddedTrust)
	if err != nil {
		return verifiedApplianceRelease{}, fmt.Errorf("parse embedded appliance trust: %w", err)
	}
	checksumsRaw, err := os.ReadFile(paths[applianceChecksumsFilename])
	if err != nil {
		return verifiedApplianceRelease{}, fmt.Errorf("read appliance checksums: %w", err)
	}
	checksumsSigRaw, err := os.ReadFile(paths[applianceChecksumsSigName])
	if err != nil {
		return verifiedApplianceRelease{}, fmt.Errorf("read appliance checksum signature: %w", err)
	}
	checksumsSig, err := parseEd25519Signature(checksumsSigRaw)
	if err != nil || !ed25519.Verify(publicKey, checksumsRaw, checksumsSig) {
		return verifiedApplianceRelease{}, fmt.Errorf("appliance checksum signature is not valid")
	}
	checksums, err := parseSHA256SUMS(checksumsRaw)
	if err != nil {
		return verifiedApplianceRelease{}, err
	}
	if err := validateApplianceChecksumSet(checksums); err != nil {
		return verifiedApplianceRelease{}, err
	}
	embeddedTrustDigest := sha256.Sum256(embeddedTrust)
	if checksums["appliance-development.pub"] != hex.EncodeToString(embeddedTrustDigest[:]) {
		return verifiedApplianceRelease{}, fmt.Errorf("signed appliance trust anchor does not match the embedded Installer authority")
	}
	if err := verifyPathSHA256(paths[applianceManifestFilename], checksums[applianceManifestFilename]); err != nil {
		return verifiedApplianceRelease{}, err
	}
	if err := verifyPathSHA256(paths[applianceManifestSigName], checksums[applianceManifestSigName]); err != nil {
		return verifiedApplianceRelease{}, err
	}
	manifestRaw, err := os.ReadFile(paths[applianceManifestFilename])
	if err != nil {
		return verifiedApplianceRelease{}, fmt.Errorf("read appliance manifest: %w", err)
	}
	manifestSigRaw, err := os.ReadFile(paths[applianceManifestSigName])
	if err != nil {
		return verifiedApplianceRelease{}, fmt.Errorf("read appliance manifest signature: %w", err)
	}
	manifestSig, err := parseEd25519Signature(manifestSigRaw)
	if err != nil || !ed25519.Verify(publicKey, manifestRaw, manifestSig) {
		return verifiedApplianceRelease{}, fmt.Errorf("appliance manifest signature is not valid")
	}
	manifest, err := parseApplianceBundleManifest(manifestRaw)
	if err != nil {
		return verifiedApplianceRelease{}, err
	}
	if release.sourceProvider == "github" {
		class := "development"
		if strings.HasPrefix(release.TagName, "appliance-v") {
			class = "stable"
		}
		if strings.HasPrefix(release.TagName, "appliance-beta-v") {
			class = "beta"
		}
		if manifest.Trust.Class != class || manifest.ReleaseSet.Source != "https://github.com/YouEye-Platform/YouEye" {
			return verifiedApplianceRelease{}, fmt.Errorf("signed appliance trust/source differs from selected GitHub release")
		}
	}
	if privateForgejoMainRelease(release) && (manifest.ReleaseSet.Source != release.sourceRepository || manifest.ReleaseSet.Branch != "main") {
		return verifiedApplianceRelease{}, fmt.Errorf("signed appliance source does not match the selected Forgejo main repository")
	}
	expectedTag := "appliance-" + manifest.ReleaseSet.Branch + "-v" + manifest.ImageVersion
	if manifest.ReleaseSet.Branch == "main" {
		expectedTag = "appliance-v" + manifest.ImageVersion
	}
	if release.TagName != expectedTag {
		return verifiedApplianceRelease{}, fmt.Errorf("appliance release tag %q does not match signed image version %q", release.TagName, manifest.ImageVersion)
	}
	manifestDigest := sha256.Sum256(manifestRaw)
	isoSHA := checksums[applianceISOFilename]
	exactISOSHA = strings.ToLower(strings.TrimSpace(exactISOSHA))
	if exactISOSHA != "" && exactISOSHA != isoSHA {
		return verifiedApplianceRelease{}, fmt.Errorf("exact ISO SHA-256 mismatch: release has %s, requested %s", isoSHA, exactISOSHA)
	}
	isoAsset, err := findApplianceReleaseAsset(release, applianceISOFilename)
	if err != nil {
		return verifiedApplianceRelease{}, err
	}
	isoPath := filepath.Join(cacheDir, applianceISOFilename)
	if err := downloadApplianceAsset(ctx, client, isoAsset, isoPath, 8<<30, true); err != nil {
		return verifiedApplianceRelease{}, err
	}
	if err := verifyPathSHA256(isoPath, isoSHA); err != nil {
		if removeErr := os.Remove(isoPath); removeErr != nil && !os.IsNotExist(removeErr) {
			return verifiedApplianceRelease{}, fmt.Errorf("discard corrupt cached ISO: %w", removeErr)
		}
		if downloadErr := downloadApplianceAsset(ctx, client, isoAsset, isoPath, 8<<30, false); downloadErr != nil {
			return verifiedApplianceRelease{}, downloadErr
		}
		if verifyErr := verifyPathSHA256(isoPath, isoSHA); verifyErr != nil {
			return verifiedApplianceRelease{}, verifyErr
		}
	}
	return verifiedApplianceRelease{
		Release: release, Manifest: manifest, ManifestSHA: hex.EncodeToString(manifestDigest[:]),
		ISOSHA: isoSHA, ISOPath: isoPath, ManifestPath: paths[applianceManifestFilename],
		SignaturePath: paths[applianceManifestSigName], ChecksumsPath: paths[applianceChecksumsFilename],
		ChecksumsSig: paths[applianceChecksumsSigName],
	}, nil
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

func parseSHA256SUMS(raw []byte) (map[string]string, error) {
	sums := make(map[string]string)
	scanner := bufio.NewScanner(bytes.NewReader(raw))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) != 2 || !validSHA256Hex(fields[0]) {
			return nil, fmt.Errorf("invalid SHA256SUMS line %q", line)
		}
		name := strings.TrimPrefix(fields[1], "*")
		if filepath.Base(name) != name || name == "." || name == ".." {
			return nil, fmt.Errorf("unsafe SHA256SUMS path %q", name)
		}
		if _, exists := sums[name]; exists {
			return nil, fmt.Errorf("duplicate SHA256SUMS path %q", name)
		}
		sums[name] = fields[0]
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("read SHA256SUMS: %w", err)
	}
	return sums, nil
}

func validateApplianceChecksumSet(checksums map[string]string) error {
	if len(checksums) != len(applianceSignedAssetNames) {
		return fmt.Errorf("signed appliance checksum entry count is %d, want %d", len(checksums), len(applianceSignedAssetNames))
	}
	for _, name := range applianceSignedAssetNames {
		if _, ok := checksums[name]; !ok {
			return fmt.Errorf("signed checksums do not contain %s", name)
		}
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
		Timeout: 45 * time.Minute,
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

// Source context is assigned by discovery, never decoded from provider JSON.
// Private trust accepts only five-position Forgejo main releases. Public Stable
// still requires its own authority.
func privateForgejoMainRelease(release applianceRelease) bool {
	if release.sourceProvider != "forgejo" || release.sourceRepository == "" {
		return false
	}
	source, err := url.Parse(release.sourceRepository)
	if err != nil || source.Scheme != "https" || source.User != nil || source.RawQuery != "" || source.Fragment != "" || source.Host == "" {
		return false
	}
	host := strings.ToLower(source.Hostname())
	if host == "github.com" || host == "api.github.com" || strings.HasSuffix(host, ".github.com") {
		return false
	}
	version := strings.TrimPrefix(release.TagName, "appliance-v")
	if version == release.TagName || len(strings.Split(version, ".")) != 5 {
		return false
	}
	_, err = ordering.ParseVersion(version)
	return err == nil
}

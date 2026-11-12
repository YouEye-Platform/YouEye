package installer

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/youeye-platform/YouEye/releasecache"
)

const (
	applianceISOFilename      = "youeye-appliance-amd64.iso"
	applianceManifestFilename = "appliance-manifest.json"
	coreReleaseFilename       = "core-release.json"
)

type applianceReleaseAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
	Size               int64  `json:"size"`
}

// applianceRelease is one System release of a repository, with its exact
// core-release.json bytes and digest.
type applianceRelease struct {
	core       *releasecache.CoreRelease
	coreRaw    []byte
	coreSHA256 string
	Repository string
	TagName    string
}

type verifiedApplianceRelease struct {
	Release      applianceRelease
	Manifest     applianceBundleManifest
	ManifestSHA  string
	ISOSHA       string
	ISOPath      string
	ManifestPath string
}

// resolveApplianceRelease finds the System release to install. With an exact
// tag (and its required core-release.json digest) it downloads that document;
// otherwise it reads the channel index. It never lists releases.
func resolveApplianceRelease(ctx context.Context, client *http.Client, repository, channel, exactTag, exactSHA256 string) (applianceRelease, error) {
	repository, err := releasecache.CanonicalRepository(repository)
	if err != nil {
		return applianceRelease{}, err
	}
	if !releasecache.ValidChannel(channel) {
		return applianceRelease{}, fmt.Errorf("release channel must be dev, alpha, beta or stable")
	}
	var raw []byte
	var manifest releasecache.CoreRelease
	var digest string
	if exactTag != "" {
		if !validCoreTag(exactTag) || !validSHA256Hex(exactSHA256) {
			return applianceRelease{}, fmt.Errorf("an exact release needs its youeye-v tag and core-release.json SHA-256")
		}
		raw, err = releasecache.FetchDocument(ctx, client, releasecache.ChannelEntry{Repository: repository, Tag: exactTag, Document: coreReleaseFilename, SHA256: exactSHA256})
		if err != nil {
			return applianceRelease{}, err
		}
		manifest, digest, err = releasecache.ParseCoreRelease(raw)
		if err == nil && manifest.Tag != exactTag {
			err = fmt.Errorf("core-release.json of %s names tag %s", exactTag, manifest.Tag)
		}
	} else {
		raw, manifest, digest, err = releasecache.FetchCoreRelease(ctx, client, repository, channel)
	}
	if err != nil {
		return applianceRelease{}, err
	}
	return applianceRelease{core: &manifest, coreRaw: raw, coreSHA256: digest, Repository: repository, TagName: manifest.Tag}, nil
}

func pathBaseEscaped(path string) string {
	if index := strings.LastIndex(path, "/"); index >= 0 {
		return path[index+1:]
	}
	return path
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
	copy.Transport = releasecache.Wrap(client.Transport)
	client = &copy

	members := map[string]releasecache.CoreMember{}
	for _, member := range r.Members {
		members[member.Role] = member
	}
	host, media := members["appliance"], members["media"]
	if media.BuildVersion != host.BuildVersion || media.SourceTree != host.SourceTree {
		return verifiedApplianceRelease{}, fmt.Errorf("core media differs from selected host build")
	}
	cacheDir := filepath.Join(cacheRoot, safeReleaseCacheName(release.TagName))
	if err := os.MkdirAll(cacheDir, 0o700); err != nil {
		return verifiedApplianceRelease{}, fmt.Errorf("create appliance cache: %w", err)
	}
	manifestPath := filepath.Join(cacheDir, applianceManifestFilename)
	if err := downloadCoreBlob(ctx, client, release, host.Artifact, manifestPath, 16<<20, false); err != nil {
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
	if host.BuildVersion != manifest.ImageVersion || host.SourceTree != manifest.SourceTree {
		return verifiedApplianceRelease{}, fmt.Errorf("image differs from complete core selection")
	}
	isoSHA := media.Artifact.SHA256
	exactISOSHA = strings.ToLower(strings.TrimSpace(exactISOSHA))
	if exactISOSHA != "" && exactISOSHA != isoSHA {
		return verifiedApplianceRelease{}, fmt.Errorf("exact ISO SHA-256 mismatch: release has %s, requested %s", isoSHA, exactISOSHA)
	}
	isoPath := filepath.Join(cacheDir, applianceISOFilename)
	if err := downloadCoreBlob(ctx, client, release, media.Artifact, isoPath, 8<<30, true); err != nil {
		if removeErr := os.Remove(isoPath); removeErr != nil && !os.IsNotExist(removeErr) {
			return verifiedApplianceRelease{}, fmt.Errorf("discard corrupt cached ISO: %w", removeErr)
		}
		if downloadErr := downloadCoreBlob(ctx, client, release, media.Artifact, isoPath, 8<<30, false); downloadErr != nil {
			return verifiedApplianceRelease{}, downloadErr
		}
	}
	return verifiedApplianceRelease{
		Release: release, Manifest: manifest, ManifestSHA: coreManifestDigest(manifestRaw),
		ISOSHA: isoSHA, ISOPath: isoPath, ManifestPath: manifestPath,
	}, nil
}

// downloadCoreBlob downloads one digest-bound blob of release and checks size
// and sha256.
func downloadCoreBlob(ctx context.Context, client *http.Client, release applianceRelease, blob releasecache.CoreBlob, destination string, maxBytes int64, useCache bool) error {
	asset := applianceReleaseAsset{Name: blob.Name, BrowserDownloadURL: releasecache.AssetURL(release.Repository, release.TagName, blob), Size: blob.SizeBytes}
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
		return fmt.Errorf("download %s: %w", asset.Name, releasecache.HTTPError(resp.StatusCode, asset.BrowserDownloadURL))
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

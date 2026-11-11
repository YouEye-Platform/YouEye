package systemupdate

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/youeye-platform/YouEye/releasecache"
)

var ErrNoCoreRelease = errors.New("no complete core release on the selected source branch")

// errCoreMetadataNotFound is a definite absence of a listed release document.
var errCoreMetadataNotFound = errors.New("core release document not found")

func releaseHasAsset(r release, name string) bool {
	for _, asset := range r.Assets {
		if asset.Name == name {
			return true
		}
	}
	return false
}

type CoreReleaseSelection struct {
	Source         string
	Branch         string
	Fallback       []string
	Tag            string
	ManifestSHA256 string
}

// ResolveCoreRelease selects one complete release document over HTTPS. Raw
// branch names, ordered fallback and exact pins remain independent of suffix
// tokens. Document sequence selects the track head; provider timestamps never
// decide. An exact pin is bound by its manifest digest.
func ResolveCoreRelease(ctx context.Context, client *http.Client, selection CoreReleaseSelection) (CoreHostSelection, releasecache.CoreRelease, string, error) {
	var empty CoreHostSelection
	source, err := releasecache.ParseRepositorySource(selection.Source)
	if err != nil {
		return empty, releasecache.CoreRelease{}, "", err
	}
	if !releasecache.ValidCoreBranch(selection.Branch) {
		return empty, releasecache.CoreRelease{}, "", fmt.Errorf("exact source branch required")
	}
	if selection.Tag != "" {
		if !strings.HasPrefix(selection.Tag, "youeye-v") || !releasecache.ValidCoreVersion(strings.TrimPrefix(selection.Tag, "youeye-v")) || !validSHA256(selection.ManifestSHA256) {
			return empty, releasecache.CoreRelease{}, "", fmt.Errorf("exact core pin requires canonical tag and manifest digest")
		}
	} else if selection.ManifestSHA256 != "" {
		return empty, releasecache.CoreRelease{}, "", fmt.Errorf("core digest requires an exact tag")
	}
	branches := []string{selection.Branch}
	seen := map[string]bool{selection.Branch: true}
	for _, branch := range selection.Fallback {
		if !releasecache.ValidCoreBranch(branch) {
			return empty, releasecache.CoreRelease{}, "", fmt.Errorf("invalid fallback branch")
		}
		if !seen[branch] && selection.Tag == "" {
			branches = append(branches, branch)
			seen[branch] = true
		}
	}
	if client == nil {
		client = ReleaseHTTPClient()
	}
	api, _ := url.Parse(source.ReleasesAPI)
	discoveryCtx := ctx
	if selection.Tag == "" {
		// Following a track requires current discovery, never the list frozen
		// into installation media.
		discoveryCtx = releasecache.LiveDiscovery(ctx)
	}
	releases, err := fetchReleases(discoveryCtx, client, source.Adapter, api)
	if err != nil {
		return empty, releasecache.CoreRelease{}, "", err
	}
	if selection.Tag != "" {
		found := false
		for _, candidate := range releases {
			found = found || candidate.TagName == selection.Tag
		}
		if !found {
			// An exact unpublished candidate can be supplied by protected media,
			// but that snapshot cannot hide a later explicitly selected release.
			releases, err = fetchReleases(releasecache.LiveDiscovery(ctx), client, source.Adapter, api)
			if err != nil {
				return empty, releasecache.CoreRelease{}, "", err
			}
		}
	}
	for _, branch := range branches {
		var selected CoreHostSelection
		var best releasecache.CoreRelease
		var digest string
		sequences := map[uint64]string{}
		for _, candidate := range releases {
			if candidate.Draft || !strings.HasPrefix(candidate.TagName, "youeye-v") || !releasecache.ValidCoreVersion(strings.TrimPrefix(candidate.TagName, "youeye-v")) || selection.Tag != "" && candidate.TagName != selection.Tag {
				continue
			}
			// Only these branches have a reserved public/development token. Other
			// branches must be resolved by their raw document identity.
			version := strings.TrimPrefix(candidate.TagName, "youeye-v")
			if branch == "main" && ((source.Adapter == "github" && strings.Contains(version, "-")) || (source.Adapter != "github" && !strings.Contains(version, "-alpha."))) {
				continue
			}
			if (branch == "dev" || branch == "beta" || branch == "alpha") && !strings.Contains(version, "-"+branch+".") {
				continue
			}
			// Older releases on the same track may predate the current document
			// format (e.g. signed 0.5.x releases) or lack core-release.json. They
			// are not candidates; skipping them cannot promote anything, because
			// only documents that parse are compared by sequence. Only such
			// definite absence or invalidity is skipped: a transport, server or
			// rate-limit failure is returned so discovery is reported unavailable
			// instead of silently selecting an older release. An exact pin's
			// document must always be readable.
			if !releaseHasAsset(candidate, "core-release.json") {
				if selection.Tag != "" {
					return empty, best, "", fmt.Errorf("core release %s is missing core-release.json", candidate.TagName)
				}
				continue
			}
			manifestURL, err := releaseAssetURL(source.Adapter, api, candidate, "core-release.json")
			if err != nil {
				return empty, best, "", err
			}
			raw, err := readCoreMetadata(ctx, client, manifestURL, 1<<20)
			if err != nil {
				if selection.Tag == "" && errors.Is(err, errCoreMetadataNotFound) {
					continue
				}
				return empty, best, "", err
			}
			parsed, hash, err := releasecache.ParseCoreRelease(raw)
			if err != nil {
				if selection.Tag != "" {
					return empty, best, "", err
				}
				continue
			}
			if parsed.Source != source.URL || parsed.Tag != candidate.TagName {
				return empty, best, "", fmt.Errorf("core release differs from selected repository/tag")
			}
			if parsed.Branch != branch {
				continue
			}
			expectedChannel := "feature"
			switch branch {
			case "main":
				expectedChannel = "stable"
				if source.Adapter != "github" {
					expectedChannel = "alpha"
				}
			case "dev", "beta", "alpha":
				expectedChannel = branch
			}
			if parsed.Channel != expectedChannel {
				return empty, best, "", fmt.Errorf("core channel differs from exact source branch policy")
			}
			if parsed.Channel == "stable" && candidate.Prerelease {
				return empty, best, "", fmt.Errorf("Stable core is advertised as a prerelease")
			}
			r := parsed
			if selection.Tag != "" && hash != selection.ManifestSHA256 {
				return empty, best, "", fmt.Errorf("exact core pin digest mismatch")
			}
			if previous, ok := sequences[r.Sequence]; ok && previous != hash {
				return empty, best, "", fmt.Errorf("conflicting core sequence on selected track")
			}
			sequences[r.Sequence] = hash
			if best.Sequence == 0 || r.Sequence > best.Sequence {
				best, digest, selected = r, hash, CoreHostSelection{Raw: raw}
			}
		}
		if best.Sequence != 0 {
			return selected, best, digest, nil
		}
	}
	return empty, releasecache.CoreRelease{}, "", ErrNoCoreRelease
}

func readCoreMetadata(ctx context.Context, client *http.Client, source string, limit int64) ([]byte, error) {
	// Metadata is a release asset, not an API response. Preserve the caller's
	// transport (including protected candidate inputs), but use artifact redirects.
	client = CoreArtifactHTTPClient(client)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
	if err != nil {
		return nil, err
	}
	response, err := client.Do(request)
	if err != nil {
		var remote *url.Error
		if errors.As(err, &remote) {
			return nil, fmt.Errorf("core metadata request failed: %w", remote.Err)
		}
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("%w (HTTP 404)", errCoreMetadataNotFound)
	}
	if response.StatusCode != http.StatusOK || response.ContentLength > limit {
		return nil, fmt.Errorf("exact core metadata unavailable or oversized (HTTP %d)", response.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || int64(len(raw)) > limit || len(raw) == 0 {
		return nil, fmt.Errorf("core metadata read failed or exceeded bounds")
	}
	return raw, nil
}

package installer

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/youeye-platform/YouEye/releasecache"
)

func coreManifestDigest(raw []byte) string {
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}
func validCoreTag(tag string) bool {
	return strings.HasPrefix(tag, "youeye-v") && releasecache.ValidCoreVersion(strings.TrimPrefix(tag, "youeye-v"))
}

func readCoreAsset(ctx context.Context, client *http.Client, asset applianceReleaseAsset, limit int64) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, asset.BrowserDownloadURL, nil)
	if err != nil {
		return nil, err
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.ContentLength > limit || asset.Size > limit {
		return nil, fmt.Errorf("core metadata unavailable or oversized")
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || int64(len(raw)) > limit || asset.Size > 0 && int64(len(raw)) != asset.Size {
		return nil, fmt.Errorf("core metadata size mismatch")
	}
	return raw, nil
}

func resolveCoreApplianceRelease(ctx context.Context, client *http.Client, provider string, api *url.URL, releases []applianceRelease, channel, exactTag string) (applianceRelease, bool, error) {
	var selected applianceRelease
	if exactTag != "" && !validCoreTag(exactTag) {
		return selected, false, nil
	}
	parts := strings.Split(strings.Trim(api.Path, "/"), "/")
	source := ""
	if provider == "github" && len(parts) == 4 {
		source = "https://github.com/" + parts[1] + "/" + parts[2]
	}
	if provider == "custom" && len(parts) == 6 && parts[0] == "api" && parts[1] == "v1" && parts[2] == "repos" {
		source = api.Scheme + "://" + api.Host + "/" + parts[3] + "/" + parts[4]
	}
	channel = strings.TrimSpace(channel)
	branch := ""
	switch channel {
	case "stable":
		branch = "main"
	case "dev", "development":
		branch = "dev"
	case "exact":
	default:
		if strings.HasPrefix(channel, "branch:") {
			branch = strings.TrimPrefix(channel, "branch:")
		}
	}
	for _, candidate := range releases {
		if candidate.Draft || !validCoreTag(candidate.TagName) || exactTag != "" && candidate.TagName != exactTag {
			continue
		}
		if source == "" {
			return selected, true, fmt.Errorf("core release source must be an exact supported repository")
		}
		manifestAsset, err := findApplianceReleaseAsset(candidate, "core-release.json")
		if err != nil {
			return selected, true, err
		}
		signatureAsset, err := findApplianceReleaseAsset(candidate, "core-release.json.sig")
		if err != nil {
			return selected, true, err
		}
		for _, asset := range []applianceReleaseAsset{manifestAsset, signatureAsset} {
			if err := validateApplianceReleaseAssetURL(provider, api, candidate.TagName, asset.Name, asset.BrowserDownloadURL); err != nil {
				return selected, true, err
			}
		}
		raw, err := readCoreAsset(ctx, client, manifestAsset, 1<<20)
		if err != nil {
			return selected, true, err
		}
		manifest, _, err := releasecache.ParseCoreRelease(raw)
		if err != nil {
			return selected, true, err
		}
		if branch != "" && manifest.Branch != branch {
			continue
		}
		if manifest.Source != source || manifest.Tag != candidate.TagName {
			return selected, true, fmt.Errorf("core manifest differs from selected source/tag")
		}
		trust := embeddedApplianceDevelopmentTrust
		if provider == "github" {
			if manifest.Channel != "stable" && manifest.Channel != "beta" {
				return selected, true, fmt.Errorf("public core channel has no scoped host authority")
			}
			if manifest.Channel == "stable" && manifest.Branch != "main" || manifest.Channel == "beta" && manifest.Branch != "beta" {
				return selected, true, fmt.Errorf("core channel and source branch differ")
			}
			trust, err = publicReleaseAnchor(manifest.Channel)
			if err != nil {
				return selected, true, err
			}
		}
		key, err := parseEd25519PublicKey(trust)
		if err != nil {
			return selected, true, err
		}
		signature, err := readCoreAsset(ctx, client, signatureAsset, 1024)
		if err != nil {
			return selected, true, err
		}
		manifest, digest, err := releasecache.VerifyCoreRelease(raw, signature, key)
		if err != nil {
			return selected, true, err
		}
		members := map[string]releasecache.CoreMember{}
		for _, member := range manifest.Members {
			members[member.Role] = member
		}
		host, media := members["appliance"], members["media"]
		if host.Source != source || media.Source != host.Source || media.Branch != host.Branch || media.BuildVersion != host.BuildVersion || media.Tag != host.Tag || media.KeyID != host.KeyID || media.Checksums != host.Checksums {
			return selected, true, fmt.Errorf("core media differs from selected host source")
		}
		candidate.core = &manifest
		candidate.coreRaw = raw
		candidate.coreSignature = signature
		candidate.coreSHA256 = digest
		candidate.sourceProvider = provider
		candidate.sourceRepository = source
		// Normalize only the names used by the existing image verifier. The
		// immutable URLs and original bytes remain bound by the core signature.
		candidate.Assets = nil
		for _, blob := range []releasecache.CoreBlob{host.Artifact, host.Checksums, host.Signature, *host.DocumentSignature, host.Provenance, host.SBOM, *host.ReleaseLock, media.Artifact} {
			candidate.Assets = append(candidate.Assets, applianceReleaseAsset{Name: blob.Name, BrowserDownloadURL: blob.URL, Size: blob.SizeBytes})
		}
		if selected.core != nil && selected.core.Sequence == manifest.Sequence && selected.coreSHA256 != digest {
			return selected, true, fmt.Errorf("conflicting core release sequence")
		}
		if selected.core == nil || manifest.Sequence > selected.core.Sequence {
			selected = candidate
		}
	}
	if selected.core == nil && exactTag != "" {
		return selected, true, fmt.Errorf("exact core release unavailable")
	}
	return selected, selected.core != nil, nil
}

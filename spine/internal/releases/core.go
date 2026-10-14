package releases

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/channels"
	"github.com/youeye-platform/YouEye/spine/internal/config"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

// The installer/host coordinator owns these exact signed bytes. Consumers do
// not choose a newer assembly while applying one of its members.
var coreSelectionRoot = systemupdate.CoreBootstrapPath
var coreDevelopmentKeyPath = systemupdate.CoreDevelopmentTrustPath

func selectedCoreMember(source, branch, tag, digest, role string) (releasecache.CoreMember, releasecache.CoreRelease, error) {
	r, _, err := systemupdate.ReadCoreSelection(coreSelectionRoot, coreDevelopmentKeyPath)
	if err != nil {
		return releasecache.CoreMember{}, r, err
	}
	for _, member := range r.Members {
		if member.Role != role {
			continue
		}
		if source != member.Source || branch != member.Branch || tag != member.Tag || digest == "" || digest != member.Artifact.SHA256 {
			return member, r, fmt.Errorf("component channel differs from frozen core membership")
		}
		return member, r, nil
	}
	return releasecache.CoreMember{}, r, fmt.Errorf("component is absent from frozen core selection")
}

func coreCandidate(cfg *config.Config, eff channels.Channel, role string) (Candidate, releasecache.CoreMember, error) {
	src := resolveSource(cfg, eff.Source)
	member, _, err := selectedCoreMember(src.RepoURL, eff.Branch, eff.Tag, eff.ArtifactSHA256, role)
	return Candidate{Tag: member.Tag, Version: member.BuildVersion, Branch: member.Branch, Source: member.Source, ArtifactSHA256: member.Artifact.SHA256, ArtifactURL: member.Artifact.URL}, member, err
}

// VerifySelectedCoreArtifact keeps the original signed checksum names even
// when publication has namespaced filenames. The artifact is streamed locally;
// exact bounded metadata is read through the same protected cache transport.
func VerifySelectedCoreArtifact(ctx context.Context, client *http.Client, artifactURL, artifactPath, expectedDigest, role string) error {
	r, _, err := systemupdate.ReadCoreSelection(coreSelectionRoot, coreDevelopmentKeyPath)
	if err != nil {
		return err
	}
	var member releasecache.CoreMember
	for _, candidate := range r.Members {
		if candidate.Role == role {
			member = candidate
		}
	}
	if member.Artifact.URL != artifactURL || expectedDigest == "" || expectedDigest != member.Artifact.SHA256 {
		return fmt.Errorf("download differs from frozen core member")
	}
	key, err := systemupdate.CoreMemberKey(member, r.Channel, coreDevelopmentKeyPath)
	if err != nil {
		return err
	}
	return releasecache.VerifyCoreMember(member, key, func(blob releasecache.CoreBlob) (io.ReadCloser, error) {
		if blob == member.Artifact {
			return os.Open(artifactPath)
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, blob.URL, nil)
		if err != nil {
			return nil, err
		}
		response, err := client.Do(request)
		if err != nil {
			return nil, err
		}
		if response.StatusCode != http.StatusOK || response.ContentLength > blob.SizeBytes {
			response.Body.Close()
			return nil, fmt.Errorf("core metadata unavailable or oversized")
		}
		return response.Body, nil
	})
}

func canonicalCoreTag(tag string) bool {
	return strings.HasPrefix(tag, "youeye-v") && releasecache.ValidCoreVersion(strings.TrimPrefix(tag, "youeye-v"))
}

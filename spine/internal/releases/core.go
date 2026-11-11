package releases

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/channels"
	"github.com/youeye-platform/YouEye/spine/internal/config"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

// The installer/host coordinator owns these exact digest-bound bytes.
// Consumers do not choose a newer release while applying one of its members.
var coreSelectionRoot = systemupdate.CoreBootstrapPath

func readSelectedCore(context.Context) (releasecache.CoreRelease, error) {
	release, _, err := systemupdate.ReadCoreSelection(coreSelectionRoot)
	return release, err
}

func selectedCoreMember(source, branch, tag, digest, role string) (releasecache.CoreMember, releasecache.CoreRelease, error) {
	r, err := readSelectedCore(context.Background())
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

// VerifySelectedCoreArtifact checks a downloaded artifact against the frozen
// core member's exact sha256 and size.
func VerifySelectedCoreArtifact(ctx context.Context, artifactURL, artifactPath, expectedDigest, role string) error {
	r, err := readSelectedCore(ctx)
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
	return verifyArtifactFile(artifactPath, member.Artifact.SizeBytes, member.Artifact.SHA256)
}

// VerifyReleaseArtifact checks a downloaded component before it may mutate a
// runtime. A canonical youeye-v release asset must be the accepted core
// release member for role; any other asset must match the channel's pinned
// digest. Without a digest the artifact is refused (fail closed).
func VerifyReleaseArtifact(artifactURL, artifactPath, expectedDigest, role string) error {
	parsed, err := url.Parse(artifactURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return fmt.Errorf("release artifact URL must be HTTPS")
	}
	parts := strings.Split(strings.TrimPrefix(parsed.Path, "/"), "/")
	if len(parts) == 6 && canonicalCoreTag(parts[4]) {
		return VerifySelectedCoreArtifact(context.Background(), artifactURL, artifactPath, expectedDigest, role)
	}
	if strings.TrimSpace(expectedDigest) == "" {
		return fmt.Errorf("release artifact has no pinned SHA-256 digest")
	}
	if err := VerifyFileSHA256(artifactPath, expectedDigest); err != nil {
		return fmt.Errorf("checksum mismatch: %w", err)
	}
	return nil
}

func verifyArtifactFile(path string, size int64, digest string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, io.LimitReader(f, size+1))
	if err != nil {
		return err
	}
	if n != size || hex.EncodeToString(h.Sum(nil)) != digest {
		return fmt.Errorf("checksum mismatch: artifact does not match its release digest")
	}
	return nil
}

func canonicalCoreTag(tag string) bool {
	return strings.HasPrefix(tag, "youeye-v") && releasecache.ValidCoreVersion(strings.TrimPrefix(tag, "youeye-v"))
}

// Ordinary component downloads still use canonical original member URLs. The
// accepted selected release supplies the private mirror when needed.
type selectedCoreTransport struct{ base http.RoundTripper }

func (t selectedCoreTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	u, err := url.Parse(request.URL.String())
	if err != nil {
		return nil, err
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(parts) != 6 || parts[2] != "releases" || parts[3] != "download" || !canonicalCoreTag(parts[4]) {
		return t.base.RoundTrip(request)
	}
	r, err := readSelectedCore(request.Context())
	if err != nil {
		return nil, err
	}
	transport, err := releasecache.CoreTransport(t.base, r)
	if err != nil {
		return nil, err
	}
	return transport.RoundTrip(request)
}

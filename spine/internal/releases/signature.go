package releases

import (
	"bufio"
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	_ "embed"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
	"io"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strings"
)

//go:embed release-development.pub
var releaseDevelopmentTrust []byte

const releaseMetadataLimit = 1 << 20

// VerifySignedReleaseArtifact verifies the embedded source/channel trust anchor,
// detached Ed25519 checksum signature, exact artifact digest and optional
// channel-bound digest before any release artifact may mutate a runtime.
func VerifySignedReleaseArtifact(client *http.Client, artifactURL, artifactPath, expectedDigest string) error {
	parsed, err := url.Parse(artifactURL)
	if err != nil || parsed.Scheme != "https" && parsed.Scheme != "http" || parsed.Host == "" {
		return fmt.Errorf("release artifact URL is invalid")
	}
	artifactName, err := signedReleaseArtifactName(parsed)
	if err != nil {
		return err
	}
	trustName, embeddedTrust, err := componentReleaseTrust(parsed)
	if err != nil {
		return err
	}
	anchorBlock, _ := pem.Decode(embeddedTrust)
	if anchorBlock == nil {
		return fmt.Errorf("embedded release trust anchor is invalid")
	}
	keyValue, err := x509.ParsePKIXPublicKey(anchorBlock.Bytes)
	publicKey, ok := keyValue.(ed25519.PublicKey)
	if err != nil || !ok {
		return fmt.Errorf("embedded release trust anchor is not Ed25519")
	}
	fetch := func(name string, limit int64) ([]byte, error) {
		candidate, err := signedReleaseSiblingURL(parsed, name)
		if err != nil {
			return nil, err
		}
		response, err := client.Get(candidate)
		if err != nil {
			return nil, err
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("release metadata %s returned status %d", name, response.StatusCode)
		}
		raw, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
		if err != nil || int64(len(raw)) > limit || len(raw) == 0 {
			return nil, fmt.Errorf("release metadata %s is unreadable, empty, or oversized", name)
		}
		return raw, nil
	}
	publishedAnchor, err := fetch(trustName, releaseMetadataLimit)
	if err != nil {
		return err
	}
	if !bytes.Equal(bytes.TrimSpace(publishedAnchor), bytes.TrimSpace(embeddedTrust)) {
		return fmt.Errorf("published release trust anchor does not match the embedded identity")
	}
	checksums, err := fetch("SHA256SUMS", releaseMetadataLimit)
	if err != nil {
		return err
	}
	signature, err := fetch("SHA256SUMS.sig", ed25519.SignatureSize)
	if err != nil || len(signature) != ed25519.SignatureSize || !ed25519.Verify(publicKey, checksums, signature) {
		return fmt.Errorf("release checksum signature is invalid")
	}
	digests := map[string]string{}
	scanner := bufio.NewScanner(bytes.NewReader(checksums))
	for scanner.Scan() {
		parts := strings.SplitN(scanner.Text(), "  ", 2)
		if len(parts) != 2 || len(parts[0]) != sha256.Size*2 || path.Base(parts[1]) != parts[1] || digests[parts[1]] != "" {
			return fmt.Errorf("signed release checksum document is malformed")
		}
		if _, err := hex.DecodeString(parts[0]); err != nil {
			return fmt.Errorf("signed release checksum document contains an invalid digest")
		}
		digests[parts[1]] = parts[0]
	}
	if err := scanner.Err(); err != nil || len(digests) != 4 || digests[artifactName] == "" || digests[trustName] == "" || digests["provenance.json"] == "" || digests["sbom.spdx.json"] == "" {
		return fmt.Errorf("signed release checksum set is incomplete")
	}
	anchorDigest := sha256.Sum256(publishedAnchor)
	if hex.EncodeToString(anchorDigest[:]) != digests[trustName] {
		return fmt.Errorf("published release trust anchor digest is not signed")
	}
	if err := VerifyFileSHA256(artifactPath, digests[artifactName]); err != nil {
		return err
	}
	if strings.TrimSpace(expectedDigest) != "" && !strings.EqualFold(strings.TrimSpace(expectedDigest), digests[artifactName]) {
		return fmt.Errorf("signed artifact digest does not match the exact configured channel digest")
	}
	return nil
}

func signedReleaseArtifactName(artifact *url.URL) (string, error) {
	if artifact == nil || artifact.Scheme == "" || artifact.Host == "" {
		return "", fmt.Errorf("release artifact URL is invalid")
	}
	escaped := artifact.EscapedPath()
	lastSlash := strings.LastIndex(escaped, "/")
	if lastSlash < 0 || lastSlash == len(escaped)-1 {
		return "", fmt.Errorf("release artifact URL has no asset name")
	}
	escapedName := escaped[lastSlash+1:]
	name, err := url.PathUnescape(escapedName)
	if err != nil || name == "" || name == "." || name == ".." || path.Base(name) != name || strings.ContainsAny(name, `/\\`) || strings.TrimSpace(name) != name {
		return "", fmt.Errorf("release artifact asset name is invalid")
	}
	for _, r := range name {
		if r < 0x21 || r == 0x7f {
			return "", fmt.Errorf("release artifact asset name is invalid")
		}
	}
	return name, nil
}

func signedReleaseSiblingURL(artifact *url.URL, name string) (string, error) {
	if artifact == nil || artifact.Scheme == "" || artifact.Host == "" || path.Base(name) != name || name == "." || name == "" {
		return "", fmt.Errorf("release metadata asset name is invalid")
	}
	escaped := artifact.EscapedPath()
	lastSlash := strings.LastIndex(escaped, "/")
	if lastSlash < 0 {
		return "", fmt.Errorf("release artifact URL has no asset path")
	}
	rawPath := escaped[:lastSlash+1] + url.PathEscape(name)
	decodedPath, err := url.PathUnescape(rawPath)
	if err != nil {
		return "", fmt.Errorf("release metadata URL is invalid")
	}
	candidate := *artifact
	candidate.Path = decodedPath
	candidate.RawPath = rawPath
	candidate.RawQuery = ""
	candidate.Fragment = ""
	return candidate.String(), nil
}

var componentPublicTrustAnchor = systemupdate.PublicReleaseTrustAnchor
var publicComponentTag = regexp.MustCompile(`^(?:spine|cp|ui)-(beta-)?v[0-9]+(?:\.[0-9]+)*$`)

func componentReleaseTrust(artifact *url.URL) (string, []byte, error) {
	if artifact.Hostname() != "github.com" {
		return "release-development.pub", releaseDevelopmentTrust, nil
	}
	if artifact.Scheme != "https" || artifact.Host != "github.com" || artifact.User != nil || artifact.RawQuery != "" || artifact.Fragment != "" {
		return "", nil, fmt.Errorf("public component source URL is invalid")
	}
	parts := strings.Split(strings.TrimPrefix(artifact.Path, "/"), "/")
	if len(parts) != 6 || parts[2] != "releases" || parts[3] != "download" {
		return "", nil, fmt.Errorf("public component release URL is invalid")
	}
	match := publicComponentTag.FindStringSubmatch(parts[4])
	if match == nil {
		return "", nil, fmt.Errorf("public component tag has no supported signing channel")
	}
	class := "stable"
	if match[1] != "" {
		class = "beta"
	}
	anchor, err := componentPublicTrustAnchor(class)
	if err != nil {
		return "", nil, err
	}
	return "release-public.pub", anchor, nil
}

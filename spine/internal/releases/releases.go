// Package releases downloads and verifies artifacts of the box's selected
// System release (core-release.json). Locations come from the release
// document and the box's repository; nothing is listed or discovered here.
package releases

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

// NewIPv4Client returns an HTTP client that forces IPv4 connections.
// On fresh VMs without IPv6 routes, Go's default dialer tries AAAA records
// first and hangs until timeout. Forcing tcp4 avoids this entirely.
func NewIPv4Client(timeout time.Duration) *http.Client {
	dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	return &http.Client{
		Timeout: timeout,
		Transport: releasecache.Wrap(&http.Transport{
			DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
				return dialer.DialContext(ctx, "tcp4", addr)
			},
			TLSClientConfig:     &tls.Config{},
			TLSHandshakeTimeout: 10 * time.Second,
			MaxIdleConns:        10,
			IdleConnTimeout:     30 * time.Second,
		}),
	}
}

// coreSelectionRoot holds the installer/host-coordinator accepted release.
var coreSelectionRoot = systemupdate.CoreBootstrapPath

// SelectedCoreArtifact returns the download URL and blob of role in the
// accepted System release.
func SelectedCoreArtifact(role string) (string, releasecache.CoreMember, error) {
	r, _, err := systemupdate.ReadCoreSelection(coreSelectionRoot)
	if err != nil {
		return "", releasecache.CoreMember{}, err
	}
	member, ok := r.Member(role)
	if !ok {
		return "", member, fmt.Errorf("selected System release has no %s member", role)
	}
	location, err := systemupdate.CoreBlobURL(r, member.Artifact)
	return location, member, err
}

// VerifyArtifactFile checks a downloaded file against a blob's size and sha256.
func VerifyArtifactFile(path string, blob releasecache.CoreBlob) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, io.LimitReader(f, blob.SizeBytes+1))
	if err != nil {
		return err
	}
	if n != blob.SizeBytes || hex.EncodeToString(h.Sum(nil)) != blob.SHA256 {
		return fmt.Errorf("checksum mismatch: artifact does not match its release digest")
	}
	return nil
}

// VerifyFileSHA256 checks a file against an expected digest. An empty
// expected digest is refused.
func VerifyFileSHA256(path, expected string) error {
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

package systemupdate

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
)

func TestCoreResolverReadsChannelIndexOnly(t *testing.T) {
	raw, err := os.ReadFile("../../../releasecache/testdata/core-release.json")
	if err != nil {
		t.Fatal(err)
	}
	r, digest, err := releasecache.ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	repository := "https://forge.example/owner/YouEye"
	index, _ := json.Marshal(releasecache.ChannelIndex{Schema: releasecache.ChannelIndexSchema, Channel: "dev", PublishedAt: "2026-11-12T10:00:00Z", Products: map[string]releasecache.ChannelEntry{
		"youeye": {Repository: repository, Tag: r.Tag, Version: r.Version, Build: r.Build, Document: "core-release.json", SHA256: digest},
	}})
	files := map[string][]byte{
		repository + "/releases/download/channel-dev/index.json":          index,
		repository + "/releases/download/" + r.Tag + "/core-release.json": raw,
	}
	status := 0
	var requested []string
	client := &http.Client{Transport: signedRedirectTransport(func(req *http.Request) (*http.Response, error) {
		requested = append(requested, req.URL.String())
		data, ok := files[req.URL.String()]
		code := http.StatusOK
		if !ok {
			code = http.StatusNotFound
		}
		if status != 0 {
			code = status
		}
		return &http.Response{StatusCode: code, Body: io.NopCloser(bytes.NewReader(data)), ContentLength: int64(len(data)), Header: http.Header{}, Request: req}, nil
	})}
	ctx := context.Background()
	selection := CoreReleaseSelection{Repository: repository, Channel: "dev"}
	host, got, gotDigest, err := ResolveCoreRelease(ctx, client, selection)
	if err != nil || gotDigest != digest || got.Version != r.Version || !bytes.Equal(host.Raw, raw) {
		t.Fatal(got.Version, gotDigest, err)
	}
	for _, u := range requested {
		if _, ok := files[u]; !ok {
			t.Fatal("resolver requested an undeclared URL (listing?)", u)
		}
	}
	// A channel with no index yet is an error, not an empty success.
	if _, _, _, err := ResolveCoreRelease(ctx, client, CoreReleaseSelection{Repository: repository, Channel: "alpha"}); !errors.Is(err, releasecache.ErrNotFound) {
		t.Fatal("missing channel index", err)
	}
	// The document must match the index digest.
	files[repository+"/releases/download/"+r.Tag+"/core-release.json"] = append(append([]byte(nil), raw...), ' ')
	if _, _, _, err := ResolveCoreRelease(ctx, client, selection); err == nil {
		t.Fatal("document differing from the index digest accepted")
	}
	status = http.StatusTooManyRequests
	if _, _, _, err := ResolveCoreRelease(ctx, client, selection); !errors.Is(err, releasecache.ErrRateLimited) {
		t.Fatal("rate limit not classified", err)
	}
}

// A download_base in the index moves every file of that release off the
// repository's release-download layout, and is remembered for later blob
// downloads.
func TestDownloadBaseIsRecordedAndUsed(t *testing.T) {
	raw, err := os.ReadFile("../../../releasecache/testdata/core-release.json")
	if err != nil {
		t.Fatal(err)
	}
	r, digest, err := releasecache.ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	oldPath, oldRepo := DownloadBasesPath, BoxRepository
	DownloadBasesPath = filepath.Join(t.TempDir(), "core", "download-bases.json")
	BoxRepository = func() (string, error) { return "https://forge.example/owner/YouEye", nil }
	t.Cleanup(func() { DownloadBasesPath, BoxRepository = oldPath, oldRepo })
	repository, base := "https://forge.example/owner/YouEye", "https://mirror.example/files"
	index, _ := json.Marshal(releasecache.ChannelIndex{Schema: releasecache.ChannelIndexSchema, Channel: "dev", PublishedAt: "2026-11-12T10:00:00Z", Products: map[string]releasecache.ChannelEntry{
		"youeye": {Repository: repository, Tag: r.Tag, Version: r.Version, Build: r.Build, Document: "core-release.json", SHA256: digest, DownloadBase: base},
	}})
	files := map[string][]byte{
		repository + "/releases/download/channel-dev/index.json": index,
		base + "/" + r.Tag + "/core-release.json":                raw,
	}
	client := &http.Client{Transport: signedRedirectTransport(func(req *http.Request) (*http.Response, error) {
		data, ok := files[req.URL.String()]
		if !ok {
			return &http.Response{StatusCode: http.StatusNotFound, Body: io.NopCloser(bytes.NewReader(nil)), Header: http.Header{}, Request: req}, nil
		}
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(bytes.NewReader(data)), ContentLength: int64(len(data)), Header: http.Header{}, Request: req}, nil
	})}
	if _, _, _, err := ResolveCoreRelease(context.Background(), client, CoreReleaseSelection{Repository: repository, Channel: "dev"}); err != nil {
		t.Fatal(err)
	}
	ui, _ := r.Member("ui")
	got, err := CoreBlobURL(r, ui.Artifact)
	if err != nil || got != base+"/"+r.Tag+"/"+ui.Artifact.Name {
		t.Fatalf("blob URL %s %v", got, err)
	}
	// An unreadable record means the repository layout.
	if err := os.WriteFile(DownloadBasesPath, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got, _ := CoreBlobURL(r, ui.Artifact); got != repository+"/releases/download/"+r.Tag+"/"+ui.Artifact.Name {
		t.Fatalf("fallback URL %s", got)
	}
}

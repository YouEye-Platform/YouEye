package systemupdate

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
)

func TestCoreCacheRequiresCapacityAndCompleteDigestBoundBytes(t *testing.T) {
	raw, err := os.ReadFile("../../../releasecache/testdata/core-release.json")
	if err != nil {
		t.Fatal(err)
	}
	r, _, err := releasecache.ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	repository := useBoxRepository(t)
	files := map[string][]byte{}
	for i := range r.Members {
		m := &r.Members[i]
		blob := func(name string, data []byte) releasecache.CoreBlob {
			b := releasecache.CoreBlob{Name: m.Role + "-" + name, SHA256: checksum(data), SizeBytes: int64(len(data))}
			files[releasecache.AssetURL(repository, "", r.Tag, b)] = data
			return b
		}
		artifact := []byte(`{"fixture":"` + m.Role + `"}`)
		if m.Role == "system-a-uki" || m.Role == "system-b-uki" {
			artifact = []byte(`{"fixture":"shared uki"}`)
		}
		m.Artifact = blob(m.Role+".tar", artifact)
		if m.BuildInputs != nil {
			inputs := blob("build-inputs.json", []byte(`{"inputs":"exact"}`))
			m.BuildInputs = &inputs
		}
	}
	raw, _ = json.Marshal(r)
	selection := CoreHostSelection{Raw: raw}
	root := t.TempDir()
	requests := 0
	c := CoreArtifactCache{Root: filepath.Join(root, "cache"),
		AvailableBytes: func(string) (uint64, error) { return 1, nil },
		Client: &http.Client{Transport: signedRedirectTransport(func(req *http.Request) (*http.Response, error) {
			requests++
			data, ok := files[req.URL.String()]
			if !ok {
				return nil, fmt.Errorf("undeclared URL")
			}
			return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(data)), ContentLength: int64(len(data)), Header: http.Header{}, Request: req}, nil
		})},
	}
	if _, _, err := c.Stage(context.Background(), selection); err == nil || requests != 0 {
		t.Fatal("downloaded without complete capacity", requests, err)
	}
	// A no-op downloads nothing.
	if _, digest, err := c.StageUpdate(context.Background(), selection, r); err != nil || digest != checksum(raw) || requests != 0 {
		t.Fatal("no-op downloaded", digest, err, requests)
	}
	c.AvailableBytes = func(string) (uint64, error) { return 1 << 30, nil }
	fresh := c
	fresh.Root = filepath.Join(root, "fresh-public")
	freshRequests := 0
	fresh.Client = &http.Client{Transport: signedRedirectTransport(func(req *http.Request) (*http.Response, error) {
		if !strings.Contains(req.URL.Path, "/spine-") && !strings.Contains(req.URL.Path, "/cp-") && !strings.Contains(req.URL.Path, "/ui-") {
			t.Fatal("fresh service evidence downloaded host/media payload", req.URL.Path)
		}
		freshRequests++
		data, ok := files[req.URL.String()]
		if !ok {
			return nil, fmt.Errorf("undeclared fresh service object")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(data)), ContentLength: int64(len(data)), Header: http.Header{}, Request: req}, nil
	})}
	if _, _, err := fresh.StageFreshServices(context.Background(), selection); err != nil {
		t.Fatal(err)
	}
	beforeFresh := freshRequests
	if beforeFresh == 0 {
		t.Fatal("fresh public path did not retrieve evidence")
	}
	if _, _, err := fresh.StageFreshServices(context.Background(), selection); err != nil || freshRequests != beforeFresh {
		t.Fatal("fresh evidence not reused", err)
	}
	serviceOnly := c
	serviceOnly.Root = filepath.Join(root, "service-only")
	serviceOnly.Client = &http.Client{Transport: signedRedirectTransport(func(req *http.Request) (*http.Response, error) {
		if !strings.Contains(req.URL.Path, "/spine-") && !strings.Contains(req.URL.Path, "/cp-") {
			t.Fatal("service update fetched an unchanged role", req.URL.Path)
		}
		data, ok := files[req.URL.String()]
		if !ok {
			return nil, fmt.Errorf("undeclared service object")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(data)), ContentLength: int64(len(data)), Header: http.Header{}, Request: req}, nil
	})}
	previous := r
	previous.Members = append([]releasecache.CoreMember(nil), r.Members...)
	for i := range previous.Members {
		if previous.Members[i].Role == "cp" {
			previous.Members[i].Artifact.SHA256 = strings.Repeat("a", 64)
		}
	}
	if _, _, err := serviceOnly.StageUpdate(context.Background(), selection, previous); err != nil {
		t.Fatal(err)
	}

	if _, digest, err := c.Stage(context.Background(), selection); err != nil || digest != checksum(raw) {
		t.Fatal(digest, err)
	}
	if requests >= len(files) {
		t.Fatal("identical blobs were not deduplicated", requests, len(files))
	}
	before := requests
	if _, _, err := c.Stage(context.Background(), selection); err != nil || requests != before {
		t.Fatal("exact protected cache was not reused", requests, before, err)
	}
	// Cache corruption cannot be accepted as a completed member or trigger a
	// moving lookup for a convenient replacement release.
	path, _ := c.Path(r.Members[0].Artifact)
	if err := os.WriteFile(path, []byte("changed"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := c.Stage(context.Background(), selection); err == nil || requests != before {
		t.Fatal("corrupt cache was accepted", requests, err)
	}
}

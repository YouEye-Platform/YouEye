package releasecache

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestUncachedVerificationCannotBeSatisfiedByFrozenInstallationObject(t *testing.T) {
	root := t.TempDir()
	t.Setenv("YOUEYE_RELEASE_CACHE", root)
	body := []byte("cached signed payload")
	hash := fmt.Sprintf("%x", sha256.Sum256(body))
	calls := 0
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		_, _ = w.Write([]byte("ordinary network payload"))
	}))
	defer server.Close()
	if err := os.Mkdir(filepath.Join(root, "objects"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "objects", hash), body, 0400); err != nil {
		t.Fatal(err)
	}
	url := server.URL + "/artifact"
	if err := os.WriteFile(filepath.Join(root, "index.json"), []byte(fmt.Sprintf(`{"schema":"youeye.release-cache.v1","objects":{%q:{"sha256":%q,"bytes":%d}}}`, url, hash, len(body))), 0400); err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Transport: Wrap(Wrap(server.Client().Transport))}
	response, err := client.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if string(raw) != string(body) || calls != 0 {
		t.Fatal("ordinary exact cache behavior changed")
	}
	request, _ := http.NewRequestWithContext(UncachedVerification(context.Background()), http.MethodGet, url, nil)
	response, err = client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ = io.ReadAll(response.Body)
	response.Body.Close()
	if string(raw) != "ordinary network payload" || calls != 1 || response.Header.Get("X-YouEye-Release-Transport") == "verified-local-cache" {
		t.Fatal("cold verification bypassed real network transition")
	}
}

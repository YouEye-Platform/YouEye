package releasecache

import (
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestCachedTransportKeepsOriginAndRejectsTampering(t *testing.T) {
	root := t.TempDir()
	t.Setenv("YOUEYE_RELEASE_CACHE", root)
	body := []byte("signed candidate")
	hash := fmt.Sprintf("%x", sha256.Sum256(body))
	os.Mkdir(filepath.Join(root, "objects"), 0700)
	os.WriteFile(filepath.Join(root, "objects", hash), body, 0400)
	source := "https://github.com/example/project/releases/download/cp-v1.2.3/standalone.tar"
	os.WriteFile(filepath.Join(root, "index.json"), []byte(fmt.Sprintf(`{"schema":"youeye.release-cache.v1","objects":{%q:{"sha256":%q,"bytes":%d}}}`, source, hash, len(body))), 0400)
	client := http.Client{Transport: Wrap(nil)}
	r, e := client.Get(source)
	if e != nil {
		t.Fatal(e)
	}
	b, _ := io.ReadAll(r.Body)
	r.Body.Close()
	if string(b) != string(body) || r.Request.URL.String() != source {
		t.Fatal("cache changed identity")
	}
	os.Chmod(filepath.Join(root, "objects", hash), 0600)
	os.WriteFile(filepath.Join(root, "objects", hash), []byte("forged candidate"), 0400)
	if _, e = client.Get(source); e == nil {
		t.Fatal("tampered cache accepted")
	}
}
func TestNoCacheRetainsNormalHTTP(t *testing.T) {
	t.Setenv("YOUEYE_RELEASE_CACHE", filepath.Join(t.TempDir(), "missing"))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("network")) }))
	defer server.Close()
	client := http.Client{Transport: Wrap(nil)}
	r, e := client.Get(server.URL)
	if e != nil {
		t.Fatal(e)
	}
	defer r.Body.Close()
	b, _ := io.ReadAll(r.Body)
	if string(b) != "network" {
		t.Fatal("normal transport changed")
	}
}

func TestEmptyCacheIsExplicitNetworkPassthrough(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "index.json"), []byte(`{"schema":"youeye.release-cache.v1","objects":{}}`), 0400); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(root); err != nil {
		t.Fatal(err)
	}
	if _, _, err := Open(root, "https://example.test/unmapped"); !os.IsNotExist(err) {
		t.Fatalf("empty cache blocked normal transport: %v", err)
	}
}

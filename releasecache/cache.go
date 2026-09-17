// Package releasecache provides optional exact-URL transport for staged signed
// releases. It never changes source identity, trust or artifact verification.
package releasecache

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

const DefaultRoot = "/var/lib/youeye-state/release-cache"

type Object struct {
	SHA256 string `json:"sha256"`
	Bytes  int64  `json:"bytes"`
}
type Index struct {
	Schema  string            `json:"schema"`
	Objects map[string]Object `json:"objects"`
}

func Root() string {
	if root := os.Getenv("YOUEYE_RELEASE_CACHE"); root != "" {
		return root
	}
	return DefaultRoot
}
func validDigest(v string) bool {
	if len(v) != 64 {
		return false
	}
	_, e := hex.DecodeString(v)
	return e == nil && v == strings.ToLower(v)
}
func Load(root string) (Index, error) {
	var index Index
	info, e := os.Lstat(filepath.Join(root, "index.json"))
	if e != nil {
		return index, e
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0022 != 0 || info.Size() > 1<<20 {
		return index, fmt.Errorf("release cache index is not a protected regular file")
	}
	raw, e := os.ReadFile(filepath.Join(root, "index.json"))
	if e != nil {
		return index, e
	}
	if e = json.Unmarshal(raw, &index); e != nil || index.Schema != "youeye.release-cache.v1" || index.Objects == nil {
		return index, fmt.Errorf("invalid release cache index")
	}
	for source, obj := range index.Objects {
		u, err := url.Parse(source)
		if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Fragment != "" || !validDigest(obj.SHA256) || obj.Bytes <= 0 {
			return index, fmt.Errorf("invalid release cache object")
		}
	}
	return index, nil
}

// MediaObjectPath preserves the full digest within ISO9660 filename limits.
func MediaObjectPath(digest string) string {
	if !validDigest(digest) {
		return ""
	}
	return filepath.Join(digest[:16], digest[16:32], digest[32:48], digest[48:])
}

func Open(root, source string) (*os.File, int64, error) {
	return openObject(root, source, false)
}

// OpenMedia verifies an object carried on portable answer media.
func OpenMedia(root, source string) (*os.File, int64, error) {
	return openObject(root, source, true)
}

func openObject(root, source string, media bool) (*os.File, int64, error) {
	index, e := Load(root)
	if e != nil {
		return nil, 0, e
	}
	obj, ok := index.Objects[source]
	if !ok {
		return nil, 0, os.ErrNotExist
	}
	name := obj.SHA256
	if media {
		name = MediaObjectPath(obj.SHA256)
	}
	path := filepath.Join(root, "objects", name)
	info, e := os.Lstat(path)
	if e != nil {
		return nil, 0, fmt.Errorf("cached release object is missing")
	}
	if !info.Mode().IsRegular() || info.Size() != obj.Bytes || info.Mode().Perm()&0022 != 0 {
		return nil, 0, fmt.Errorf("cached release object has invalid size or permissions")
	}
	f, e := os.Open(path)
	if e != nil {
		return nil, 0, e
	}
	h := sha256.New()
	n, e := io.Copy(h, f)
	if e != nil || n != obj.Bytes || hex.EncodeToString(h.Sum(nil)) != obj.SHA256 {
		f.Close()
		return nil, 0, fmt.Errorf("cached release object digest rejected")
	}
	if _, e = f.Seek(0, 0); e != nil {
		f.Close()
		return nil, 0, e
	}
	return f, n, nil
}

type transport struct{ next http.RoundTripper }

func Wrap(next http.RoundTripper) http.RoundTripper {
	if next == nil {
		next = http.DefaultTransport
	}
	return transport{next}
}
func (t transport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.Method != http.MethodGet {
		return t.next.RoundTrip(req)
	}
	f, n, e := Open(Root(), req.URL.String())
	if os.IsNotExist(e) {
		return t.next.RoundTrip(req)
	}
	if e != nil {
		return nil, e
	}
	return &http.Response{StatusCode: 200, Status: "200 OK", Header: http.Header{"Content-Type": []string{"application/octet-stream"}, "X-YouEye-Release-Transport": []string{"verified-local-cache"}}, Body: f, ContentLength: n, Request: req}, nil
}

package releasecache

// Distribution is a signed, API-compatible metadata transport. Original URLs
// remain the source identity; component and appliance verification still run.
import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed distribution-policy.json
var distributionPolicyJSON []byte

type DistributionPolicy struct {
	Schema string            `json:"schema"`
	Origin string            `json:"origin"`
	Keys   map[string]string `json:"keys"`
}
type DistributionEnvelope struct {
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
}
type DistributionCatalog struct {
	Schema       string                            `json:"schema"`
	Channel      string                            `json:"channel"`
	Sequence     int64                             `json:"sequence"`
	IssuedAt     time.Time                         `json:"issued_at"`
	ExpiresAt    time.Time                         `json:"expires_at"`
	Repositories map[string]DistributionRepository `json:"repositories"`
}
type DistributionRepository struct {
	Releases []json.RawMessage `json:"releases"`
	Commits  map[string]string `json:"commits,omitempty"`
}
type distributionEntry struct {
	catalog DistributionCatalog
	digest  string
	fetched time.Time
}

var distributionMu sync.Mutex
var distributionEntries = map[string]distributionEntry{}

func DistributionPolicyFromSource() DistributionPolicy {
	var p DistributionPolicy
	_ = json.Unmarshal(distributionPolicyJSON, &p)
	return p
}

// OfficialMetadataRequest restricts interception to the published first-party
// repositories. Third-party repositories and explicit private providers pass through.
func OfficialMetadataRequest(raw string) (repo, kind, ref string, page, size int, ok bool) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host != "api.github.com" || u.User != nil || u.Fragment != "" {
		return
	}
	p := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(p) < 4 || p[0] != "repos" || p[1] != "YouEye-Platform" {
		return
	}
	switch p[2] {
	case "YouEye", "Market", "Wiki", "Search", "Notes", "Cinema", "Weather", "Translate", "Canvas", "Pointer":
	default:
		return
	}
	repo, kind = p[2], p[3]
	page, size = 1, 30
	q := u.Query()
	for key := range q {
		if key != "per_page" && key != "page" {
			return repo, kind, "", 0, 0, false
		}
	}
	if q.Get("page") != "" {
		page, err = strconv.Atoi(q.Get("page"))
		if err != nil || page < 1 || page > 10000 {
			return repo, kind, "", 0, 0, false
		}
	}
	if q.Get("per_page") != "" {
		size, err = strconv.Atoi(q.Get("per_page"))
		if err != nil || size < 1 || size > 100 {
			return repo, kind, "", 0, 0, false
		}
	}
	switch {
	case kind == "releases" && len(p) == 4:
		ok = true
	case kind == "releases" && len(p) == 6 && p[4] == "tags":
		ref, ok = p[5], true
	case kind == "commits" && len(p) == 5 && repo == "Market":
		ref, ok = p[4], true
	}
	return
}

func VerifyDistribution(raw []byte, channel, publicKey string, now time.Time) (DistributionCatalog, string, error) {
	return verifyDistribution(raw, channel, publicKey, now, false)
}

func verifyDistribution(raw []byte, channel, publicKey string, now time.Time, retained bool) (DistributionCatalog, string, error) {
	var catalog DistributionCatalog
	var envelope DistributionEnvelope
	if len(raw) > 16<<20 || json.Unmarshal(raw, &envelope) != nil {
		return catalog, "", fmt.Errorf("invalid distribution envelope")
	}
	payload, err := base64.StdEncoding.DecodeString(envelope.Payload)
	if err != nil {
		return catalog, "", fmt.Errorf("invalid distribution payload")
	}
	sig, err := base64.StdEncoding.DecodeString(envelope.Signature)
	block, rest := pem.Decode([]byte(publicKey))
	if err != nil || block == nil || len(bytes.TrimSpace(rest)) != 0 {
		return catalog, "", fmt.Errorf("distribution trust is not provisioned")
	}
	key, err := x509.ParsePKIXPublicKey(block.Bytes)
	edkey, ok := key.(ed25519.PublicKey)
	if err != nil || !ok || !ed25519.Verify(edkey, payload, sig) {
		return catalog, "", fmt.Errorf("distribution signature rejected")
	}
	if json.Unmarshal(payload, &catalog) != nil || catalog.Schema != "youeye.distribution.v1" || catalog.Channel != channel || (channel != "stable" && channel != "beta") || catalog.Sequence < 1 || catalog.Repositories == nil {
		return catalog, "", fmt.Errorf("invalid distribution catalog")
	}
	if catalog.IssuedAt.After(now.Add(5*time.Minute)) || (!retained && !catalog.ExpiresAt.After(now)) || !catalog.ExpiresAt.After(catalog.IssuedAt) || catalog.ExpiresAt.Sub(catalog.IssuedAt) > 31*24*time.Hour {
		return catalog, "", fmt.Errorf("distribution metadata expired or clock is incorrect")
	}
	for name, repo := range catalog.Repositories {
		for _, raw := range repo.Releases {
			var r struct {
				Tag        string `json:"tag_name"`
				Draft      bool   `json:"draft"`
				Prerelease bool   `json:"prerelease"`
				Assets     []struct {
					URL string `json:"browser_download_url"`
				} `json:"assets"`
			}
			if json.Unmarshal(raw, &r) != nil || r.Tag == "" || r.Draft || r.Prerelease != (channel == "beta") {
				return catalog, "", fmt.Errorf("distribution release channel mismatch")
			}
			for _, a := range r.Assets {
				u, e := url.Parse(a.URL)
				prefix := "/YouEye-Platform/" + name + "/releases/download/" + r.Tag + "/"
				if e != nil || u.Scheme != "https" || u.Host != "github.com" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || !strings.HasPrefix(u.Path, prefix) || strings.Contains(strings.TrimPrefix(u.Path, prefix), "/") {
					return catalog, "", fmt.Errorf("distribution asset source mismatch")
				}
			}
		}
		for ref, commit := range repo.Commits {
			if name != "Market" || (ref != "main" && ref != "beta" && ref != commit) || len(commit) != 40 || strings.Trim(commit, "0123456789abcdef") != "" || (ref == "main" && channel != "stable") || (ref == "beta" && channel != "beta") {
				return catalog, "", fmt.Errorf("invalid distribution catalog commit")
			}
		}
	}
	digest := sha256.Sum256(payload)
	return catalog, hex.EncodeToString(digest[:]), nil
}

// DistributionBytes never falls back to GitHub when the configured service is
// unavailable or returns invalid metadata. A missing channel is an empty list;
// the existing exact/channel resolver then reports no matching signed release.
func DistributionBytes(ctx context.Context, next http.RoundTripper, policy DistributionPolicy, source string) ([]byte, bool, error) {
	repo, kind, ref, page, size, eligible := OfficialMetadataRequest(source)
	if !eligible || policy.Origin == "" {
		return nil, false, nil
	}
	origin, err := url.Parse(policy.Origin)
	if policy.Schema != "youeye.distribution-policy.v1" || err != nil || origin.Scheme != "https" || origin.Host == "" || origin.User != nil || origin.Path != "" || origin.RawQuery != "" || origin.Fragment != "" || len(policy.Keys) == 0 {
		return nil, true, fmt.Errorf("invalid distribution policy")
	}
	if next == nil {
		next = http.DefaultTransport
	}
	distributionMu.Lock()
	defer distributionMu.Unlock()
	var releases []json.RawMessage
	commits := map[string]string{}
	for _, channel := range []string{"stable", "beta"} {
		key := policy.Keys[channel]
		if key == "" {
			continue
		}
		endpoint := policy.Origin + "/v1/" + channel + ".json"
		keyHash := sha256.Sum256([]byte(key))
		cacheKey := endpoint + fmt.Sprintf("#%x", keyHash)
		entry, exists := distributionEntries[cacheKey]
		now := time.Now().UTC()
		cacheRoot, e := os.UserCacheDir()
		if e != nil {
			return nil, true, e
		}
		if override := os.Getenv("YOUEYE_DISTRIBUTION_STATE"); override != "" {
			cacheRoot = override
		}
		saved := filepath.Join(cacheRoot, "youeye-distribution", "go", fmt.Sprintf("%x.json", sha256.Sum256([]byte(cacheKey))))
		if !exists {
			info, e := os.Lstat(saved)
			if e != nil && !os.IsNotExist(e) {
				return nil, true, e
			}
			if e == nil {
				if !info.Mode().IsRegular() || info.Mode().Perm()&0022 != 0 || info.Size() > 16<<20 {
					return nil, true, fmt.Errorf("invalid distribution cache")
				}
				raw, e := os.ReadFile(saved)
				if e != nil {
					return nil, true, e
				}
				c, d, e := verifyDistribution(raw, channel, key, now, true)
				if e != nil {
					return nil, true, e
				}
				entry, exists = distributionEntry{c, d, info.ModTime()}, true
			}
		}
		if !exists || now.Sub(entry.fetched) >= 15*time.Minute || !entry.catalog.ExpiresAt.After(now) {
			req, e := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
			if e != nil {
				return nil, true, e
			}
			req.Header.Set("User-Agent", "youeye-distribution/1")
			response, e := next.RoundTrip(req)
			if e != nil {
				return nil, true, fmt.Errorf("release distribution unavailable: %w", e)
			}
			raw, e := io.ReadAll(io.LimitReader(response.Body, (16<<20)+1))
			response.Body.Close()
			if e != nil {
				return nil, true, e
			}
			if response.StatusCode == 404 && !exists {
				continue
			}
			if response.StatusCode != 200 {
				return nil, true, fmt.Errorf("release distribution returned HTTP %d", response.StatusCode)
			}
			catalog, digest, e := VerifyDistribution(raw, channel, key, now)
			if e != nil {
				return nil, true, e
			}
			if exists && (catalog.Sequence < entry.catalog.Sequence || (catalog.Sequence == entry.catalog.Sequence && digest != entry.digest)) {
				return nil, true, fmt.Errorf("distribution rollback or sequence conflict rejected")
			}
			if e := saveDistributionEnvelope(saved, raw); e != nil {
				return nil, true, e
			}
			entry = distributionEntry{catalog, digest, now}
			distributionEntries[cacheKey] = entry
		}
		r := entry.catalog.Repositories[repo]
		releases = append(releases, r.Releases...)
		for k, v := range r.Commits {
			commits[k] = v
		}
	}
	if kind == "commits" {
		sha := commits[ref]
		if sha == "" {
			return nil, true, fmt.Errorf("Market commit is not published in release distribution")
		}
		b, e := json.Marshal(map[string]string{"sha": sha})
		return b, true, e
	}
	field := func(b json.RawMessage, k string) string {
		var v map[string]json.RawMessage
		_ = json.Unmarshal(b, &v)
		var s string
		_ = json.Unmarshal(v[k], &s)
		return s
	}
	sort.SliceStable(releases, func(i, j int) bool { return field(releases[i], "published_at") > field(releases[j], "published_at") })
	if ref != "" {
		for _, r := range releases {
			if field(r, "tag_name") == ref {
				return r, true, nil
			}
		}
		return nil, true, fmt.Errorf("exact release is not published in release distribution")
	}
	start := (page - 1) * size
	if start > len(releases) {
		start = len(releases)
	}
	end := start + size
	if end > len(releases) {
		end = len(releases)
	}
	result := releases[start:end]
	if result == nil {
		result = []json.RawMessage{}
	}
	b, e := json.Marshal(result)
	return b, true, e
}

func saveDistributionEnvelope(path string, raw []byte) error {
	if e := os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return e
	}
	f, e := os.CreateTemp(filepath.Dir(path), ".catalog-*")
	if e != nil {
		return e
	}
	defer os.Remove(f.Name())
	if _, e = f.Write(raw); e != nil {
		f.Close()
		return e
	}
	if e = f.Sync(); e != nil {
		f.Close()
		return e
	}
	if e = f.Close(); e != nil {
		return e
	}
	return os.Rename(f.Name(), path)
}

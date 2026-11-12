package api

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"sync"
	"time"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

// The Control Panel finds native apps, Pointer and the Market catalog through
// the box's channel index. Spine owns the repository and channel (protected
// State) and fetches the index; nothing calls a release-listing API.

const releaseIndexTTL = 5 * time.Minute

type releaseIndexCache struct {
	mu      sync.Mutex
	key     string
	fetched time.Time
	index   releasecache.ChannelIndex
	digest  string
	// After a failure the host is not asked again until retry (30 s,
	// doubling up to 10 minutes); the last error is answered meanwhile.
	failures int
	retry    time.Time
	lastErr  error
}

var fetchChannelIndex = func(r *http.Request, repository, channel string) (releasecache.ChannelIndex, []byte, error) {
	// Discovery must never be served from a frozen install-time cache.
	return releasecache.FetchChannelIndex(releasecache.LiveDiscovery(r.Context()), systemupdate.ReleaseHTTPClient(), repository, channel)
}

func (s *Server) releasePolicyPath() string {
	return filepath.Join(s.coreSelectionRoot(), "release-policy.json")
}

func (s *Server) releaseChannelView() (map[string]string, error) {
	policy, err := systemupdate.LoadReleasePolicy(s.releasePolicyPath())
	if err != nil {
		return nil, err
	}
	view := map[string]string{"repository": policy.Repository, "channel": policy.Channel}
	if receipt, err := (systemupdate.CoreManager{Root: s.coreRoot()}).ReadReceipt(); err == nil {
		view["installed_version"] = receipt.Release.Version
		view["installed_build"] = receipt.Release.Build
	}
	return view, nil
}

func (s *Server) handleReleaseChannel(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
	case http.MethodPut:
		var body struct {
			Channel string `json:"channel"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&body) != nil || !releasecache.ValidChannel(body.Channel) {
			errorResponse(w, "channel must be one of dev, alpha, beta, stable", http.StatusBadRequest)
			return
		}
		policy, err := systemupdate.LoadReleasePolicy(s.releasePolicyPath())
		if err != nil {
			errorResponse(w, "release policy unavailable", http.StatusConflict)
			return
		}
		policy.Channel = body.Channel
		if err := systemupdate.SaveReleasePolicy(s.releasePolicyPath(), policy); err != nil {
			errorResponse(w, "could not save the channel", http.StatusInternalServerError)
			return
		}
		s.releaseIndex.mu.Lock()
		s.releaseIndex.key = ""
		s.releaseIndex.mu.Unlock()
	default:
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	view, err := s.releaseChannelView()
	if err != nil {
		errorResponse(w, "release policy unavailable", http.StatusConflict)
		return
	}
	jsonResponse(w, view)
}

// releaseErrorCode classifies a release host failure for the Control Panel.
func releaseErrorCode(err error) (string, string) {
	switch {
	case errors.Is(err, releasecache.ErrRateLimited):
		return "rate_limited", "release host refused or rate-limited the request, retrying"
	case errors.Is(err, releasecache.ErrNotFound):
		return "unavailable", "this channel has no index yet"
	case errors.Is(err, releasecache.ErrInvalidIndex):
		return "invalid", err.Error()
	default:
		return "unavailable", err.Error()
	}
}

func (s *Server) handleReleaseIndex(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	policy, err := systemupdate.LoadReleasePolicy(s.releasePolicyPath())
	if err != nil {
		jsonStatusResponse(w, map[string]string{"error": "release policy unavailable", "code": "invalid"}, http.StatusBadGateway)
		return
	}
	key := policy.Repository + "\x00" + policy.Channel
	c := &s.releaseIndex
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.key != key {
		c.key, c.fetched, c.index, c.digest, c.failures, c.retry, c.lastErr = key, time.Time{}, releasecache.ChannelIndex{}, "", 0, time.Time{}, nil
	}
	if c.fetched.IsZero() || time.Since(c.fetched) > releaseIndexTTL {
		if c.lastErr != nil && time.Now().Before(c.retry) {
			code, message := releaseErrorCode(c.lastErr)
			jsonStatusResponse(w, map[string]string{"error": message, "code": code}, http.StatusBadGateway)
			return
		}
		index, raw, err := fetchChannelIndex(r, policy.Repository, policy.Channel)
		if err != nil {
			c.failures++
			delay := 30 * time.Second << min(c.failures-1, 5)
			if delay > 10*time.Minute {
				delay = 10 * time.Minute
			}
			c.lastErr, c.retry = err, time.Now().Add(delay)
			if c.fetched.IsZero() {
				code, message := releaseErrorCode(err)
				jsonStatusResponse(w, map[string]string{"error": message, "code": code}, http.StatusBadGateway)
				return
			}
			// Keep answering the last good index while the host refuses.
		} else {
			sum := sha256.Sum256(raw)
			c.fetched, c.index, c.digest, c.failures, c.lastErr = time.Now(), index, hex.EncodeToString(sum[:]), 0, nil
		}
	}
	jsonResponse(w, map[string]any{"repository": policy.Repository, "channel": policy.Channel, "index": c.index, "index_sha256": c.digest})
}

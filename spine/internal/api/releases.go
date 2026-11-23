package api

import (
	"context"
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

// The Control Panel finds native apps and Pointer through the box's channel
// index (markets, the official one included, are read from their own
// addresses, not through it). Spine owns the repository and channel
// (protected State) and fetches the index; nothing calls a release-listing API.

// releaseIndexCache is the index the Control Panel is answered from: fetched
// again after releasecache.ChannelIndexTTL plus 0-10 % jitter, so boxes that
// started together do not ask the release host at the same moment.
type releaseIndexCache struct {
	mu      sync.Mutex
	key     string
	fetched time.Time
	expires time.Time
	index   releasecache.ChannelIndex
	digest  string
	// After a failure the host is not asked again until retry (30 s,
	// doubling up to 10 minutes); the last error is answered meanwhile.
	failures int
	retry    time.Time
	lastErr  error
}

// fetchChannelIndex reads the box's channel index. releasecache asks each
// address conditionally (If-None-Match with the ETag of the copy it last
// served), so a refresh of an unchanged index is a 304; tests replace it.
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
	}
	return view, nil
}

// firstDeployMarker exists once the first deploy finished; tests replace it.
func (s *Server) firstDeployMarker() string {
	if s.firstDeployCompletePath != "" {
		return s.firstDeployCompletePath
	}
	return systemupdate.FirstDeployCompletePath
}

// handleReleaseChannel shows and changes what the box follows. A PUT changes
// the channel and, with "repository", the repository: the one path through
// the API that changes the release root (owner, 2026-11-23). It is the CLI's
// `youeye channel set --repository` (systemupdate.SetReleaseSource): the
// target's channel index is read first, the change is refused before the
// first deploy, and the box never downgrades. The Control Panel lets only
// admins call it.
func (s *Server) handleReleaseChannel(w http.ResponseWriter, r *http.Request) {
	view := map[string]string{}
	switch r.Method {
	case http.MethodGet:
	case http.MethodPut:
		var body struct {
			Channel    string `json:"channel"`
			Repository string `json:"repository,omitempty"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&body) != nil || !releasecache.ValidChannel(body.Channel) {
			errorResponse(w, "channel must be one of dev, alpha, beta, stable", http.StatusBadRequest)
			return
		}
		if _, err := systemupdate.LoadReleasePolicy(s.releasePolicyPath()); err != nil {
			errorResponse(w, "release policy unavailable", http.StatusConflict)
			return
		}
		read := func(ctx context.Context, repository, channel string) (releasecache.ChannelIndex, error) {
			index, _, err := fetchChannelIndex(r.WithContext(ctx), repository, channel)
			return index, err
		}
		source, err := systemupdate.SetReleaseSource(r.Context(), systemupdate.ReleaseSourceChange{PolicyPath: s.releasePolicyPath(),
			FirstDeployMarker: s.firstDeployMarker(), CoreRoot: s.coreRoot(), Channel: body.Channel, Repository: body.Repository, Read: read})
		if err != nil {
			errorResponse(w, err.Error(), releaseSourceStatus(err))
			return
		}
		s.releaseIndex.mu.Lock()
		s.releaseIndex.key = ""
		s.releaseIndex.mu.Unlock()
		if source.RepositoryChanged {
			view["head_version"] = source.Head
		}
	default:
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	current, err := s.releaseChannelView()
	if err != nil {
		errorResponse(w, "release policy unavailable", http.StatusConflict)
		return
	}
	for key, value := range current {
		view[key] = value
	}
	jsonResponse(w, view)
}

// releaseSourceStatus is the HTTP status of a refused release source change.
func releaseSourceStatus(err error) int {
	switch {
	case errors.Is(err, systemupdate.ErrReleaseSourceInvalid):
		return http.StatusBadRequest
	case errors.Is(err, systemupdate.ErrReleaseSourceTooEarly), errors.Is(err, systemupdate.ErrReleaseSourceChanged):
		return http.StatusConflict
	case errors.Is(err, systemupdate.ErrReleaseSourceUnreachable):
		return http.StatusBadGateway
	case errors.Is(err, systemupdate.ErrReleaseSourceRefused):
		return http.StatusUnprocessableEntity
	default:
		return http.StatusInternalServerError
	}
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
		c.key, c.fetched, c.expires, c.index, c.digest, c.failures, c.retry, c.lastErr = key, time.Time{}, time.Time{}, releasecache.ChannelIndex{}, "", 0, time.Time{}, nil
	}
	backingOff := c.lastErr != nil && time.Now().Before(c.retry)
	if (c.fetched.IsZero() || !time.Now().Before(c.expires)) && !backingOff {
		index, raw, err := fetchChannelIndex(r, policy.Repository, policy.Channel)
		if err != nil {
			c.failures++
			delay := 30 * time.Second << min(c.failures-1, 5)
			if delay > 10*time.Minute {
				delay = 10 * time.Minute
			}
			// The last good index (if any) is answered while the host refuses.
			c.lastErr, c.retry = err, time.Now().Add(delay)
		} else {
			// A 304 is a successful refresh too: the copy is current, and the next one is due a full TTL later.
			sum := sha256.Sum256(raw)
			now := time.Now()
			c.fetched, c.expires, c.index, c.digest, c.failures, c.lastErr = now, releasecache.NextChannelIndexCheck(now), index, hex.EncodeToString(sum[:]), 0, nil
		}
	}
	if c.fetched.IsZero() {
		// Nothing good yet: the last error, also during the back-off.
		code, message := releaseErrorCode(c.lastErr)
		jsonStatusResponse(w, map[string]string{"error": message, "code": code}, http.StatusBadGateway)
		return
	}
	jsonResponse(w, map[string]any{"repository": policy.Repository, "channel": policy.Channel, "index": c.index, "index_sha256": c.digest})
}

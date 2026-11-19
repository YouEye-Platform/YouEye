package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"net/url"
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

const releaseIndexTTL = 5 * time.Minute

// releaseIndexJitter is the most added to releaseIndexTTL each time the index is fetched (0-10 %), so boxes that
// started together drift apart instead of asking the release host at the same moment.
const releaseIndexJitter = 0.10

// releaseIndexRand is [0, 1); tests replace it.
var releaseIndexRand = rand.Float64

func releaseIndexExpiry(now time.Time) time.Time {
	return now.Add(releaseIndexTTL + time.Duration(releaseIndexRand()*releaseIndexJitter*float64(releaseIndexTTL)))
}

// channelIndexLimit is the size releasecache allows a channel index (FetchChannelIndex, ParseChannelIndex).
const channelIndexLimit = 256 << 10

type releaseIndexCache struct {
	mu      sync.Mutex
	key     string
	fetched time.Time
	expires time.Time
	index   releasecache.ChannelIndex
	digest  string
	// The last good answer of each index address with its ETag, so the next fetch asks "changed since?"
	// (If-None-Match) and a 304 keeps that address's copy.
	copies map[string]channelIndexCopy
	// After a failure the host is not asked again until retry (30 s,
	// doubling up to 10 minutes); the last error is answered meanwhile.
	failures int
	retry    time.Time
	lastErr  error
}

// channelIndexCopy is a channel index as one address served it.
type channelIndexCopy struct {
	ETag   string
	Index  releasecache.ChannelIndex
	Digest string
}

// fetchChannelIndex returns the index address that answered and its copy (known[address] after a 304).
var fetchChannelIndex = func(r *http.Request, repository, channel string, known map[string]channelIndexCopy) (string, channelIndexCopy, error) {
	// Discovery must never be served from a frozen install-time cache.
	return fetchChannelIndexConditional(releasecache.LiveDiscovery(r.Context()), systemupdate.ReleaseHTTPClient(), releasecache.ChannelIndexURLs(repository, channel), channel, known)
}

// fetchChannelIndexConditional is releasecache.FetchChannelIndex with If-None-Match: it tries each address in order
// (a failure at one is returned only when no later one answered), sends the ETag of that address's last good copy,
// and takes a 304 as "that copy is still current". A changed index is parsed and checked as releasecache does.
func fetchChannelIndexConditional(ctx context.Context, client *http.Client, targets []string, channel string, known map[string]channelIndexCopy) (string, channelIndexCopy, error) {
	if !releasecache.ValidChannel(channel) {
		return "", channelIndexCopy{}, fmt.Errorf("unknown channel %q", channel)
	}
	lastErr := errors.New("no address for the channel index")
	for _, target := range targets {
		previous := known[target]
		raw, etag, notModified, err := getChannelIndex(ctx, client, target, previous.ETag)
		if err != nil {
			lastErr = err
			continue
		}
		if notModified {
			if etag != "" {
				previous.ETag = etag
			}
			return target, previous, nil
		}
		index, err := releasecache.ParseChannelIndex(raw)
		if err == nil && index.Channel != channel {
			err = fmt.Errorf("index at %s is for channel %s", target, index.Channel)
		}
		if err != nil {
			lastErr = fmt.Errorf("%w at %s: %v", releasecache.ErrInvalidIndex, target, err)
			continue
		}
		sum := sha256.Sum256(raw)
		return target, channelIndexCopy{ETag: etag, Index: index, Digest: hex.EncodeToString(sum[:])}, nil
	}
	return "", channelIndexCopy{}, lastErr
}

// getChannelIndex is releasecache.Download with If-None-Match (when etag is set): the body and its ETag, or
// notModified for a 304. Other answers are classified by releasecache.HTTPError.
func getChannelIndex(ctx context.Context, client *http.Client, target, etag string) (raw []byte, newETag string, notModified bool, err error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, "", false, err
	}
	request.Header.Set("User-Agent", "youeye")
	if etag != "" {
		request.Header.Set("If-None-Match", etag)
	}
	response, err := client.Do(request)
	if err != nil {
		var remote *url.Error
		if errors.As(err, &remote) {
			return nil, "", false, fmt.Errorf("download %s: %w", request.URL.Host, remote.Err)
		}
		return nil, "", false, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotModified && etag != "" {
		return nil, response.Header.Get("ETag"), true, nil
	}
	if response.StatusCode != http.StatusOK {
		return nil, "", false, releasecache.HTTPError(response.StatusCode, target)
	}
	if response.ContentLength > channelIndexLimit {
		return nil, "", false, fmt.Errorf("%s exceeds %d bytes", target, channelIndexLimit)
	}
	raw, err = io.ReadAll(io.LimitReader(response.Body, channelIndexLimit+1))
	if err != nil {
		return nil, "", false, err
	}
	if len(raw) > channelIndexLimit || len(raw) == 0 {
		return nil, "", false, fmt.Errorf("%s is empty or exceeds %d bytes", target, channelIndexLimit)
	}
	return raw, response.Header.Get("ETag"), false, nil
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
		c.key, c.fetched, c.expires, c.index, c.digest, c.copies, c.failures, c.retry, c.lastErr = key, time.Time{}, time.Time{}, releasecache.ChannelIndex{}, "", nil, 0, time.Time{}, nil
	}
	backingOff := c.lastErr != nil && time.Now().Before(c.retry)
	if (c.fetched.IsZero() || !time.Now().Before(c.expires)) && !backingOff {
		target, answer, err := fetchChannelIndex(r, policy.Repository, policy.Channel, c.copies)
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
			if c.copies == nil {
				c.copies = map[string]channelIndexCopy{}
			}
			c.copies[target] = answer
			now := time.Now()
			c.fetched, c.expires, c.index, c.digest, c.failures, c.lastErr = now, releaseIndexExpiry(now), answer.Index, answer.Digest, 0, nil
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

package releasecache

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// A channel index (youeye.channel.v1) names the current release of every
// product on one channel. Boxes find releases only through it: one small
// download, never a release-listing API.
const ChannelIndexSchema = "youeye.channel.v1"

// Channels in promotion order.
var Channels = []string{"dev", "alpha", "beta", "stable"}

func ValidChannel(channel string) bool {
	for _, c := range Channels {
		if c == channel {
			return true
		}
	}
	return false
}

// Product ids that may appear in an index.
var Products = []string{"youeye", "pointer", "market", "notes", "wiki", "search", "translate", "weather", "cinema"}

type ChannelIndex struct {
	Schema      string                  `json:"schema"`
	Channel     string                  `json:"channel"`
	PublishedAt string                  `json:"published_at"`
	Products    map[string]ChannelEntry `json:"products"`
}

type ChannelEntry struct {
	Repository string `json:"repository"`
	Tag        string `json:"tag"`
	Version    string `json:"version"`
	Document   string `json:"document"`
	SHA256     string `json:"sha256"`
}

// DocumentURL is where the entry's release document is downloaded.
func (e ChannelEntry) DocumentURL() string {
	return e.Repository + "/releases/download/" + url.PathEscape(e.Tag) + "/" + url.PathEscape(e.Document)
}

func (e ChannelEntry) validate(product string) error {
	repository, err := CanonicalRepository(e.Repository)
	if err != nil || repository != e.Repository {
		return fmt.Errorf("index entry %s: repository must be canonical https://host/owner/repository", product)
	}
	if !ValidCoreVersion(e.Version) || !validReleaseTag(e.Tag) || !installationHash.MatchString(e.SHA256) {
		return fmt.Errorf("index entry %s: invalid tag, version or digest", product)
	}
	switch {
	case product == "youeye":
		if e.Tag != "youeye-v"+e.Version || e.Document != "core-release.json" {
			return fmt.Errorf("index entry youeye must name youeye-v<version>/core-release.json")
		}
	case product == "market":
		if e.Tag != "catalog-v"+e.Version || e.Document != "product-release.json" {
			return fmt.Errorf("index entry market must name catalog-v<version>/product-release.json")
		}
	default:
		if e.Tag != "v"+e.Version || e.Document != "product-release.json" {
			return fmt.Errorf("index entry %s must name v<version>/product-release.json", product)
		}
	}
	return nil
}

func (index ChannelIndex) Validate() error {
	if index.Schema != ChannelIndexSchema || !ValidChannel(index.Channel) {
		return fmt.Errorf("unsupported channel index")
	}
	if _, err := time.Parse(time.RFC3339, index.PublishedAt); err != nil {
		return fmt.Errorf("channel index has no valid published_at")
	}
	known := map[string]bool{}
	for _, p := range Products {
		known[p] = true
	}
	for product, entry := range index.Products {
		if !known[product] {
			return fmt.Errorf("channel index names unknown product %q", product)
		}
		if err := entry.validate(product); err != nil {
			return err
		}
	}
	return nil
}

func ParseChannelIndex(raw []byte) (ChannelIndex, error) {
	var index ChannelIndex
	if len(raw) == 0 || len(raw) > 256<<10 {
		return index, fmt.Errorf("channel index size is invalid")
	}
	if err := uniqueCoreJSON(raw); err != nil {
		return index, err
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(&index); err != nil {
		return index, fmt.Errorf("decode channel index: %w", err)
	}
	return index, index.Validate()
}

// ChannelIndexURLs lists where the index of channel is published for a box
// following repository, in the order to try. The official public channels have
// a copy on releases.youeye.me, tried first.
func ChannelIndexURLs(repository, channel string) []string {
	urls := []string{}
	if repository == OfficialRepository && (channel == "beta" || channel == "stable") {
		urls = append(urls, OfficialIndexHost+"/v1/channels/"+channel+".json")
	}
	return append(urls, repository+"/releases/download/channel-"+channel+"/index.json")
}

// ErrRateLimited marks HTTP 403/429 from a release host. Callers retry with
// backoff and never report it as a network failure.
var ErrRateLimited = errors.New("release host refused or rate-limited the request")

// ErrNotFound marks a definite HTTP 404.
var ErrNotFound = errors.New("release file not found")

// ErrInvalidIndex marks a channel index that was served but is not valid.
var ErrInvalidIndex = errors.New("invalid channel index")

// HTTPError classifies a non-200 response.
func HTTPError(status int, target string) error {
	switch status {
	case http.StatusForbidden, http.StatusTooManyRequests:
		return fmt.Errorf("%w (HTTP %d from %s)", ErrRateLimited, status, hostOf(target))
	case http.StatusNotFound:
		return fmt.Errorf("%w (HTTP 404: %s)", ErrNotFound, target)
	default:
		return fmt.Errorf("release host returned HTTP %d for %s", status, target)
	}
}

func hostOf(target string) string {
	if u, err := url.Parse(target); err == nil && u.Host != "" {
		return u.Host
	}
	return target
}

// Download reads one small release file over HTTPS with a size limit.
func Download(ctx context.Context, client *http.Client, target string, limit int64) ([]byte, error) {
	if client == nil {
		client = http.DefaultClient
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("User-Agent", "youeye")
	response, err := client.Do(request)
	if err != nil {
		var remote *url.Error
		if errors.As(err, &remote) {
			return nil, fmt.Errorf("download %s: %w", hostOf(target), remote.Err)
		}
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, HTTPError(response.StatusCode, target)
	}
	if response.ContentLength > limit {
		return nil, fmt.Errorf("%s exceeds %d bytes", target, limit)
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > limit || len(raw) == 0 {
		return nil, fmt.Errorf("%s is empty or exceeds %d bytes", target, limit)
	}
	return raw, nil
}

// FetchChannelIndex downloads and validates the index for repository/channel.
// It tries each location in order; a rate-limit answer from one location is
// returned only when no later location succeeded.
func FetchChannelIndex(ctx context.Context, client *http.Client, repository, channel string) (ChannelIndex, []byte, error) {
	if !ValidChannel(channel) {
		return ChannelIndex{}, nil, fmt.Errorf("unknown channel %q", channel)
	}
	var lastErr error
	for _, target := range ChannelIndexURLs(repository, channel) {
		raw, err := Download(ctx, client, target, 256<<10)
		if err != nil {
			lastErr = err
			continue
		}
		index, err := ParseChannelIndex(raw)
		if err == nil && index.Channel != channel {
			err = fmt.Errorf("index at %s is for channel %s", target, index.Channel)
		}
		if err != nil {
			lastErr = fmt.Errorf("%w at %s: %v", ErrInvalidIndex, target, err)
			continue
		}
		return index, raw, nil
	}
	return ChannelIndex{}, nil, lastErr
}

// FetchDocument downloads an entry's release document and checks its digest.
func FetchDocument(ctx context.Context, client *http.Client, entry ChannelEntry) ([]byte, error) {
	raw, err := Download(ctx, client, entry.DocumentURL(), 1<<20)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(raw)
	if hex.EncodeToString(sum[:]) != entry.SHA256 {
		return nil, fmt.Errorf("%s of %s differs from the channel index digest", entry.Document, entry.Tag)
	}
	return raw, nil
}

// FetchCoreRelease resolves the youeye entry of a channel for repository and
// returns the verified core-release.json bytes, parsed document and digest.
func FetchCoreRelease(ctx context.Context, client *http.Client, repository, channel string) ([]byte, CoreRelease, string, error) {
	index, _, err := FetchChannelIndex(ctx, client, repository, channel)
	if err != nil {
		return nil, CoreRelease{}, "", err
	}
	entry, ok := index.Products["youeye"]
	if !ok {
		return nil, CoreRelease{}, "", fmt.Errorf("channel %s has no YouEye release yet", channel)
	}
	if entry.Repository != repository {
		return nil, CoreRelease{}, "", fmt.Errorf("channel %s names another YouEye repository", channel)
	}
	raw, err := FetchDocument(ctx, client, entry)
	if err != nil {
		return nil, CoreRelease{}, "", err
	}
	release, digest, err := ParseCoreRelease(raw)
	if err != nil {
		return nil, CoreRelease{}, "", err
	}
	if release.Tag != entry.Tag {
		return nil, CoreRelease{}, "", fmt.Errorf("core-release.json of %s names tag %s", entry.Tag, release.Tag)
	}
	return raw, release, digest, nil
}

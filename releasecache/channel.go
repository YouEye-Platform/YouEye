package releasecache

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
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

// ChannelIndex is read leniently, so a later publisher can extend it without
// cutting older boxes off: unknown keys are ignored, unknown products are
// skipped, and an invalid entry fails only its own product (Invalid). Only a
// different schema name means an incompatible index.
type ChannelIndex struct {
	Schema      string                  `json:"schema"`
	Channel     string                  `json:"channel"`
	PublishedAt string                  `json:"published_at"`
	Products    map[string]ChannelEntry `json:"products"`
	Invalid     map[string]string       `json:"-"`
}

// ChannelEntry names a product's current release (the head). DownloadBase,
// when present, is where the release's files live instead of the
// repository's <repository>/releases/download layout:
// <download_base>/<tag>/<name>. SteppingStones are older releases a box takes
// first when it cannot install the head directly (youeye only).
type ChannelEntry struct {
	Repository     string          `json:"repository"`
	Tag            string          `json:"tag"`
	Version        string          `json:"version"`
	Build          string          `json:"build"`
	Document       string          `json:"document"`
	SHA256         string          `json:"sha256"`
	DownloadBase   string          `json:"download_base,omitempty"`
	SteppingStones []SteppingStone `json:"stepping_stones,omitempty"`
}

// SteppingStone is an intermediate core release. MinimumRelease and
// MinimumReader repeat its document's values so a box can choose a stone
// before downloading it; the document must agree.
type SteppingStone struct {
	Tag            string `json:"tag"`
	Version        string `json:"version"`
	Build          string `json:"build"`
	Document       string `json:"document"`
	SHA256         string `json:"sha256"`
	MinimumRelease string `json:"minimum_release"`
	MinimumReader  int    `json:"minimum_reader"`
	DownloadBase   string `json:"download_base,omitempty"`
}

// Locator returns where the stone's document lives, in the entry's repository.
func (s SteppingStone) Locator(repository string) ChannelEntry {
	return ChannelEntry{Repository: repository, Tag: s.Tag, Version: s.Version, Build: s.Build, Document: s.Document, SHA256: s.SHA256, DownloadBase: s.DownloadBase}
}

// ReleaseFileURL locates a file of the release tag: under base when the index
// names one, else in the repository's release-download layout.
func ReleaseFileURL(repository, base, tag, name string) string {
	if base != "" {
		return base + "/" + url.PathEscape(tag) + "/" + url.PathEscape(name)
	}
	return repository + "/releases/download/" + url.PathEscape(tag) + "/" + url.PathEscape(name)
}

// DocumentURL is where the entry's release document is downloaded.
func (e ChannelEntry) DocumentURL() string {
	return ReleaseFileURL(e.Repository, e.DownloadBase, e.Tag, e.Document)
}

// ValidDownloadBase accepts an absolute HTTPS URL without credentials, query,
// fragment or trailing slash.
func ValidDownloadBase(value string) bool {
	u, err := url.Parse(value)
	// Same rule as the CP's validDownloadBase: a lowercase host and no
	// explicit default port (URL normalisation would change either).
	return err == nil && u.Scheme == "https" && u.Host != "" && u.User == nil && u.RawQuery == "" && u.Fragment == "" &&
		!strings.HasSuffix(value, "/") && len(value) <= 512 && u.String() == value &&
		u.Host == strings.ToLower(u.Host) && u.Port() != "443"
}

func (e ChannelEntry) validate(product string) error {
	repository, err := CanonicalRepository(e.Repository)
	if err != nil || repository != e.Repository {
		return fmt.Errorf("index entry %s: repository must be canonical https://host/owner/repository", product)
	}
	if !ValidCoreVersion(e.Version) || !ValidCoreVersion(e.Build) || !validReleaseTag(e.Tag) || !installationHash.MatchString(e.SHA256) {
		return fmt.Errorf("index entry %s: invalid tag, version or digest", product)
	}
	if e.DownloadBase != "" && !ValidDownloadBase(e.DownloadBase) {
		return fmt.Errorf("index entry %s: download_base must be an HTTPS URL without query", product)
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

func (s SteppingStone) valid() bool {
	return ValidCoreVersion(s.Version) && ValidCoreVersion(s.Build) && s.Tag == "youeye-v"+s.Version &&
		s.Document == "core-release.json" && installationHash.MatchString(s.SHA256) &&
		ValidCoreVersion(s.MinimumRelease) && s.MinimumReader >= 1 &&
		(s.DownloadBase == "" || ValidDownloadBase(s.DownloadBase))
}

func ParseChannelIndex(raw []byte) (ChannelIndex, error) {
	var index ChannelIndex
	if len(raw) == 0 || len(raw) > 256<<10 {
		return index, fmt.Errorf("channel index size is invalid")
	}
	if err := uniqueCoreJSON(raw); err != nil {
		return index, err
	}
	var document struct {
		Schema      string                     `json:"schema"`
		Channel     string                     `json:"channel"`
		PublishedAt string                     `json:"published_at"`
		Products    map[string]json.RawMessage `json:"products"`
	}
	if err := json.Unmarshal(raw, &document); err != nil {
		return index, fmt.Errorf("decode channel index: %w", err)
	}
	if document.Schema != ChannelIndexSchema || !ValidChannel(document.Channel) {
		return index, fmt.Errorf("unsupported channel index")
	}
	if _, err := time.Parse(time.RFC3339, document.PublishedAt); err != nil {
		return index, fmt.Errorf("channel index has no valid published_at")
	}
	index = ChannelIndex{Schema: document.Schema, Channel: document.Channel, PublishedAt: document.PublishedAt,
		Products: map[string]ChannelEntry{}, Invalid: map[string]string{}}
	for _, product := range Products {
		rawEntry, ok := document.Products[product]
		if !ok {
			continue
		}
		// Stones are decoded one by one below, so a malformed stone cannot
		// make the head unreadable.
		var fields struct {
			ChannelEntry
			SteppingStones json.RawMessage `json:"stepping_stones"`
		}
		var stones struct {
			SteppingStones []json.RawMessage `json:"stepping_stones"`
		}
		err := json.Unmarshal(rawEntry, &fields)
		entry := fields.ChannelEntry
		if err != nil {
			index.Invalid[product] = fmt.Sprintf("index entry %s is not readable", product)
			continue
		}
		if err := entry.validate(product); err != nil {
			index.Invalid[product] = err.Error()
			continue
		}
		// One unreadable stone is skipped; the others stay usable.
		if product == "youeye" && json.Unmarshal(rawEntry, &stones) == nil {
			for _, rawStone := range stones.SteppingStones {
				var stone SteppingStone
				if json.Unmarshal(rawStone, &stone) == nil && stone.valid() {
					entry.SteppingStones = append(entry.SteppingStones, stone)
				}
			}
		}
		index.Products[product] = entry
	}
	return index, nil
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

// CoreChoice is the core release a box should install next from its channel.
// Stone is set when the head can't be installed from the box's build and an
// intermediate release was chosen; Head is then the channel head it leads to.
type CoreChoice struct {
	Raw     []byte
	Release CoreRelease
	Digest  string
	Entry   ChannelEntry
	Stone   bool
	Head    ChannelEntry
	// HeadRefused says why the head was not chosen (empty when it was).
	HeadRefused string
}

// ErrNoInstallableRelease means neither the head nor any stepping stone of the
// channel can be installed from the box's build.
var ErrNoInstallableRelease = errors.New("no release on this channel can be installed from this build")

// FetchCoreRelease resolves the head of the youeye entry of a channel for
// repository (fresh installs; boxes use ChooseCoreRelease).
func FetchCoreRelease(ctx context.Context, client *http.Client, repository, channel string) ([]byte, CoreRelease, string, error) {
	choice, err := ChooseCoreRelease(ctx, client, repository, channel, "")
	return choice.Raw, choice.Release, choice.Digest, err
}

// ChooseCoreRelease picks what a box on installedBuild installs next: the
// channel head when its minimum_release and reader allow it, otherwise the
// newest stepping stone that does. A stone's own minimum_release names the
// stone before it, so taking the newest acceptable one never skips a required
// stone. With installedBuild empty only the head is considered.
func ChooseCoreRelease(ctx context.Context, client *http.Client, repository, channel, installedBuild string) (CoreChoice, error) {
	index, _, err := FetchChannelIndex(ctx, client, repository, channel)
	if err != nil {
		return CoreChoice{}, err
	}
	entry, ok := index.Products["youeye"]
	if !ok {
		if reason := index.Invalid["youeye"]; reason != "" {
			return CoreChoice{}, fmt.Errorf("channel %s: %s", channel, reason)
		}
		return CoreChoice{}, fmt.Errorf("channel %s has no YouEye release yet", channel)
	}
	if entry.Repository != repository {
		return CoreChoice{}, fmt.Errorf("channel %s names another YouEye repository", channel)
	}
	raw, release, digest, err := fetchCoreEntry(ctx, client, entry)
	refused := ""
	switch {
	case err == nil && (installedBuild == "" || CompareVersions(release.Compatibility.MinimumRelease, installedBuild) <= 0):
		return CoreChoice{Raw: raw, Release: release, Digest: digest, Entry: entry, Head: entry}, nil
	case err == nil:
		refused = fmt.Sprintf("%s needs build %s or later", entry.Version, release.Compatibility.MinimumRelease)
	case errors.Is(err, ErrNeedsNewerReader) && installedBuild != "":
		refused = fmt.Sprintf("%s: %v", entry.Version, err)
	default:
		return CoreChoice{}, err
	}
	stones := append([]SteppingStone{}, entry.SteppingStones...)
	sort.SliceStable(stones, func(i, j int) bool { return CompareVersions(stones[i].Build, stones[j].Build) > 0 })
	for _, stone := range stones {
		if CompareVersions(stone.Build, installedBuild) <= 0 || stone.MinimumReader > CoreReleaseReader ||
			CompareVersions(stone.MinimumRelease, installedBuild) > 0 {
			continue
		}
		locator := stone.Locator(repository)
		raw, release, digest, err := fetchCoreEntry(ctx, client, locator)
		if err != nil {
			return CoreChoice{}, fmt.Errorf("stepping stone %s: %w", stone.Version, err)
		}
		if release.Compatibility.MinimumRelease != stone.MinimumRelease || release.MinimumReader != stone.MinimumReader {
			return CoreChoice{}, fmt.Errorf("stepping stone %s differs from its channel index entry", stone.Version)
		}
		return CoreChoice{Raw: raw, Release: release, Digest: digest, Entry: locator, Stone: true, Head: entry, HeadRefused: refused}, nil
	}
	return CoreChoice{}, fmt.Errorf("%w: channel %s offers %s, and no stepping stone fits build %s", ErrNoInstallableRelease, channel, refused, installedBuild)
}

// fetchCoreEntry downloads and verifies the core-release.json an entry names.
func fetchCoreEntry(ctx context.Context, client *http.Client, entry ChannelEntry) ([]byte, CoreRelease, string, error) {
	raw, err := FetchDocument(ctx, client, entry)
	if err != nil {
		return nil, CoreRelease{}, "", err
	}
	release, digest, err := ParseCoreRelease(raw)
	if err != nil {
		return nil, CoreRelease{}, "", err
	}
	if release.Tag != entry.Tag || release.Build != entry.Build {
		return nil, CoreRelease{}, "", fmt.Errorf("core-release.json of %s names tag %s build %s, the index build %s", entry.Tag, release.Tag, release.Build, entry.Build)
	}
	return raw, release, digest, nil
}

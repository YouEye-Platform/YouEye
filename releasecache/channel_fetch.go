package releasecache

import (
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"net/http"
	"sync"
	"time"
)

// ChannelIndexTTL is how long a long-running reader (Spine's API) keeps a
// channel index before it asks again; NextChannelIndexCheck adds the jitter.
const ChannelIndexTTL = 5 * time.Minute

// channelIndexJitter is the most added to ChannelIndexTTL (0-10 %), so boxes
// that started together drift apart instead of asking at the same moment.
const channelIndexJitter = 0.10

// channelIndexRand is [0, 1); tests replace it.
var channelIndexRand = rand.Float64

// NextChannelIndexCheck is when an index fetched at now is due again:
// ChannelIndexTTL plus 0-10 % of it.
func NextChannelIndexCheck(now time.Time) time.Time {
	return now.Add(ChannelIndexTTL + time.Duration(channelIndexRand()*channelIndexJitter*float64(ChannelIndexTTL)))
}

// ChannelIndexLimit is the largest channel index a reader accepts.
const ChannelIndexLimit = 256 << 10

// indexCopy is the last good index one address served, with its ETag.
type indexCopy struct {
	etag string
	raw  []byte
}

// channelIndexCopies keeps, per index address, the last good answer that
// came with an ETag, so the next fetch of that address asks "changed since?"
// (If-None-Match) and a 304 answers the kept copy. It lives as long as the
// process: Spine's API and its update checks share it.
var channelIndexCopies = struct {
	sync.Mutex
	byAddress map[string]indexCopy
}{byAddress: map[string]indexCopy{}}

func knownIndexCopy(target string) indexCopy {
	channelIndexCopies.Lock()
	defer channelIndexCopies.Unlock()
	return channelIndexCopies.byAddress[target]
}

func keepIndexCopy(target string, c indexCopy) {
	channelIndexCopies.Lock()
	defer channelIndexCopies.Unlock()
	if c.etag == "" {
		delete(channelIndexCopies.byAddress, target)
		return
	}
	channelIndexCopies.byAddress[target] = c
}

// FetchChannelIndex downloads and validates the index for repository/channel.
// It tries each location in order; a failure at one location is returned only
// when no later location answered. A location that served the index with an
// ETag before is asked with If-None-Match, and a 304 answers its kept copy.
func FetchChannelIndex(ctx context.Context, client *http.Client, repository, channel string) (ChannelIndex, []byte, error) {
	return fetchChannelIndexFrom(ctx, client, ChannelIndexURLs(repository, channel), channel)
}

func fetchChannelIndexFrom(ctx context.Context, client *http.Client, targets []string, channel string) (ChannelIndex, []byte, error) {
	if !ValidChannel(channel) {
		return ChannelIndex{}, nil, fmt.Errorf("unknown channel %q", channel)
	}
	lastErr := errors.New("no address for the channel index")
	for _, target := range targets {
		known := knownIndexCopy(target)
		raw, etag, notModified, err := download(ctx, client, target, ChannelIndexLimit, known.etag)
		if err != nil {
			lastErr = err
			continue
		}
		if notModified {
			raw = known.raw
			if etag == "" {
				etag = known.etag
			}
		}
		// A kept copy is parsed again: every caller gets its own maps.
		index, err := ParseChannelIndex(raw)
		if err == nil && index.Channel != channel {
			err = fmt.Errorf("index at %s is for channel %s", target, index.Channel)
		}
		if err != nil {
			keepIndexCopy(target, indexCopy{})
			lastErr = fmt.Errorf("%w at %s: %v", ErrInvalidIndex, target, err)
			continue
		}
		keepIndexCopy(target, indexCopy{etag: etag, raw: raw})
		return index, raw, nil
	}
	return ChannelIndex{}, nil, lastErr
}

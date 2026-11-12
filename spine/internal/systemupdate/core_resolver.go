package systemupdate

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/youeye-platform/YouEye/releasecache"
)

// CoreReleaseSelection is what a box follows: its repository and channel.
type CoreReleaseSelection struct {
	Repository string
	Channel    string
}

// ErrChannelBehind means the channel head is older than the installed release.
// A box never downgrades; it waits for the channel to catch up.
var ErrChannelBehind = errors.New("channel is behind the installed version")

// ResolveCoreRelease reads the channel index and returns the channel's current
// core-release.json, verified against the index digest. It never lists
// releases.
func ResolveCoreRelease(ctx context.Context, client *http.Client, selection CoreReleaseSelection) (CoreHostSelection, releasecache.CoreRelease, string, error) {
	if client == nil {
		client = ReleaseHTTPClient()
	}
	raw, release, digest, err := releasecache.FetchCoreRelease(releasecache.LiveDiscovery(ctx), client, selection.Repository, selection.Channel)
	if err != nil {
		return CoreHostSelection{}, releasecache.CoreRelease{}, "", err
	}
	return CoreHostSelection{Raw: raw}, release, digest, nil
}

// RefuseDowngrade returns ErrChannelBehind when target is older than installed.
func RefuseDowngrade(channel, installed, target string) error {
	if releasecache.CompareVersions(target, installed) < 0 {
		return fmt.Errorf("%w: channel %s offers %s, installed is %s; waiting for it to catch up", ErrChannelBehind, channel, target, installed)
	}
	return nil
}

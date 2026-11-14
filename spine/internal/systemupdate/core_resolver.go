package systemupdate

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/youeye-platform/YouEye/releasecache"
)

// CoreReleaseSelection is what a box follows: its repository and channel.
// InstalledBuild, when known, lets resolution choose a stepping stone if the
// channel head can't be installed from it.
type CoreReleaseSelection struct {
	Repository     string
	Channel        string
	InstalledBuild string
}

// ErrChannelBehind means the channel head is older than the installed release.
// A box never downgrades; it waits for the channel to catch up.
var ErrChannelBehind = errors.New("channel is behind the installed version")

// ResolveCoreRelease reads the channel index and returns the release this box
// installs next (the head, or a stepping stone), verified against the index
// digest. It never lists releases.
func ResolveCoreRelease(ctx context.Context, client *http.Client, selection CoreReleaseSelection) (CoreHostSelection, releasecache.CoreRelease, string, error) {
	choice, err := ResolveCoreChoice(ctx, client, selection)
	return CoreHostSelection{Raw: choice.Raw}, choice.Release, choice.Digest, err
}

// ResolveCoreChoice is ResolveCoreRelease with the stepping-stone details, and
// records where the chosen release's files live.
func ResolveCoreChoice(ctx context.Context, client *http.Client, selection CoreReleaseSelection) (releasecache.CoreChoice, error) {
	if client == nil {
		client = ReleaseHTTPClient()
	}
	choice, err := releasecache.ChooseCoreRelease(releasecache.LiveDiscovery(ctx), client, selection.Repository, selection.Channel, selection.InstalledBuild)
	if err != nil {
		return releasecache.CoreChoice{}, err
	}
	if err := RecordDownloadBase(choice.Release.Tag, choice.Entry.DownloadBase); err != nil {
		return releasecache.CoreChoice{}, fmt.Errorf("record download location: %w", err)
	}
	return choice, nil
}

// RefuseDowngrade returns ErrChannelBehind when target is an older build than
// installed. Builds are compared, never release names: the same build under
// another channel's name is not older.
func RefuseDowngrade(channel string, installed, target releasecache.CoreRelease) error {
	if releasecache.CompareVersions(target.Build, installed.Build) < 0 {
		return fmt.Errorf("%w: channel %s offers %s (build %s), installed is %s (build %s); waiting for it to catch up",
			ErrChannelBehind, channel, target.Version, target.Build, installed.Version, installed.Build)
	}
	return nil
}

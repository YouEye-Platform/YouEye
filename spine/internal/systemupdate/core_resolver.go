package systemupdate

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/youeye-platform/YouEye/releasecache"
)

// CoreReleaseSelection is what a box follows (its repository and channel) and
// what it holds. Installed is the ordering key of the installed release, from
// the committed receipt, and InstalledVersion its name (for messages). They
// decide whether the channel head can be installed or a stepping stone comes
// first. FreshInstall says that nothing is installed yet, so only the head is
// considered; it is never inferred from an empty Installed.
type CoreReleaseSelection struct {
	Repository       string
	Channel          string
	Installed        releasecache.ReleaseKey
	InstalledVersion string
	FreshInstall     bool
}

// WithInstalled returns the selection of a box that holds r.
func (s CoreReleaseSelection) WithInstalled(r releasecache.CoreRelease) CoreReleaseSelection {
	s.Installed, s.InstalledVersion, s.FreshInstall = r.Key(), r.Version, false
	return s
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
	choice, err := releasecache.ChooseCoreRelease(releasecache.LiveDiscovery(ctx), client, selection.Repository, selection.Channel,
		releasecache.InstalledRelease{Fresh: selection.FreshInstall, Key: selection.Installed, Version: selection.InstalledVersion})
	if err != nil {
		return releasecache.CoreChoice{}, err
	}
	if err := RecordDownloadBase(choice.Release.Tag, choice.Entry.DownloadBase); err != nil {
		return releasecache.CoreChoice{}, fmt.Errorf("record download location: %w", err)
	}
	return choice, nil
}

// RefuseDowngrade returns ErrChannelBehind when target is an older release
// than installed: an older line, or an earlier build of the same line. Names
// are never compared: the same build under another channel's name is not
// older, and a stable 0.6.13 is older than a later 0.6.13-dev build.
func RefuseDowngrade(channel string, installed, target releasecache.CoreRelease) error {
	if releasecache.CompareReleases(target.Key(), installed.Key()) < 0 {
		return fmt.Errorf("%w: channel %s offers %s; this box has %s; waiting for it to catch up",
			ErrChannelBehind, channel, target.Version, installed.Version)
	}
	return nil
}

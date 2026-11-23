package systemupdate

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/youeye-platform/YouEye/releasecache"
)

// FirstDeployCompletePath exists once the first deploy finished. Before it,
// first boot binds the repository it was installed from (core_first_boot.go).
const FirstDeployCompletePath = "/var/lib/youeye-state/first-deploy/complete"

// Why a release source change was refused. The Spine API maps them to HTTP
// statuses; the messages are shown to the person who asked.
var (
	ErrReleaseSourceInvalid     = errors.New("invalid release source")
	ErrReleaseSourceTooEarly    = errors.New("the repository can change only after the first deploy finished")
	ErrReleaseSourceUnreachable = errors.New("release source unreachable")
	ErrReleaseSourceRefused     = errors.New("release source refused")
	ErrReleaseSourceChanged     = errors.New("the release policy changed meanwhile; look again and retry")
)

// ChannelIndexReader reads a channel index of repository. The CLI and the
// Spine API pass their own (same client and discovery); tests pass stubs.
type ChannelIndexReader func(ctx context.Context, repository, channel string) (releasecache.ChannelIndex, error)

// LiveChannelIndex reads an index the way the Spine API does: never from a
// frozen install-time cache.
func LiveChannelIndex(ctx context.Context, repository, channel string) (releasecache.ChannelIndex, error) {
	index, _, err := releasecache.FetchChannelIndex(releasecache.LiveDiscovery(ctx), ReleaseHTTPClient(), repository, channel)
	return index, err
}

// ReleaseSource is what the box follows after SetReleaseSource.
type ReleaseSource struct {
	Policy ReleasePolicy
	// RepositoryChanged says the repository changed (and its index was read).
	RepositoryChanged bool
	// Head is the YouEye version the new repository's channel offers now; set
	// only when the repository changed.
	Head string
}

// ReleaseSourceChange is one request to change what the box follows.
type ReleaseSourceChange struct {
	PolicyPath        string // release-policy.json
	FirstDeployMarker string // FirstDeployCompletePath on a box
	CoreRoot          string // CoreStatePath on a box: the installed receipt and the update journal
	Channel           string
	Repository        string // "" or the current repository: only the channel changes
	Read              ChannelIndexReader
}

// SetReleaseSource makes the box follow change.Channel and, when
// change.Repository is set and differs from the current one, that repository.
// It is the one place the CLI (`youeye channel set --repository`) and the
// Spine API change the release root, so both refuse the same things:
//   - a repository change before the first deploy finished (marker absent);
//   - a URL that is not a canonical https://host/owner/repository;
//   - a repository whose channel index cannot be read, does not parse, has no
//     youeye entry or names another repository;
//   - a policy that another writer changed while the index was read.
//
// release-policy.json keeps its v1 schema and fields; only repository and
// channel change. Before the switch, the installed release and an update in
// progress are pinned to the old repository's downloads (download-bases.json
// v1), so a redeploy or a stage already under way still finds their files.
// The box never downgrades: the update check compares releases by line and
// sequence, whichever repository offers them.
func SetReleaseSource(ctx context.Context, change ReleaseSourceChange) (ReleaseSource, error) {
	if !releasecache.ValidChannel(change.Channel) {
		return ReleaseSource{}, fmt.Errorf("%w: channel must be one of dev, alpha, beta, stable", ErrReleaseSourceInvalid)
	}
	policy, err := LoadReleasePolicy(change.PolicyPath)
	if err != nil {
		return ReleaseSource{}, err
	}
	before := policy
	out := ReleaseSource{}
	if change.Repository != "" {
		canonical, err := releasecache.CanonicalRepository(change.Repository)
		if err != nil {
			return ReleaseSource{}, fmt.Errorf("%w: %v", ErrReleaseSourceInvalid, err)
		}
		if canonical != policy.Repository {
			if info, err := os.Stat(change.FirstDeployMarker); err != nil || !info.Mode().IsRegular() {
				return ReleaseSource{}, ErrReleaseSourceTooEarly
			}
			head, err := checkReleaseSource(ctx, canonical, change.Channel, change.Read)
			if err != nil {
				return ReleaseSource{}, err
			}
			// The index read can take a while: refuse rather than undo another writer's change.
			if now, err := LoadReleasePolicy(change.PolicyPath); err != nil || now != before {
				return ReleaseSource{}, ErrReleaseSourceChanged
			}
			if err := pinReleaseDownloads(change.CoreRoot, before.Repository); err != nil {
				return ReleaseSource{}, fmt.Errorf("record where the installed release's files live: %w", err)
			}
			policy.Repository, out.RepositoryChanged, out.Head = canonical, true, head
		}
	}
	policy.Channel = change.Channel
	if err := SaveReleasePolicy(change.PolicyPath, policy); err != nil {
		return ReleaseSource{}, err
	}
	out.Policy = policy
	return out, nil
}

// pinReleaseDownloads records the repository's download address for the
// installed release and for the target of the last update journal, unless the
// channel index named one for them already. CoreBlobURL then keeps finding
// their files (a Control Panel redeploy, a Spine adopt, a stage under way)
// after the box follows another repository, which may not hold those tags.
func pinReleaseDownloads(coreRoot, repository string) error {
	m := CoreManager{Root: coreRoot}
	tags := []string{}
	// An unreadable receipt or journal has nothing to pin; it does not block the switch.
	if receipt, err := m.ReadReceipt(); err == nil {
		tags = append(tags, receipt.Release.Tag)
	}
	if journal, err := m.Read(); err == nil && journal.Target.Tag != "" {
		tags = append(tags, journal.Target.Tag)
	}
	base := repository + "/releases/download"
	for _, tag := range tags {
		if BoxDownloadBase(tag) != "" {
			continue
		}
		if err := RecordDownloadBase(tag, base); err != nil {
			return err
		}
	}
	return nil
}

// checkReleaseSource reads the channel index of repository once and returns
// its YouEye head version.
func checkReleaseSource(ctx context.Context, repository, channel string, read ChannelIndexReader) (string, error) {
	index, err := read(ctx, repository, channel)
	switch {
	case errors.Is(err, releasecache.ErrNotFound):
		return "", fmt.Errorf("%w: %s has no %s channel index", ErrReleaseSourceRefused, repository, channel)
	case errors.Is(err, releasecache.ErrInvalidIndex):
		return "", fmt.Errorf("%w: the %s channel index of %s is not valid", ErrReleaseSourceRefused, channel, repository)
	case err != nil:
		return "", fmt.Errorf("%w: could not read the %s channel index of %s: %v", ErrReleaseSourceUnreachable, channel, repository, err)
	}
	entry, ok := index.Products["youeye"]
	if !ok {
		if reason := index.Invalid["youeye"]; reason != "" {
			return "", fmt.Errorf("%w: the %s channel of %s has an unreadable YouEye release: %s", ErrReleaseSourceRefused, channel, repository, reason)
		}
		return "", fmt.Errorf("%w: the %s channel of %s has no YouEye release", ErrReleaseSourceRefused, channel, repository)
	}
	if entry.Repository != repository {
		return "", fmt.Errorf("%w: the %s channel index of %s names another repository (%s)", ErrReleaseSourceRefused, channel, repository, entry.Repository)
	}
	return entry.Version, nil
}

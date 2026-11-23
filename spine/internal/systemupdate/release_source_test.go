package systemupdate

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
)

const (
	sourceTestOld = "https://github.com/YouEye-Platform/YouEye"
	sourceTestNew = "https://forge.example.org/team/YouEye"
)

type releaseSourceFixture struct {
	change ReleaseSourceChange
	tag    string // the installed release's tag
}

// newReleaseSourceFixture is a deployed box on sourceTestOld stable with an
// installed receipt and no recorded download bases.
func newReleaseSourceFixture(t *testing.T) *releaseSourceFixture {
	t.Helper()
	dir := t.TempDir()
	f := &releaseSourceFixture{change: ReleaseSourceChange{
		PolicyPath: filepath.Join(dir, "release-policy.json"), FirstDeployMarker: filepath.Join(dir, "complete"),
		CoreRoot: filepath.Join(dir, "core"), Channel: "alpha", Repository: sourceTestNew,
		Read: func(_ context.Context, repository, channel string) (releasecache.ChannelIndex, error) {
			return releasecache.ChannelIndex{Channel: channel, Products: map[string]releasecache.ChannelEntry{"youeye": {Repository: repository, Version: "0.6.16"}}}, nil
		},
	}}
	policy := ReleasePolicy{Schema: ReleasePolicySchema, Repository: sourceTestOld, Channel: "stable", CoreManifestSHA256: strings.Repeat("a", 64)}
	if err := SaveReleasePolicy(f.change.PolicyPath, policy); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.change.FirstDeployMarker, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile("../../../releasecache/testdata/core-release.json")
	if err != nil {
		t.Fatal(err)
	}
	release, digest, err := releasecache.ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	f.tag = release.Tag
	if err := os.MkdirAll(filepath.Join(f.change.CoreRoot, "targets"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.change.CoreRoot, "targets", digest+".json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	receipt, _ := json.Marshal(CoreReceipt{ManifestSHA256: digest, Release: release, AcceptedAt: "fixture", Evidence: "fixture",
		Machine: CoreMachineIdentity{InstallIDRef: "i", DeviceIDRef: "d", ParentDiskID: "p", StatePartUUID: "s", DataPartUUID: "x"}})
	if err := os.WriteFile(filepath.Join(f.change.CoreRoot, "committed.json"), receipt, 0o600); err != nil {
		t.Fatal(err)
	}
	oldBases := DownloadBasesPath
	DownloadBasesPath = filepath.Join(dir, "download-bases.json")
	t.Cleanup(func() { DownloadBasesPath = oldBases })
	return f
}

// After a switch the installed release's files are still fetched from the
// repository it came from: the new one may not hold that tag.
func TestSetReleaseSourcePinsTheInstalledReleaseToItsRepository(t *testing.T) {
	f := newReleaseSourceFixture(t)
	if _, err := (CoreManager{Root: f.change.CoreRoot}).ReadReceipt(); err != nil {
		t.Fatal("fixture receipt:", err)
	}
	source, err := SetReleaseSource(context.Background(), f.change)
	if err != nil || !source.RepositoryChanged || source.Policy.Repository != sourceTestNew || source.Head != "0.6.16" {
		t.Fatal(source, err)
	}
	if got := BoxDownloadBase(f.tag); got != sourceTestOld+"/releases/download" {
		t.Fatalf("download base of %s = %q", f.tag, got)
	}
	blob := releasecache.CoreBlob{Name: "spine-linux-amd64"}
	if got := releasecache.AssetURL(sourceTestNew, BoxDownloadBase(f.tag), f.tag, blob); !strings.HasPrefix(got, sourceTestOld+"/releases/download/"+f.tag+"/") {
		t.Fatalf("installed files now come from %s", got)
	}
	// Back to the first repository: a pinned tag keeps its base.
	f.change.Repository, f.change.Channel = sourceTestOld, "stable"
	if _, err := SetReleaseSource(context.Background(), f.change); err != nil || BoxDownloadBase(f.tag) != sourceTestOld+"/releases/download" {
		t.Fatal(err, BoxDownloadBase(f.tag))
	}
}

func TestSetReleaseSourceKeepsABaseTheIndexNamed(t *testing.T) {
	f := newReleaseSourceFixture(t)
	if err := RecordDownloadBase(f.tag, "https://releases.example.org/files"); err != nil {
		t.Fatal(err)
	}
	if _, err := SetReleaseSource(context.Background(), f.change); err != nil || BoxDownloadBase(f.tag) != "https://releases.example.org/files" {
		t.Fatal(err, BoxDownloadBase(f.tag))
	}
}

func TestSetReleaseSourceRefusals(t *testing.T) {
	t.Run("changed while the index was read", func(t *testing.T) {
		f := newReleaseSourceFixture(t)
		read := f.change.Read
		f.change.Read = func(ctx context.Context, repository, channel string) (releasecache.ChannelIndex, error) {
			policy, _ := LoadReleasePolicy(f.change.PolicyPath)
			policy.Channel = "beta" // another admin, meanwhile
			if err := SaveReleasePolicy(f.change.PolicyPath, policy); err != nil {
				t.Fatal(err)
			}
			return read(ctx, repository, channel)
		}
		if _, err := SetReleaseSource(context.Background(), f.change); !errors.Is(err, ErrReleaseSourceChanged) {
			t.Fatal(err)
		}
		if policy, _ := LoadReleasePolicy(f.change.PolicyPath); policy.Repository != sourceTestOld || policy.Channel != "beta" {
			t.Fatal("the other writer's change was undone", policy)
		}
		if _, err := os.Stat(DownloadBasesPath); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("a refused switch pinned downloads")
		}
	})
	t.Run("marker is not a file", func(t *testing.T) {
		f := newReleaseSourceFixture(t)
		_ = os.Remove(f.change.FirstDeployMarker)
		if err := os.Mkdir(f.change.FirstDeployMarker, 0o700); err != nil {
			t.Fatal(err)
		}
		if _, err := SetReleaseSource(context.Background(), f.change); !errors.Is(err, ErrReleaseSourceTooEarly) {
			t.Fatal(err)
		}
	})
	t.Run("refused index pins nothing", func(t *testing.T) {
		f := newReleaseSourceFixture(t)
		f.change.Read = func(context.Context, string, string) (releasecache.ChannelIndex, error) {
			return releasecache.ChannelIndex{}, errors.New("no route to host")
		}
		if _, err := SetReleaseSource(context.Background(), f.change); !errors.Is(err, ErrReleaseSourceUnreachable) {
			t.Fatal(err)
		}
		if _, err := os.Stat(DownloadBasesPath); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("a refused switch pinned downloads")
		}
	})
	t.Run("only the channel needs no marker, read or pin", func(t *testing.T) {
		f := newReleaseSourceFixture(t)
		_ = os.Remove(f.change.FirstDeployMarker)
		f.change.Repository, f.change.Read = sourceTestOld+".git", nil
		if source, err := SetReleaseSource(context.Background(), f.change); err != nil || source.RepositoryChanged || source.Policy.Channel != "alpha" {
			t.Fatal(source, err)
		}
		if _, err := os.Stat(DownloadBasesPath); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("a channel change pinned downloads")
		}
	})
}

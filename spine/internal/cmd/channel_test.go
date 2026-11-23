package cmd

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

const (
	channelTestGitHub  = "https://github.com/YouEye-Platform/YouEye"
	channelTestForgejo = "https://forge.example.org/team/YouEye"
)

type channelFixture struct {
	path   string
	marker string
	reads  []string
	index  func(repository, channel string) (releasecache.ChannelIndex, error)
}

// newChannelFixture is a deployed box on GitHub stable whose `channel set`
// reads indexes from f.index.
func newChannelFixture(t *testing.T) *channelFixture {
	t.Helper()
	dir := t.TempDir()
	f := &channelFixture{path: filepath.Join(dir, "release-policy.json"), marker: filepath.Join(dir, "complete")}
	policy := systemupdate.ReleasePolicy{Schema: systemupdate.ReleasePolicySchema, Repository: channelTestGitHub, Channel: "stable", CoreManifestSHA256: strings.Repeat("a", 64), ServiceSelection: "sealed"}
	if err := systemupdate.SaveReleasePolicy(f.path, policy); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.marker, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	f.index = func(repository, channel string) (releasecache.ChannelIndex, error) {
		return releasecache.ChannelIndex{Channel: channel, Products: map[string]releasecache.ChannelEntry{
			"youeye": {Repository: repository, Version: "0.6.16-" + channel + ".2"}}}, nil
	}
	oldPath, oldMarker, oldReader, oldCore, oldBases := channelPolicyPath, channelFirstDeployMarker, channelIndexReader, channelCoreRoot, systemupdate.DownloadBasesPath
	channelPolicyPath, channelFirstDeployMarker = f.path, f.marker
	channelCoreRoot, systemupdate.DownloadBasesPath = filepath.Join(dir, "core"), filepath.Join(dir, "download-bases.json")
	channelIndexReader = func(_ context.Context, repository, channel string) (releasecache.ChannelIndex, error) {
		f.reads = append(f.reads, repository+" "+channel)
		return f.index(repository, channel)
	}
	t.Cleanup(func() {
		channelPolicyPath, channelFirstDeployMarker, channelIndexReader = oldPath, oldMarker, oldReader
		channelCoreRoot, systemupdate.DownloadBasesPath = oldCore, oldBases
	})
	return f
}

func (f *channelFixture) set(args ...string) (string, error) {
	set, _, err := channelCmd.Find([]string{"set"})
	if err != nil {
		return "", err
	}
	var out bytes.Buffer
	set.SetOut(&out)
	// pflag keeps flag values between parses of the same command.
	if err := set.Flags().Set("repository", ""); err != nil {
		return "", err
	}
	if err := set.Flags().Parse(args); err != nil {
		return "", err
	}
	if err := set.ValidateArgs(set.Flags().Args()); err != nil {
		return "", err
	}
	err = set.RunE(set, set.Flags().Args())
	return out.String(), err
}

func (f *channelFixture) policy(t *testing.T) systemupdate.ReleasePolicy {
	t.Helper()
	policy, err := systemupdate.LoadReleasePolicy(f.path)
	if err != nil {
		t.Fatal(err)
	}
	return policy
}

func TestChannelSetChangesOnlyTheChannel(t *testing.T) {
	f := newChannelFixture(t)
	want := f.policy(t)
	for _, channel := range []string{"dev", "alpha", "beta", "stable"} {
		out, err := f.set(channel)
		want.Channel = channel
		if err != nil || f.policy(t) != want || !strings.Contains(out, "never downgrades") {
			t.Fatalf("%s: %v %q %+v", channel, err, out, f.policy(t))
		}
	}
	// The same repository, spelled differently, is a channel change too: no
	// index is read.
	if _, err := f.set("beta", "--repository", channelTestGitHub+".git/"); err != nil || f.policy(t).Channel != "beta" || f.policy(t).Repository != channelTestGitHub {
		t.Fatalf("same repository: %v %+v", err, f.policy(t))
	}
	if len(f.reads) != 0 {
		t.Fatalf("a channel change read indexes: %v", f.reads)
	}
	before, _ := os.ReadFile(f.path)
	for _, channel := range []string{"main", "Stable", "", "feature/x", "nightly"} {
		if _, err := f.set(channel); err == nil {
			t.Fatalf("channel %q accepted", channel)
		}
	}
	if after, _ := os.ReadFile(f.path); string(before) != string(after) {
		t.Fatal("rejected channel changed the policy")
	}
	channelPolicyPath = filepath.Join(t.TempDir(), "missing.json")
	if _, err := f.set("beta"); err == nil {
		t.Fatal("missing policy created from nothing")
	}
}

func TestChannelSetSwitchesRepository(t *testing.T) {
	f := newChannelFixture(t)
	before := f.policy(t)
	out, err := f.set("alpha", "--repository", "https://Forge.Example.org/team/YouEye.git")
	if err != nil {
		t.Fatal(err)
	}
	want := before
	want.Repository, want.Channel = channelTestForgejo, "alpha"
	if got := f.policy(t); got != want {
		t.Fatalf("policy = %+v, want %+v (schema, digest and service selection unchanged)", got, want)
	}
	if fmt.Sprint(f.reads) != "["+channelTestForgejo+" alpha]" {
		t.Fatalf("index reads = %v, want one of the target channel", f.reads)
	}
	for _, part := range []string{"Following alpha of " + channelTestForgejo, "offers YouEye 0.6.16-alpha.2", "never downgrades"} {
		if !strings.Contains(out, part) {
			t.Fatalf("output %q lacks %q", out, part)
		}
	}
	raw, _ := os.ReadFile(f.path)
	if !strings.Contains(string(raw), `"schema": "youeye.release-policy.v1"`) && !strings.Contains(string(raw), `"schema":"youeye.release-policy.v1"`) {
		t.Fatalf("policy is no longer v1: %s", raw)
	}
	// And back to GitHub stable.
	if _, err := f.set("stable", "--repository", channelTestGitHub); err != nil || f.policy(t) != before {
		t.Fatalf("back to GitHub: %v %+v", err, f.policy(t))
	}
}

func TestChannelSetRefusesABadRepository(t *testing.T) {
	cases := []struct {
		name, repository, want string
		index                  func(repository, channel string) (releasecache.ChannelIndex, error)
		notDeployed            bool
	}{
		{name: "invalid URL", repository: "http://forge.example.org/team/YouEye", want: "HTTPS"},
		{name: "not a repository", repository: "https://forge.example.org/team", want: "owner and repository"},
		{name: "credentials", repository: "https://user:pw@forge.example.org/team/YouEye", want: "without credentials"},
		{name: "before first deploy", repository: channelTestForgejo, notDeployed: true, want: "after the first deploy"},
		{name: "unreachable", repository: channelTestForgejo, want: "could not read the alpha channel index",
			index: func(string, string) (releasecache.ChannelIndex, error) {
				return releasecache.ChannelIndex{}, errors.New("dial tcp: no route to host")
			}},
		{name: "no index", repository: channelTestForgejo, want: "has no alpha channel index",
			index: func(string, string) (releasecache.ChannelIndex, error) {
				return releasecache.ChannelIndex{}, fmt.Errorf("%w (HTTP 404)", releasecache.ErrNotFound)
			}},
		{name: "index does not parse", repository: channelTestForgejo, want: "is not valid",
			index: func(string, string) (releasecache.ChannelIndex, error) {
				return releasecache.ChannelIndex{}, fmt.Errorf("%w at x: decode", releasecache.ErrInvalidIndex)
			}},
		{name: "no youeye", repository: channelTestForgejo, want: "has no YouEye release",
			index: func(_, channel string) (releasecache.ChannelIndex, error) {
				return releasecache.ChannelIndex{Channel: channel, Products: map[string]releasecache.ChannelEntry{"pointer": {Repository: channelTestForgejo}}}, nil
			}},
		{name: "wrong repository in index", repository: channelTestForgejo, want: "names another repository (" + channelTestGitHub + ")",
			index: func(_, channel string) (releasecache.ChannelIndex, error) {
				return releasecache.ChannelIndex{Channel: channel, Products: map[string]releasecache.ChannelEntry{"youeye": {Repository: channelTestGitHub, Version: "0.6.15"}}}, nil
			}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newChannelFixture(t)
			if c.index != nil {
				f.index = c.index
			}
			if c.notDeployed {
				_ = os.Remove(f.marker)
			}
			before, _ := os.ReadFile(f.path)
			_, err := f.set("alpha", "--repository", c.repository)
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("err = %v, want %q", err, c.want)
			}
			if after, _ := os.ReadFile(f.path); string(before) != string(after) {
				t.Fatal("a refused switch changed the policy")
			}
			if c.notDeployed && len(f.reads) != 0 {
				t.Fatalf("index read before first deploy: %v", f.reads)
			}
		})
	}
}

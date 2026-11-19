package cmd

import (
	"reflect"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
)

func viewTree(c string) string   { return strings.Repeat(c, 40) }
func viewSHA256(c string) string { return strings.Repeat(c, 64) }

// viewRelease is the shape of 0.6.11 as published: the image parts reused from
// 0.6.7-dev.1, Spine and CP from 0.6.11-dev.5, the UI built with the release.
// oldShape adds the build names; release says where each reused file lives
// (dev and alpha documents; beta and stable copy the files and say nothing).
func viewRelease(version, build string, oldShape bool, release func(origin string) string) releasecache.CoreRelease {
	r := releasecache.CoreRelease{Version: version, Tag: "youeye-v" + version, SourceTree: viewTree("b"), Sequence: 1795042574}
	if oldShape {
		r.Build = build
	}
	for _, part := range []struct{ role, origin, tree, sha string }{
		{"appliance", "0.6.7-dev.1", viewTree("6"), viewSHA256("1")},
		{"spine", "0.6.11-dev.5", viewTree("0"), viewSHA256("2")},
		{"cp", "0.6.11-dev.5", viewTree("0"), viewSHA256("3")},
		{"ui", build, viewTree("b"), viewSHA256("4")},
	} {
		m := releasecache.CoreMember{Role: part.role, SourceTree: part.tree, Artifact: releasecache.CoreBlob{Name: part.role, SHA256: part.sha, SizeBytes: 1}}
		if oldShape {
			m.BuildVersion = part.origin
		}
		if release != nil {
			m.Artifact.Release = release(part.origin)
		}
		r.Members = append(r.Members, m)
	}
	return r
}

func shownParts(r releasecache.CoreRelease) map[string]string {
	out := map[string]string{}
	for _, m := range r.Members {
		out[m.Role] = partVersion(r, m)
	}
	return out
}

// A box shows its release's version per part, or the release a part was
// reused from: by its full name on dev, by its line elsewhere, and never a dev
// name on a promoted channel.
func TestPartVersionNamesReleasesNotBuilds(t *testing.T) {
	devTag := func(origin string) string {
		if origin == "0.6.11-dev.6" {
			return "" // built with this release: next to the document
		}
		return "youeye-v" + origin
	}
	alphaTag := func(origin string) string { return "youeye-v" + origin } // every file lives in a dev release
	cases := []struct {
		name string
		r    releasecache.CoreRelease
		want map[string]string
	}{
		{"old-shape dev", viewRelease("0.6.11-dev.6", "0.6.11-dev.6", true, devTag),
			map[string]string{"appliance": "from 0.6.7-dev.1", "spine": "from 0.6.11-dev.5", "cp": "from 0.6.11-dev.5", "ui": "0.6.11-dev.6"}},
		{"old-shape alpha", viewRelease("0.6.11-alpha.1", "0.6.11-dev.6", true, alphaTag),
			map[string]string{"appliance": "from 0.6.7", "spine": "0.6.11-alpha.1", "cp": "0.6.11-alpha.1", "ui": "0.6.11-alpha.1"}},
		{"old-shape stable", viewRelease("0.6.11", "0.6.11-dev.6", true, nil),
			map[string]string{"appliance": "from 0.6.7", "spine": "0.6.11", "cp": "0.6.11", "ui": "0.6.11"}},
		{"new-shape dev", viewRelease("0.6.11-dev.6", "0.6.11-dev.6", false, devTag),
			map[string]string{"appliance": "from 0.6.7-dev.1", "spine": "from 0.6.11-dev.5", "cp": "from 0.6.11-dev.5", "ui": "0.6.11-dev.6"}},
		{"new-shape alpha", viewRelease("0.6.11-alpha.1", "0.6.11-dev.6", false, alphaTag),
			map[string]string{"appliance": "from 0.6.7", "spine": "0.6.11-alpha.1", "cp": "0.6.11-alpha.1", "ui": "0.6.11-alpha.1"}},
		// Beta and stable copy the files: a new-shape document cannot say where
		// a reused part came from, so it is shown as part of the release.
		{"new-shape stable", viewRelease("0.6.11", "0.6.11-dev.6", false, nil),
			map[string]string{"appliance": "0.6.11", "spine": "0.6.11", "cp": "0.6.11", "ui": "0.6.11"}},
	}
	for _, c := range cases {
		if got := shownParts(c.r); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
		if !strings.Contains(c.r.Version, "-dev.") {
			for role, shown := range shownParts(c.r) {
				if strings.Contains(shown, "-dev.") {
					t.Errorf("%s: %s shows a dev name: %s", c.name, role, shown)
				}
			}
		}
	}
}

func TestReleaseVersionLines(t *testing.T) {
	old := viewRelease("0.6.11", "0.6.11-dev.6", true, nil)
	got := releaseVersionLines(old, false, false)
	want := []versionLine{{"YouEye", "0.6.11"}, {"System image", "from 0.6.7"}, {"Spine", "0.6.11"}, {"Control Panel", "0.6.11"}, {"UI", "0.6.11"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("old shape: %v", got)
	}
	for _, line := range got {
		if strings.Contains(line.Value, "build") || strings.Contains(line.Value, "-dev.") {
			t.Fatalf("a stable box shows a build: %v", line)
		}
	}

	// A clean dev document: the UI built with it, Spine and CP reused from
	// dev.4 of the line, the image from 0.6.7-dev.1.
	clean := viewRelease("0.6.13-dev.5", "0.6.13-dev.5", false, func(origin string) string {
		switch origin {
		case "0.6.13-dev.5":
			return ""
		case "0.6.11-dev.5":
			return "youeye-v0.6.13-dev.4"
		}
		return "youeye-v" + origin
	})
	got = releaseVersionLines(clean, true, true)
	want = []versionLine{{"YouEye", "0.6.13-dev.5 (installing)"}, {"System image", "from 0.6.7-dev.1"}, {"Spine", "from 0.6.13-dev.4"}, {"Control Panel", "from 0.6.13-dev.4"}, {"UI", "0.6.13-dev.5"}}
	if !reflect.DeepEqual(got[:5], want) {
		t.Fatalf("new shape: %v", got[:5])
	}
	details := map[string]string{}
	for _, line := range got[5:] {
		details[line.Label] = line.Value
	}
	if details["Release tree"] != viewTree("b") || details["Image identity"] != "" {
		t.Fatalf("details: %v", details)
	}
	if details["ui"] != "0.6.13-dev.5 · tree bbbbbbbb · sha256 444444444444" || details["appliance"] != "from 0.6.7-dev.1 · tree 66666666 · sha256 111111111111" {
		t.Fatalf("member details: %v", details)
	}
}

// What runs in a service container is named by the release when its tree (or,
// for a CP built before trees, its build name) is the release's part.
func TestContainerRelease(t *testing.T) {
	r := viewRelease("0.6.11", "0.6.11-dev.6", true, nil)
	for _, c := range []struct{ version, tree, want string }{
		{"0.6.11-dev.5", viewTree("0"), "0.6.11"},
		{"0.6.11-dev.5", "", "0.6.11"},
		{"0.6.12-dev.1", viewTree("9"), "not the installed release's: tree 99999999"},
	} {
		if got := containerRelease(&r, "cp", c.version, c.tree); got != c.want {
			t.Errorf("%s %s: %q, want %q", c.version, c.tree, got, c.want)
		}
	}
	if got := containerRelease(nil, "cp", "0.0.0", ""); got != "v0.0.0" {
		t.Errorf("without a release: %q", got)
	}
}

func TestSpineIsNamedByItsRelease(t *testing.T) {
	r := viewRelease("0.6.11-alpha.1", "0.6.11-dev.6", true, func(origin string) string { return "youeye-v" + origin })
	m, _ := r.Member("spine")
	identity := releaseSpineIdentity(r, m)
	if identity.shown() != "of YouEye 0.6.11-alpha.1" || identity.Version != "0.6.11-dev.5" {
		t.Fatalf("%q %q", identity.shown(), identity.Version)
	}
	dev := viewRelease("0.6.11-dev.6", "0.6.11-dev.6", true, func(origin string) string { return "youeye-v" + origin })
	m, _ = dev.Member("spine")
	if got := releaseSpineIdentity(dev, m).shown(); got != "of YouEye 0.6.11-dev.5" {
		t.Fatalf("reused on dev: %q", got)
	}
	if got := (spineIdentity{SHA256: viewSHA256("a"), Version: "0.6.12-dev.1"}).shown(); got != "0.6.12-dev.1" {
		t.Fatalf("installed by hand: %q", got)
	}
}

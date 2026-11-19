package cmd

import (
	"fmt"
	"strings"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

// What a box shows about its System is the installed release document's
// version (0.6.13-dev.5 on dev; the same files promoted show 0.6.13-alpha.1,
// 0.6.13-beta.1, 0.6.13), never a build name. The details (--verbose) add the
// git tree and sha256 of each part.

// installedRelease is the committed receipt's release or, before the first
// commit (a fresh install), the installer's accepted selection; installing
// says it is the latter.
func installedRelease() (r releasecache.CoreRelease, installing bool, err error) {
	if receipt, err := (systemupdate.CoreManager{Root: systemupdate.CoreStatePath}).ReadReceipt(); err == nil {
		return receipt.Release, false, nil
	}
	if selected, _, err := systemupdate.ReadCoreSelection(systemupdate.CoreBootstrapPath); err == nil {
		return selected, true, nil
	}
	return r, false, fmt.Errorf("no installed System release")
}

// releaseVersionOfTag is the version a youeye-v<version> release tag names.
func releaseVersionOfTag(tag string) (string, bool) {
	version, ok := strings.CutPrefix(tag, "youeye-v")
	return version, ok && releasecache.ValidCoreVersion(version)
}

func isDevVersion(version string) bool { return strings.Contains(version, "-dev.") }

// partVersion is what a box shows for one part of its installed release r: the
// release's version, or "from <release>" when the part's files were reused
// from an earlier release. A part is reused when its tree is not the
// release's. The release it came from is the one that holds its file
// (artifact.release) or, in documents up to 0.6.12, its build name. A dev box
// shows that release's full name; on the other channels only a different line
// is named ("from 0.6.12"), so a promoted box never shows a dev name, and a
// part reused within the line is simply part of the release.
func partVersion(r releasecache.CoreRelease, m releasecache.CoreMember) string {
	if m.SourceTree == "" || m.SourceTree == r.SourceTree {
		return r.Version
	}
	origin := m.BuildVersion
	if version, ok := releaseVersionOfTag(m.Artifact.Release); ok {
		origin = version
	}
	if !releasecache.ValidCoreVersion(origin) || origin == r.Version {
		return r.Version
	}
	if isDevVersion(r.Version) {
		return "from " + origin
	}
	line, _ := releasecache.LineOfVersion(origin)
	if releasecache.CompareLines(line, r.Version) == 0 {
		return r.Version
	}
	return "from " + line
}

// rolePartVersion is partVersion of the member with role, or the release's
// version when the release has no such member.
func rolePartVersion(r releasecache.CoreRelease, role string) string {
	if m, ok := r.Member(role); ok {
		return partVersion(r, m)
	}
	return r.Version
}

func short(value string, n int) string {
	if len(value) > n {
		return value[:n]
	}
	return value
}

type versionLine struct{ Label, Value string }

// releaseVersionLines are the lines `youeye version` prints for an installed
// release: the release, then per part its version. verbose adds the release's
// tree and each member's tree and sha256 (never a build name).
func releaseVersionLines(r releasecache.CoreRelease, installing, verbose bool) []versionLine {
	youeye := r.Version
	if installing {
		youeye += " (installing)"
	}
	lines := []versionLine{
		{"YouEye", youeye},
		{"System image", rolePartVersion(r, "appliance")},
		{"Spine", rolePartVersion(r, "spine")},
		{"Control Panel", rolePartVersion(r, "cp")},
		{"UI", rolePartVersion(r, "ui")},
	}
	if !verbose {
		return lines
	}
	lines = append(lines, versionLine{"Release tree", r.SourceTree})
	for _, m := range r.Members {
		lines = append(lines, versionLine{m.Role, fmt.Sprintf("%s · tree %s · sha256 %s", partVersion(r, m), short(m.SourceTree, 8), short(m.Artifact.SHA256, 12))})
	}
	return lines
}

// containerRelease names what runs in a service container by its version.json
// (version, and source_tree from 0.6.12 builds on): the installed release's
// version when it is the release's part, else its tree, else what it says.
func containerRelease(r *releasecache.CoreRelease, role, version, tree string) string {
	if r != nil {
		if m, ok := r.Member(role); ok {
			if (tree != "" && tree == m.SourceTree) || (tree == "" && version != "" && version == m.BuildVersion) {
				return partVersion(*r, m)
			}
			if tree != "" {
				return "not the installed release's: tree " + short(tree, 8)
			}
		}
	}
	if version == "" {
		return ""
	}
	return "v" + version
}

// runningSpineVersion names the Spine the booted slot runs: the installed
// release's Spine by the release's version, any other by role and sha256.
func runningSpineVersion(r *releasecache.CoreRelease) string {
	report, err := readSpineStatus()
	if err != nil {
		if r != nil {
			return rolePartVersion(*r, "spine")
		}
		return "unknown"
	}
	running, where := report.Seed.SHA256, "seed in the image, slot "+report.Slot
	if report.Running.Entry != nil {
		running, where = report.Running.Entry.SHA256, report.Running.Role+" on State, slot "+report.Slot
	}
	if r != nil {
		if m, ok := r.Member("spine"); ok && m.Artifact.SHA256 == running {
			return partVersion(*r, m) + " (" + where + ")"
		}
	}
	return "not the installed release's (" + where + ", sha256 " + short(running, 12) + ")"
}

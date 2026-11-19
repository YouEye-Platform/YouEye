package releasecache

import (
	"fmt"
	"strconv"
)

// Releases are ordered by line (X.Y.Z, numerically), then by the build's
// sequence. A release name (X.Y.Z-dev.N, -alpha.N, -beta.N, X.Y.Z) is a label
// for one build on one channel and never decides: 0.6.13 (stable) is older
// than a later 0.6.13-dev.6, and the alpha, beta and stable documents of one
// build are the same release. The vectors in testdata/release-order.json are
// shared with the Control Panel (control-panel/src/lib/version.ts).

// ReleaseKey orders a release. Line is X.Y.Z; Sequence is the build's publish
// time in Unix seconds, written once and kept by every promotion.
type ReleaseKey struct {
	Line     string
	Sequence int64
}

// LineOfVersion returns the X.Y.Z of a line or release name.
func LineOfVersion(version string) (string, bool) {
	if !ValidCoreVersion(version) {
		return "", false
	}
	m := coreVersionPattern.FindStringSubmatch(version)
	return m[1] + "." + m[2] + "." + m[3], true
}

// KeyOfVersion builds the ordering key of a release from its name and its
// document's sequence.
func KeyOfVersion(version string, sequence int64) (ReleaseKey, error) {
	line, ok := LineOfVersion(version)
	if !ok {
		return ReleaseKey{}, fmt.Errorf("%q is not a release version", version)
	}
	if sequence <= 0 || sequence > 9007199254740991 {
		return ReleaseKey{}, fmt.Errorf("release %s has no valid sequence", version)
	}
	return ReleaseKey{Line: line, Sequence: sequence}, nil
}

// Key is the ordering key of a validated release document, old shape or new.
func (r CoreRelease) Key() ReleaseKey {
	line, _ := LineOfVersion(r.Version)
	return ReleaseKey{Line: line, Sequence: int64(r.Sequence)}
}

func lineNumbers(value string) ([3]uint64, bool) {
	var out [3]uint64
	line, ok := LineOfVersion(value)
	if !ok {
		return out, false
	}
	m := coreVersionPattern.FindStringSubmatch(line)
	for i := range out {
		out[i], _ = strconv.ParseUint(m[i+1], 10, 64)
	}
	return out, true
}

// CompareLines orders two lines numerically (0.6.9 before 0.6.10). A release
// name is read as its line. A value that is no version sorts first.
func CompareLines(a, b string) int {
	na, oka := lineNumbers(a)
	nb, okb := lineNumbers(b)
	switch {
	case !oka && !okb:
		return 0
	case !oka:
		return -1
	case !okb:
		return 1
	}
	for i := range na {
		if na[i] != nb[i] {
			if na[i] < nb[i] {
				return -1
			}
			return 1
		}
	}
	return 0
}

// CompareReleases orders two releases: the line, then the sequence. Equal keys
// mean the same build (the callers then require the same payload).
func CompareReleases(a, b ReleaseKey) int {
	if c := CompareLines(a.Line, b.Line); c != 0 {
		return c
	}
	switch {
	case a.Sequence < b.Sequence:
		return -1
	case a.Sequence > b.Sequence:
		return 1
	}
	return 0
}

// MinimumReleaseMet reports whether a box on installedVersion may install a
// release whose minimum_release is minimum. Only lines are compared: any
// release of the minimum's line (or a later line) passes. A minimum written by
// an older publisher as a build name (0.6.5-dev.2) is read as its line.
func MinimumReleaseMet(installedVersion, minimum string) bool {
	if _, ok := LineOfVersion(installedVersion); !ok {
		return false
	}
	if _, ok := LineOfVersion(minimum); !ok {
		return false
	}
	return CompareLines(installedVersion, minimum) >= 0
}

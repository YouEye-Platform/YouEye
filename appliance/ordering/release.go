package ordering

import (
	"fmt"
	"regexp"
	"strconv"
)

// ReleaseVersion is a release name: X.Y.Z or X.Y.Z-token.N. It is a label and
// is never ordered: releases are ordered by line and build sequence
// (releasecache.CompareReleases). This package orders image identities only
// (ParseVersion, CompareVersion); ParseReleaseVersion reads a name for display.
type ReleaseVersion struct {
	Core    [3]uint64
	Token   string
	Counter uint64
}

// The bound is shared with JavaScript consumers; reject imprecise identities.
const MaxReleaseNumber = uint64(9007199254740991)

var releasePattern = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\.([1-9][0-9]*))?$`)

func ParseReleaseVersion(value string) (ReleaseVersion, error) {
	var out ReleaseVersion
	m := releasePattern.FindStringSubmatch(value)
	if m == nil || len(m[4]) > 63 {
		return out, fmt.Errorf("release version must be X.Y.Z or X.Y.Z-token.N with a lowercase token and positive counter")
	}
	for i := 0; i < 3; i++ {
		n, err := strconv.ParseUint(m[i+1], 10, 64)
		if err != nil || n > MaxReleaseNumber {
			return out, fmt.Errorf("release number out of range")
		}
		out.Core[i] = n
	}
	out.Token = m[4]
	if out.Token != "" {
		n, err := strconv.ParseUint(m[5], 10, 64)
		if err != nil || n > MaxReleaseNumber {
			return out, fmt.Errorf("release counter out of range")
		}
		out.Counter = n
	}
	return out, nil
}

func (v ReleaseVersion) String() string {
	base := fmt.Sprintf("%d.%d.%d", v.Core[0], v.Core[1], v.Core[2])
	if v.Token != "" {
		return fmt.Sprintf("%s-%s.%d", base, v.Token, v.Counter)
	}
	return base
}

package systemupdate

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/youeye-platform/YouEye/releasecache"
)

const coreVersionFloorSchema = "youeye.core-version-floor.v1"

// coreVersionFloor is the highest accepted release: its ordering key (Line,
// Sequence), its name (for messages) and what it installs.
//
// Both System slots read this file, and the other slot may hold a Spine up to
// 0.6.11, which reads only Build and refuses a floor without it. So this
// Spine writes both shapes: Build stays (the release's build name, or its
// version when the document has none), next to Line, Sequence and Version. A
// floor written by such an older Spine has no Sequence; floorKey finds it.
// Build goes when no supported box can hold a Spine that needs it.
type coreVersionFloor struct {
	Schema         string `json:"schema"`
	Build          string `json:"build,omitempty"`
	Line           string `json:"line,omitempty"`
	Sequence       int64  `json:"sequence,omitempty"`
	Version        string `json:"version,omitempty"`
	PayloadSHA256  string `json:"payload_sha256"`
	ManifestSHA256 string `json:"manifest_sha256"`
}

// retainSequence keeps the highest accepted release. A box never downgrades,
// whichever channel it follows. The same build under another release name
// (another channel's document) is not older.
// Caller holds the coordinator lock.
func (m CoreManager) retainSequence(r releasecache.CoreRelease, digest string, requireAdvance bool) error {
	return m.versionFloor(r, digest, requireAdvance, true)
}

// checkSequence applies the floor without raising it.
func (m CoreManager) checkSequence(r releasecache.CoreRelease, digest string, requireAdvance bool) error {
	return m.versionFloor(r, digest, requireAdvance, false)
}

// floorKey returns the ordering key and the name of the release a retained
// floor stands for. known says whether the key has the floor's sequence.
//
// A floor with a sequence says them itself. A floor without one was written by
// a Spine up to 0.6.11: its document, which Prepare and Initialize retain as
// targets/<manifest_sha256>.json before they raise the floor, says the
// sequence. The installed receipt is no second source: it stands for the
// floor only when it is that same document (after a recovery the floor names
// a release that was rolled back), and a readable receipt always has its
// document in targets/. When the document is gone, only the floor's line and
// its build name are known (known is false, the key's sequence is 0):
// versionFloor then orders releases of that line by the build name.
func (m CoreManager) floorKey(floor coreVersionFloor) (key releasecache.ReleaseKey, name string, known bool, err error) {
	if floor.Sequence != 0 || floor.Line != "" {
		key, err := releasecache.KeyOfVersion(floor.Line, floor.Sequence)
		if err != nil || key.Line != floor.Line {
			return releasecache.ReleaseKey{}, "", false, fmt.Errorf("retained version floor is invalid")
		}
		name := floor.Version
		if _, ok := releasecache.LineOfVersion(name); !ok {
			name = floor.Line
		}
		return key, name, true, nil
	}
	if !releasecache.ValidCoreVersion(floor.Build) {
		return releasecache.ReleaseKey{}, "", false, fmt.Errorf("retained version floor is invalid")
	}
	if _, r, err := m.Selection(floor.ManifestSHA256); err == nil {
		return r.Key(), r.Version, true, nil
	}
	line, _ := releasecache.LineOfVersion(floor.Build)
	return releasecache.ReleaseKey{Line: line}, line, false, nil
}

// compareBuildNames orders two build names of one line as a Spine up to
// 0.6.11 did: the label never decides, the number after it does, and a name
// without a suffix comes after every suffixed one. It is used only against a
// floor such a Spine wrote whose sequence cannot be found; everything else is
// ordered by line and sequence.
func compareBuildNames(a, b string) int {
	position := func(build string) (final bool, n uint64) {
		if !strings.Contains(build, "-") {
			return true, 0
		}
		n, _ = strconv.ParseUint(build[strings.LastIndex(build, ".")+1:], 10, 64)
		return false, n
	}
	finalA, nA := position(a)
	finalB, nB := position(b)
	switch {
	case finalA != finalB && finalB:
		return -1
	case finalA != finalB:
		return 1
	case nA < nB:
		return -1
	case nA > nB:
		return 1
	}
	return 0
}

func (m CoreManager) versionFloor(r releasecache.CoreRelease, digest string, requireAdvance, write bool) error {
	path := filepath.Join(m.Root, "version-floor.json")
	raw, err := ReadCoreState(path, 16384)
	if err == nil {
		var old coreVersionFloor
		if json.Unmarshal(raw, &old) != nil || old.Schema != coreVersionFloorSchema || !validSHA256(old.PayloadSHA256) || !validSHA256(old.ManifestSHA256) {
			return fmt.Errorf("retained version floor is invalid")
		}
		floor, name, known, err := m.floorKey(old)
		if err != nil {
			return err
		}
		c := releasecache.CompareReleases(r.Key(), floor)
		if !known && releasecache.CompareLines(r.Key().Line, floor.Line) == 0 {
			// A release of the floor's line, and the floor's sequence is not
			// known (floorKey). The record's build name still says where the
			// floor stands within the line, by the rule of the Spine that
			// wrote it. A release that names no build cannot be placed: it
			// is left to the installed receipt (Prepare's downgrade check)
			// and never replaces the floor, which so is never lowered.
			if !releasecache.ValidCoreVersion(r.Build) || releasecache.CompareLines(r.Build, floor.Line) != 0 {
				return nil
			}
			c = compareBuildNames(r.Build, old.Build)
		}
		switch {
		case c < 0:
			if requireAdvance {
				return fmt.Errorf("YouEye %s is older than %s, which this box already accepted; a box never downgrades", r.Version, name)
			}
			return nil
		case c == 0:
			// The same build, possibly under another channel's name: it must
			// install the same files.
			if r.PayloadSHA256() != old.PayloadSHA256 {
				return fmt.Errorf("YouEye %s is the same build as the accepted %s but installs other files", r.Version, name)
			}
			if !write || (old.Sequence != 0 && old.Build != "") {
				return nil
			}
			// The same release, but an older Spine wrote the record in its
			// one shape: write it again in both, for this document.
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if !write {
		return nil
	}
	key := r.Key()
	build := r.Build
	if build == "" {
		build = r.Version
	}
	raw, err = json.Marshal(coreVersionFloor{Schema: coreVersionFloorSchema, Build: build, Line: key.Line, Sequence: key.Sequence, Version: r.Version,
		PayloadSHA256: r.PayloadSHA256(), ManifestSHA256: digest})
	if err != nil {
		return err
	}
	return atomicWrite(path, raw, 0600)
}

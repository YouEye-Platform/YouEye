package systemupdate

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/youeye-platform/YouEye/releasecache"
)

// coreVersionFloor is the highest accepted build (never a release name).
type coreVersionFloor struct {
	Schema         string `json:"schema"`
	Build          string `json:"build"`
	PayloadSHA256  string `json:"payload_sha256"`
	ManifestSHA256 string `json:"manifest_sha256"`
}

// retainSequence keeps the highest accepted build. A box never downgrades,
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

func (m CoreManager) versionFloor(r releasecache.CoreRelease, digest string, requireAdvance, write bool) error {
	path := filepath.Join(m.Root, "version-floor.json")
	raw, err := ReadCoreState(path, 16384)
	if err == nil {
		var old coreVersionFloor
		if json.Unmarshal(raw, &old) != nil || old.Schema != "youeye.core-version-floor.v1" || !releasecache.ValidCoreVersion(old.Build) || !validSHA256(old.PayloadSHA256) || !validSHA256(old.ManifestSHA256) {
			return fmt.Errorf("retained version floor is invalid")
		}
		switch c := releasecache.CompareVersions(r.Build, old.Build); {
		case c < 0:
			if requireAdvance {
				return fmt.Errorf("core release %s (build %s) is older than the accepted build %s", r.Version, r.Build, old.Build)
			}
			return nil
		case c == 0:
			// The same build, possibly under another channel's name: it must
			// install the same files.
			if r.PayloadSHA256() != old.PayloadSHA256 {
				return fmt.Errorf("core release %s claims build %s but installs other files than the accepted one", r.Version, r.Build)
			}
			return nil
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if !write {
		return nil
	}
	raw, err = json.Marshal(coreVersionFloor{Schema: "youeye.core-version-floor.v1", Build: r.Build, PayloadSHA256: r.PayloadSHA256(), ManifestSHA256: digest})
	if err != nil {
		return err
	}
	return atomicWrite(path, raw, 0600)
}

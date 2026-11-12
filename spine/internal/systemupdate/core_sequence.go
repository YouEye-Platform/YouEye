package systemupdate

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/youeye-platform/YouEye/releasecache"
)

type coreVersionFloor struct {
	Schema         string `json:"schema"`
	Version        string `json:"version"`
	ManifestSHA256 string `json:"manifest_sha256"`
}

// retainSequence keeps the highest accepted version. A box never downgrades,
// whichever channel it follows, and one version is one build: the same
// version with another document digest is refused.
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
		if json.Unmarshal(raw, &old) != nil || old.Schema != "youeye.core-version-floor.v1" || !releasecache.ValidCoreVersion(old.Version) || !validSHA256(old.ManifestSHA256) {
			return fmt.Errorf("retained version floor is invalid")
		}
		switch c := releasecache.CompareVersions(r.Version, old.Version); {
		case c < 0:
			if requireAdvance {
				return fmt.Errorf("core release %s is older than the accepted %s", r.Version, old.Version)
			}
			return nil
		case c == 0:
			if digest != old.ManifestSHA256 {
				return fmt.Errorf("core release %s differs from the accepted build of that version", r.Version)
			}
			return nil
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if !write {
		return nil
	}
	raw, err = json.Marshal(coreVersionFloor{Schema: "youeye.core-version-floor.v1", Version: r.Version, ManifestSHA256: digest})
	if err != nil {
		return err
	}
	return atomicWrite(path, raw, 0600)
}

package systemupdate

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/youeye-platform/YouEye/releasecache"
)

type coreSequenceFloor struct {
	Schema         string `json:"schema"`
	Source         string `json:"source"`
	Branch         string `json:"branch"`
	Sequence       uint64 `json:"sequence"`
	ManifestSHA256 string `json:"manifest_sha256"`
}

// Caller holds the coordinator lock and has verified current selection authority.
// The floor lives outside paired data restoration and follows the exact source
// track even when a failed update rolls back or the owner changes channels.
func (m CoreManager) retainSequence(r releasecache.CoreRelease, digest string, requireAdvance bool) error {
	key := sha256.Sum256([]byte(r.Source + "\x00" + r.Branch))
	path := filepath.Join(m.Root, "sequence-floors", fmt.Sprintf("%x.json", key))
	raw, err := ReadCoreState(path, 16384)
	if err == nil {
		var old coreSequenceFloor
		if json.Unmarshal(raw, &old) != nil || old.Schema != "youeye.core-sequence.v1" || old.Source != r.Source || old.Branch != r.Branch || old.Sequence == 0 || old.Sequence > 9007199254740991 || !validSHA256(old.ManifestSHA256) {
			return fmt.Errorf("retained core sequence is invalid")
		}
		frozen, err := ReadCoreState(filepath.Join(m.Root, "targets", old.ManifestSHA256+".json"), 1<<20)
		if err != nil {
			return err
		}
		prior, hash, err := releasecache.ParseCoreRelease(frozen)
		if err != nil || hash != old.ManifestSHA256 || prior.Source != old.Source || prior.Branch != old.Branch || prior.Sequence != old.Sequence {
			return fmt.Errorf("retained sequence lost its frozen input")
		}
		if r.Sequence < old.Sequence {
			if requireAdvance {
				return fmt.Errorf("core release is older than the retained source-track sequence")
			}
			return nil
		}
		if r.Sequence == old.Sequence {
			if digest != old.ManifestSHA256 {
				return fmt.Errorf("signed core source-track sequence conflicts")
			}
			return nil
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	raw, err = json.Marshal(coreSequenceFloor{Schema: "youeye.core-sequence.v1", Source: r.Source, Branch: r.Branch, Sequence: r.Sequence, ManifestSHA256: digest})
	if err != nil {
		return err
	}
	return atomicWrite(path, raw, 0600)
}

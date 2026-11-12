package spineselect

import "time"

// Report is what `youeye spine status`, `youeye version` and the Spine API show.
type Report struct {
	Slot      string           `json:"slot"`
	Seed      Seed             `json:"seed"`
	Running   Resolution       `json:"running"`
	Selection map[string]*Slot `json:"selection"`
	Host      Host             `json:"host"`
}

// Seed is the Spine baked into the running image.
type Seed struct {
	Path    string `json:"path"`
	SHA256  string `json:"sha256"`
	Version string `json:"version"`
}

// Status reads the selection of the booted slot. seedVersion comes from the
// image manifest (release_set.spine.version).
func Status(root, slot, seedVersion string) (Report, error) {
	r := Report{Slot: slot, Host: ThisHost()}
	digest, err := FileDigest(BakedPath)
	if err != nil {
		return r, err
	}
	r.Seed = Seed{Path: BakedPath, SHA256: digest, Version: seedVersion}
	if r.Running, err = Resolve(root, slot, r.Host, false, time.Now()); err != nil {
		return r, err
	}
	sel, err := Load(root)
	if err != nil && err != ErrNoSelection {
		return r, err
	}
	r.Selection = sel.Slots
	return r, nil
}

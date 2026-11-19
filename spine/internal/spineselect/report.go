package spineselect

import (
	"fmt"
	"regexp"
	"time"
)

// Report is the seed, the Spine the booted slot runs and the selection as
// stored. `youeye version` reads it; `youeye spine status` and the Spine API
// print it as Shown.
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

var versionLineRE = regexp.MustCompile(`^((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))(?:-[a-z0-9][a-z0-9.-]*)?$`)

// shownVersion is how a stored Spine name is shown: by its line (X.Y.Z). The
// stored name may be a build name (0.6.11-dev.5: releases up to 0.6.12 name
// their Spine so), which a box never shows. A name that is no version (given
// by hand to `youeye spine install`) is shown as it is.
func shownVersion(version, line string) string {
	for _, name := range []string{line, version} {
		if m := versionLineRE.FindStringSubmatch(name); m != nil {
			return m[1]
		}
	}
	return version
}

// label names a Spine in messages: its line and the start of its digest,
// which is what tells two Spines of one line apart.
func (e Entry) label() string {
	return fmt.Sprintf("%s (sha256 %.12s)", shownVersion(e.Version, e.Line), e.SHA256)
}

// Shown is the report as a box prints it: every `version` is the Spine's
// line. The record on State is not touched; it keeps the names as stored,
// because a Spine up to 0.6.11 in the other slot reads them.
func (r Report) Shown() Report {
	shown := func(e *Entry) *Entry {
		if e == nil {
			return nil
		}
		c := *e
		c.Version = shownVersion(c.Version, c.Line)
		return &c
	}
	r.Seed.Version = shownVersion(r.Seed.Version, "")
	r.Running.Entry = shown(r.Running.Entry)
	if r.Selection != nil {
		slots := make(map[string]*Slot, len(r.Selection))
		for name, slot := range r.Selection {
			if slot != nil {
				slots[name] = &Slot{Current: shown(slot.Current), Previous: shown(slot.Previous), Trial: shown(slot.Trial)}
			}
		}
		r.Selection = slots
	}
	return r
}

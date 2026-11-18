package systemupdate

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
)

// promotedCoreFixture is another document of the same build: a new release
// name, with the files named where the build published them.
func promotedCoreFixture(r releasecache.CoreRelease, version string) releasecache.CoreRelease {
	p := r
	p.Version, p.Tag = version, "youeye-v"+version
	p.Members = append([]releasecache.CoreMember(nil), r.Members...)
	for i := range p.Members {
		p.Members[i].Artifact.Release = r.Tag
		if p.Members[i].BuildInputs != nil {
			inputs := *p.Members[i].BuildInputs
			inputs.Release = r.Tag
			p.Members[i].BuildInputs = &inputs
		}
	}
	return p
}

func coreFixtureDocument(t *testing.T, r releasecache.CoreRelease) ([]byte, string) {
	t.Helper()
	raw, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	_, digest, err := releasecache.ParseCoreRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	return raw, digest
}

// selectionBox is a box as far as the recorded selection goes: the coordinator's
// State, the Control Panel's root with its core-release.json, and an executor
// whose selection effects are the real ones. recordsPromotion false is a Spine
// before 0.6.11, which commits a promotion without rewriting the file.
type selectionBox struct {
	*coreTestExecutor
	t                *testing.T
	m                CoreManager
	root             *os.File
	path             string
	recordsPromotion bool
	failUI           bool
	checkpoint       []byte
}

func newSelectionBox(t *testing.T) (*selectionBox, releasecache.CoreRelease) {
	t.Helper()
	m, e, target := coreJournalFixture(t)
	box := &selectionBox{coreTestExecutor: e, t: t, recordsPromotion: true}
	m.Executor = box
	box.m = m
	rootPath := t.TempDir()
	dir := filepath.Join(rootPath, coreSelectionDirectory)
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	box.path = filepath.Join(dir, "core-release.json")
	receipt, err := m.ReadReceipt()
	if err != nil {
		t.Fatal(err)
	}
	installed, _, err := m.Selection(receipt.ManifestSHA256)
	if err != nil {
		t.Fatal(err)
	}
	// First deployment records the installed document.
	box.record(installed.Raw)
	if box.root, err = os.Open(rootPath); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { box.root.Close() })
	return box, target
}

func (b *selectionBox) record(raw []byte) {
	b.t.Helper()
	if err := os.WriteFile(b.path, raw, 0600); err != nil {
		b.t.Fatal(err)
	}
}

func (b *selectionBox) recorded() []byte {
	b.t.Helper()
	raw, err := os.ReadFile(b.path)
	if err != nil {
		b.t.Fatal(err)
	}
	return raw
}

func (b *selectionBox) AuthorizeRecovery(context.Context, CoreJournal) error { return nil }

func (b *selectionBox) Start(ctx context.Context, j CoreJournal, s CoreStep) (CoreActionObservation, error) {
	var err error
	switch s.Name {
	case "checkpoint":
		b.checkpoint = b.recorded()
	case "apply-cp":
		var previous, next CoreHostSelection
		if previous, _, err = b.m.Selection(j.Previous.ManifestSHA256); err != nil {
			break
		}
		if next, _, err = b.m.Selection(j.ManifestSHA256); err != nil {
			break
		}
		stage := CoreServiceStage{Role: "cp", Phase: "swapped", StageName: ".youeye-core-fixture", ManifestSHA256: j.ManifestSHA256}
		err = installCoreServiceSelection(b.m, b.root, &stage, previous, next, func(CoreServiceStage) error { return nil })
	case "apply-ui":
		if b.failUI {
			return CoreActionObservation{State: "failed", Evidence: "fixture dashboard failure"}, nil
		}
	case "authenticated-health":
		if j.MetadataOnly && b.recordsPromotion {
			err = recordPromotedCoreSelection(b.m, b.root, j)
		}
	case "recovery-paired-restore":
		b.record(b.checkpoint)
	case "recovery-health":
		var previous CoreHostSelection
		if previous, _, err = b.m.Selection(j.Previous.ManifestSHA256); err == nil {
			err = verifyRecoveredCoreSelection(b.m, b.root, previous, coreSelectionTemp(j.RequestID, ".recovery"))
		}
	}
	if err != nil {
		return CoreActionObservation{State: "failed", Evidence: err.Error()}, nil
	}
	return b.coreTestExecutor.Start(ctx, j, s)
}

// request prepares the release under its own request and advances it once.
func (b *selectionBox) request(id string, r releasecache.CoreRelease) (CoreJournal, []byte) {
	b.t.Helper()
	raw, digest := coreFixtureDocument(b.t, r)
	if _, err := b.m.Prepare(context.Background(), id, raw, digest); err != nil {
		b.t.Fatal(err)
	}
	j, err := b.m.Advance(context.Background(), id, false)
	if err != nil {
		b.t.Fatal(err)
	}
	return j, raw
}

func coreFixtureStepEvidence(j CoreJournal, name string) string {
	for _, step := range append(append([]CoreStep(nil), j.Steps...), j.RecoverySteps...) {
		if step.Name == name {
			return step.State + ": " + step.Evidence
		}
	}
	return "absent"
}

// The reproduction: a box takes a build, then the promotion of the same build
// as an update (a metadata-only request), then a service update. Under a Spine
// before 0.6.11 the promotion left the build's first document recorded; under
// this one it records the promoted document. The service update must go through
// in both cases and leave the new document recorded.
func TestCoreServiceUpdateAfterPromotion(t *testing.T) {
	for _, spine := range []struct {
		name             string
		recordsPromotion bool
	}{{"promotion recorded", true}, {"promotion left stale by an older Spine", false}} {
		t.Run(spine.name, func(t *testing.T) {
			box, target := newSelectionBox(t)
			box.recordsPromotion = spine.recordsPromotion
			installed, err := box.m.ReadReceipt()
			if err != nil {
				t.Fatal(err)
			}
			first := box.recorded()

			j, promoted := box.request("update-promotion", promotedCoreFixture(installed.Release, "0.5.37-alpha.1"))
			if !j.MetadataOnly || j.Phase != "committed" {
				t.Fatal("promotion did not commit as a metadata-only request: ", j.Phase, coreFixtureStepEvidence(j, "authenticated-health"))
			}
			if spine.recordsPromotion {
				// The invariant: after a committed request the recorded selection is the installed document.
				if !bytes.Equal(box.recorded(), promoted) {
					t.Fatal("a committed promotion left another document recorded")
				}
			} else if !bytes.Equal(box.recorded(), first) {
				t.Fatal("fixture: the older Spine rewrote the selection")
			}

			j, updated := box.request("update-services", target)
			if j.MetadataOnly || j.Phase != "committed" {
				t.Fatal("service update after a promotion: ", j.Phase, coreFixtureStepEvidence(j, "apply-cp"))
			}
			if !bytes.Equal(box.recorded(), updated) {
				t.Fatal("service update left another document recorded")
			}
			receipt, err := box.m.ReadReceipt()
			if err != nil || receipt.Release.Version != target.Version {
				t.Fatal("service update not committed", err)
			}
		})
	}
}

// A second promotion (alpha, then beta) on a box that an older Spine left stale
// replaces the build's first document with the newest one.
func TestCorePromotionRecordsSelectionOverAnEarlierDocumentOfTheBuild(t *testing.T) {
	box, _ := newSelectionBox(t)
	installed, err := box.m.ReadReceipt()
	if err != nil {
		t.Fatal(err)
	}
	box.recordsPromotion = false
	if j, _ := box.request("update-alpha", promotedCoreFixture(installed.Release, "0.5.37-alpha.1")); j.Phase != "committed" {
		t.Fatal(j.Phase)
	}
	box.recordsPromotion = true
	j, beta := box.request("update-beta", promotedCoreFixture(installed.Release, "0.5.37-beta.1"))
	if j.Phase != "committed" || !bytes.Equal(box.recorded(), beta) {
		t.Fatal("promotion over a stale selection: ", j.Phase, coreFixtureStepEvidence(j, "authenticated-health"))
	}
	// Recording the same document again changes nothing and leaves no temporary file.
	current, err := box.m.Read()
	if err != nil {
		t.Fatal(err)
	}
	if err = recordPromotedCoreSelection(box.m, box.root, current); err != nil || !bytes.Equal(box.recorded(), beta) {
		t.Fatal("repeated record", err)
	}
	entries, err := os.ReadDir(filepath.Dir(box.path))
	if err != nil || len(entries) != 1 {
		t.Fatal("temporary selection left behind", entries, err)
	}
}

// What a promotion may replace, and what an update or a recovery may accept in
// place of the exact document: only a retained document of the same build.
func TestCoreRecordedSelectionRefusesOtherPayloadsAndUnretainedDocuments(t *testing.T) {
	box, target := newSelectionBox(t)
	installed, err := box.m.ReadReceipt()
	if err != nil {
		t.Fatal(err)
	}
	first := box.recorded()
	box.recordsPromotion = false
	if j, _ := box.request("update-promotion", promotedCoreFixture(installed.Release, "0.5.37-alpha.1")); j.Phase != "committed" {
		t.Fatal(j.Phase)
	}
	box.recordsPromotion = true
	current, err := box.m.ReadReceipt()
	if err != nil {
		t.Fatal(err)
	}
	expected, _, err := box.m.Selection(current.ManifestSHA256)
	if err != nil {
		t.Fatal(err)
	}

	// Other payloads, retained: the next release, prepared (so retained) but not installed.
	targetRaw, targetDigest := coreFixtureDocument(t, target)
	if _, err = box.m.Prepare(context.Background(), "update-services", targetRaw, targetDigest); err != nil {
		t.Fatal(err)
	}
	// The same build, never retained: a document this box never accepted.
	unretained, unretainedDigest := coreFixtureDocument(t, promotedCoreFixture(installed.Release, "0.5.37-beta.7"))
	if _, _, err = box.m.Selection(unretainedDigest); err == nil {
		t.Fatal("fixture: document is retained")
	}
	// The retained document's content in other bytes: another digest, so not retained.
	reformatted := append(append([]byte{}, first...), '\n')
	// A retained name whose file no longer holds the document.
	damaged, damagedDigest := coreFixtureDocument(t, promotedCoreFixture(installed.Release, "0.5.37-beta.8"))
	if err = atomicWrite(filepath.Join(box.m.Root, "targets", damagedDigest+".json"), reformatted, 0600); err != nil {
		t.Fatal(err)
	}

	if !box.m.recordedSelectionStandsFor(expected.Raw, expected) || !box.m.recordedSelectionStandsFor(first, expected) {
		t.Fatal("the exact document or the build's retained first document was refused")
	}
	for name, recorded := range map[string][]byte{
		"other payloads":     targetRaw,
		"unretained":         unretained,
		"reformatted":        reformatted,
		"damaged retention":  damaged,
		"not a document":     []byte(`{"fixture":"another release"}`),
		"truncated document": first[:len(first)/2],
	} {
		t.Run(name, func(t *testing.T) {
			if box.m.recordedSelectionStandsFor(recorded, expected) {
				t.Fatal("accepted as the installed release")
			}
			box.record(recorded)
			// An update refuses to replace it.
			stage := CoreServiceStage{Role: "cp", Phase: "swapped", StageName: ".youeye-core-fixture", ManifestSHA256: targetDigest}
			err := installCoreServiceSelection(box.m, box.root, &stage, expected, CoreHostSelection{Raw: targetRaw}, func(CoreServiceStage) error { return nil })
			if err == nil || !strings.Contains(err.Error(), "CP selection differs from retained transition") || stage.SelectionState != "" {
				t.Fatal("update replaced a foreign selection", err, stage.SelectionState)
			}
			// A recovery refuses it and does not repair it.
			if err = verifyRecoveredCoreSelection(box.m, box.root, expected, ".fixture.core-release.json"); err == nil {
				t.Fatal("recovery accepted a foreign selection")
			}
			// A promotion refuses to replace it.
			promotion := CoreJournal{MetadataOnly: true, RequestID: "update-fixture", ManifestSHA256: current.ManifestSHA256}
			if err = recordPromotedCoreSelection(box.m, box.root, promotion); err == nil {
				t.Fatal("promotion replaced a foreign selection")
			}
			if !bytes.Equal(box.recorded(), recorded) {
				t.Fatal("a refused selection was rewritten")
			}
		})
	}
	// The promotion writer is for metadata-only requests alone.
	box.record(first)
	if err = recordPromotedCoreSelection(box.m, box.root, CoreJournal{RequestID: "update-fixture", ManifestSHA256: targetDigest}); err == nil || !bytes.Equal(box.recorded(), first) {
		t.Fatal("a payload-changing request recorded its selection outside apply-cp", err)
	}
}

// A service update fails after apply-cp on a box that an older Spine left
// stale. The paired restore brings the stale document back; recovery accepts it
// as the previous release, records the exact previous document, and the request
// ends rolled back. An observation of the same state accepts it without writing.
func TestCoreRecoveryOnAStaleSelectionEndsRolledBack(t *testing.T) {
	box, target := newSelectionBox(t)
	installed, err := box.m.ReadReceipt()
	if err != nil {
		t.Fatal(err)
	}
	first := box.recorded()
	box.recordsPromotion = false
	_, promoted := box.request("update-promotion", promotedCoreFixture(installed.Release, "0.5.37-alpha.1"))
	box.failUI = true
	j, updated := box.request("update-services", target)
	if j.Phase != "needs-recovery" || !bytes.Equal(box.recorded(), updated) {
		t.Fatal("fixture: the update did not fail after apply-cp: ", j.Phase, coreFixtureStepEvidence(j, "apply-cp"))
	}
	if !bytes.Equal(box.checkpoint, first) {
		t.Fatal("fixture: the checkpoint does not hold the stale selection")
	}
	previous, _, err := box.m.Selection(j.Previous.ManifestSHA256)
	if err != nil || !bytes.Equal(previous.Raw, promoted) {
		t.Fatal("fixture: previous release is not the promotion", err)
	}

	// Observation of the restored state: accepted, nothing written.
	box.record(box.checkpoint)
	if err = verifyRecoveredCoreSelection(box.m, box.root, previous, ""); err != nil || !bytes.Equal(box.recorded(), first) {
		t.Fatal("observation of a stale restored selection", err)
	}
	box.record(updated)

	j, err = box.m.Recover(context.Background(), j.RequestID)
	if err != nil || j.Phase != "rolled-back" {
		t.Fatal("recovery on a stale selection: ", j.Phase, err, coreFixtureStepEvidence(j, "recovery-health"))
	}
	if !bytes.Equal(box.recorded(), promoted) {
		t.Fatal("recovery did not leave the previous release's document recorded")
	}
	receipt, err := box.m.ReadReceipt()
	if err != nil || receipt.ManifestSHA256 != j.Previous.ManifestSHA256 {
		t.Fatal("recovery changed the installed release", err)
	}
	// A Spine that compares the bytes (0.6.10 continuing this recovery) accepts the result.
	if !bytes.Equal(box.recorded(), previous.Raw) {
		t.Fatal("restored selection is not the exact previous document")
	}
	entries, err := os.ReadDir(filepath.Dir(box.path))
	if err != nil || len(entries) != 1 {
		t.Fatal("temporary selection left behind", entries, err)
	}
}

package systemupdate

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
)

func coreHostRecoveryFixture(t *testing.T) (*managerFixture, CoreManager, CoreJournal, func(bool)) {
	t.Helper()
	f := newManagerFixture(t)
	if _, err := f.manager.Stage(context.Background(), f.sourceOptions()); err != nil {
		t.Fatal(err)
	}
	cm, _, _ := coreJournalFixture(t)
	previous, err := cm.ReadReceipt()
	if err != nil {
		t.Fatal(err)
	}
	source := "https://forge.example/owner/YouEye"
	makeRelease := func(version, commit string, sequence uint64) releasecache.CoreRelease {
		raw, _ := json.Marshal(previous.Release)
		var r releasecache.CoreRelease
		_ = json.Unmarshal(raw, &r)
		r.Source, r.Branch, r.Channel, r.Version, r.Tag, r.SourceCommit = source, "dev", "dev", version, "youeye-v"+version, commit
		r.Sequence = sequence
		r.Compatibility.MinimumRelease = "0.6.0-dev.26"
		for i := range r.Members {
			m := &r.Members[i]
			m.Source, m.Branch, m.SourceCommit, m.BuildVersion, m.Tag = source, "dev", commit, version, r.Tag
			if m.Role == "spine" {
				m.BuildVersion = "0.6.0"
				m.Tag = "youeye-v0.6.0"
				m.Artifact.SHA256 = strings.Repeat("a", 64)
			}
			for _, b := range []*releasecache.CoreBlob{&m.Artifact, &m.Checksums, &m.Signature, &m.Provenance, &m.SBOM, m.DocumentSignature, m.ReleaseLock} {
				if b != nil {
					b.URL = source + "/releases/download/" + m.Tag + "/" + b.Name
				}
			}
		}
		return r
	}
	previous.Release = makeRelease("0.6.0-dev.26", baselineCommit, 1)
	raw, _ := json.Marshal(previous.Release)
	previous.ManifestSHA256 = checksum(raw)
	if err = atomicWrite(filepath.Join(cm.Root, "targets", previous.ManifestSHA256+".json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	raw, _ = json.Marshal(previous)
	if err = atomicWrite(filepath.Join(cm.Root, "committed.json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	target := makeRelease("0.6.0-dev.27", targetCommit, 2)
	target.PreviousManifestSHA256 = previous.ManifestSHA256
	target.Members[2].Artifact.SHA256 = strings.Repeat("e", 64)
	j := prepareCoreFixture(t, cm, target)
	j.Phase, j.ActivationRequested = "recovering", true
	for i := range j.Steps {
		if j.Steps[i].Name == "apply-cp" {
			j.Steps[i].State = "failed"
			break
		}
		j.Steps[i].State, j.Steps[i].Evidence = "succeeded", "fixture"
	}
	for _, name := range coreRecoveryNames(j) {
		state, evidence := "succeeded", "fixture"
		if name == "recovery-host" {
			state, evidence = "started", ""
		}
		if name == "recovery-health" {
			state, evidence = "pending", ""
		}
		j.RecoverySteps = append(j.RecoverySteps, CoreStep{Name: name, RequestID: j.RequestID + "/" + name, State: state, Evidence: evidence})
	}
	if err = cm.saveCore(&j); err != nil {
		t.Fatal(err)
	}
	f.manager.config.CoreStatePath = cm.Root
	host, err := loadJournal(f.manager.config.JournalPath)
	if err != nil {
		t.Fatal(err)
	}
	host.CoreManifestSHA256, host.Phase = j.ManifestSHA256, PhaseTrial
	if err = writeJournal(f.manager.config.JournalPath, host); err != nil {
		t.Fatal(err)
	}
	boot := func(target bool) {
		t.Helper()
		version, commit, slot := "0.6.0-dev.26", baselineCommit, "A"
		if target {
			version, commit, slot = "0.6.0-dev.27", targetCommit, "B"
		}
		image := testApplianceManifest(version, commit)
		image.ReleaseSet.Source = source
		f.setCurrentManifest(t, image)
		if err := os.WriteFile(f.manager.config.KernelCmdlinePath, []byte("root=PARTLABEL=YE-SYSTEM-"+slot+" ro"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	boot(true)
	return f, cm, j, boot
}

func TestCoreHostRecoveryRequiresActualPreviousBootAndDoesNotRepeatReboot(t *testing.T) {
	for _, lost := range []bool{false, true} {
		t.Run(fmt.Sprint(lost), func(t *testing.T) {
			f, cm, j, boot := coreHostRecoveryFixture(t)
			reboots := 0
			prior := f.manager.config.Run
			f.manager.config.Run = func(ctx context.Context, name string, args ...string) ([]byte, error) {
				if name == "systemctl" {
					reboots++
					if lost {
						return nil, fmt.Errorf("lost reboot acknowledgement")
					}
				}
				return prior(ctx, name, args...)
			}
			ctx := context.Background()
			if o, err := f.manager.RecoverCoreHost(ctx, j.RequestID, true); err != nil || o.State != "unknown" || reboots != 0 {
				t.Fatal(o, err, reboots)
			}
			o, err := f.manager.RecoverCoreHost(ctx, j.RequestID, false)
			if o.State != "unknown" || reboots != 1 || (err != nil) != lost {
				t.Fatal(o, err, reboots)
			}
			for _, observe := range []bool{true, false} {
				if o, err = f.manager.RecoverCoreHost(ctx, j.RequestID, observe); err != nil || o.State != "unknown" || reboots != 1 {
					t.Fatal(o, err, reboots)
				}
			}
			boot(false)
			originalHost, _ := loadJournal(f.manager.config.JournalPath)
			if o, err = f.manager.RecoverCoreHost(ctx, j.RequestID, true); err != nil || o.State != "succeeded" || reboots != 1 {
				t.Fatal(o, err, reboots)
			}
			state, _ := appliance.LoadState(f.manager.config.StatePath)
			if state.Slots.Current != "A" || state.Slots.Candidate != "" || state.Transaction != (appliance.TransactionState{}) {
				t.Fatal(state)
			}
			if err = f.manager.CheckCoreHostCommit(); err == nil {
				t.Fatal("previous boot admitted before paired health")
			}
			finished := j
			finished.Phase = "rolled-back"
			finished.RecoverySteps = append([]CoreStep(nil), j.RecoverySteps...)
			for i := range finished.RecoverySteps {
				finished.RecoverySteps[i].State, finished.RecoverySteps[i].Evidence = "succeeded", "fixture"
			}
			if err = cm.saveCore(&finished); err != nil {
				t.Fatal(err)
			}
			if err = f.manager.CheckCoreHostCommit(); err != nil {
				t.Fatal("completed previous boot blocked", err)
			}
			if err = cm.saveCore(&j); err != nil {
				t.Fatal(err)
			}
			receipt, _ := cm.ReadReceipt()
			if receipt.ManifestSHA256 != j.Previous.ManifestSHA256 {
				t.Fatal("shared receipt changed")
			}
			// Simulate a crash after native state cleanup but before journal/receipt acknowledgement.
			if err = writeJournal(f.manager.config.JournalPath, originalHost); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(cm.Root, "host-recovery")
			entries, _ := os.ReadDir(path)
			raw, _ := os.ReadFile(filepath.Join(path, entries[0].Name()))
			var record coreHostRecovery
			_ = json.Unmarshal(raw, &record)
			record.State = "reboot-requested"
			raw, _ = json.Marshal(record)
			if err = atomicWrite(filepath.Join(path, entries[0].Name()), raw, 0600); err != nil {
				t.Fatal(err)
			}
			if o, err = f.manager.RecoverCoreHost(ctx, j.RequestID, true); err != nil || o.State != "succeeded" || reboots != 1 {
				t.Fatal(o, err, reboots)
			}
		})
	}
}

func TestCoreHostRecoveryRejectsForeignOrCommittedState(t *testing.T) {
	for _, mutation := range []string{"promoted", "foreign", "unowned-candidate", "missing-transaction", "pair-incomplete", "wrong-host"} {
		t.Run(mutation, func(t *testing.T) {
			f, cm, j, _ := coreHostRecoveryFixture(t)
			state, _ := appliance.LoadState(f.manager.config.StatePath)
			switch mutation {
			case "promoted":
				state.Slots.Current, state.Slots.CurrentImageVersion = "B", "0.6.0-dev.27"
				state.Slots.Candidate, state.Slots.CandidateImageVersion = "", ""
				state.Transaction = appliance.TransactionState{}
			case "foreign":
				state.Transaction.ID = "another"
			case "unowned-candidate":
				state.Transaction = appliance.TransactionState{}
			case "missing-transaction":
				state.Transaction = appliance.TransactionState{}
				state.Slots.Candidate, state.Slots.CandidateImageVersion = "", ""
			case "pair-incomplete":
				j.RecoverySteps[1].State = "pending"
				if err := cm.saveCore(&j); err != nil {
					t.Fatal(err)
				}
			case "wrong-host":
				f.setCurrentManifest(t, testApplianceManifest("0.6.0-dev.28", targetCommit))
			}
			if err := appliance.WriteStateAtomic(f.manager.config.StatePath, state); err != nil {
				t.Fatal(err)
			}
			f.runs = nil
			if _, err := f.manager.RecoverCoreHost(context.Background(), j.RequestID, false); err == nil {
				t.Fatal("unsafe recovery admitted")
			}
			if len(f.runs) != 0 {
				t.Fatal("effects before rejection", f.runs)
			}
		})
	}
}

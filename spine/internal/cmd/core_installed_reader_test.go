package cmd

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

func installedReaderFixture(t *testing.T) (coreInstalledReaderObserver, string) {
	t.Helper()
	root := t.TempDir()
	external := "/var/lib/youeye-state/other/youeye"
	for path, raw := range map[string][]byte{coreBakedExecutable: []byte("unchanged canonical baked Spine"), external: []byte("unregistered external Spine")} {
		path = filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, raw, 0755); err != nil {
			t.Fatal(err)
		}
	}
	o := coreInstalledReaderObserver{Root: root, Owner: uint32(os.Geteuid()), CurrentExecutable: func() (string, error) { return coreBakedExecutable, nil }}
	o.CurrentSHA256 = func() (string, error) { return o.hash(coreBakedExecutable) }
	return o, external
}

func TestInstalledReaderUnregisteredBakedAndUnknownSelf(t *testing.T) {
	o, external := installedReaderFixture(t)
	got, err := observeCoreInstalledReader(context.Background(), o)
	if err != nil || got.Bound || got.ReaderClass != "baked" {
		t.Fatal(got, err)
	}
	o.CurrentExecutable = func() (string, error) { return external, nil }
	if _, err := observeCoreInstalledReader(context.Background(), o); err == nil {
		t.Fatal("unregistered external executable accepted")
	}
}

func TestInstalledReaderHostWrapperUsesVerifiedObservation(t *testing.T) {
	o, _ := installedReaderFixture(t)
	previous := coreInstalledReaderHost
	coreInstalledReaderHost = func() coreInstalledReaderObserver { return o }
	t.Cleanup(func() { coreInstalledReaderHost = previous })
	path, bound, err := coreInstalledExecutable()
	if err != nil || path != o.path(coreBakedExecutable) || bound {
		t.Fatal(path, bound, err)
	}
}

func productionInstalledReaderFixture(t *testing.T) (coreInstalledReaderObserver, string, *coreDeploymentFixture) {
	t.Helper()
	f := newCoreDeploymentFixture(t)
	var member releasecache.CoreMember
	for _, m := range f.release.Members {
		if m.Role == "spine" {
			member = m
		}
	}
	o := coreInstalledReaderHost()
	m := systemupdate.CoreManager{Root: o.path(systemupdate.CoreStatePath)}
	raw, err := os.ReadFile(filepath.Join(f.root, "core-release.json"))
	if err != nil {
		t.Fatal(err)
	}
	digest := coreTestHash(raw)
	previous := f.release
	previous.Members = append([]releasecache.CoreMember(nil), f.release.Members...)
	for index := range previous.Members {
		if previous.Members[index].Role == "appliance" {
			previous.Members[index].Artifact.SHA256 = strings.Repeat("f", 64)
		}
	}
	journal := systemupdate.CoreJournal{Schema: systemupdate.CoreJournalSchema, RequestID: "registered-production-reader", ManifestSHA256: digest, Target: f.release, Previous: systemupdate.CoreReceipt{ManifestSHA256: strings.Repeat("e", 64), Release: previous, Machine: systemupdate.CoreMachineIdentity{InstallIDRef: "install:fixture", DeviceIDRef: "device:fixture", ParentDiskID: "disk:fixture", StatePartUUID: "state-fixture", DataPartUUID: "data-fixture"}, AcceptedAt: "2026-11-04T14:00:00Z", Evidence: "prepared native fixture"}, Phase: "prepared", RestartRequired: true}
	for _, name := range []string{"verify-members", "stage-host", "checkpoint", "activate-host", "host-health", "apply-cp", "apply-ui", "authenticated-health", "commit-host"} {
		journal.Steps = append(journal.Steps, systemupdate.CoreStep{Name: name, RequestID: journal.RequestID + "/" + name, State: "pending"})
	}
	journalRaw, _ := json.Marshal(journal)
	write := func(path string, data []byte, mode os.FileMode) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, data, mode); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(m.Root, "journal.json"), journalRaw, 0600)
	write(filepath.Join(m.Root, "targets", digest+".json"), raw, 0600)
	reader, err := m.BootstrapBinaryPath(member.Artifact.SHA256)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := os.ReadFile(f.binary)
	if err != nil {
		t.Fatal(err)
	}
	write(reader, payload, 0700)
	if _, err := m.RegisterBootstrap(journal.RequestID, digest, reader); err != nil {
		t.Fatal("real registration failed", err)
	}
	logical, err := o.logical(reader)
	if err != nil {
		t.Fatal(err)
	}
	o.CurrentExecutable = func() (string, error) { return logical, nil }
	o.CurrentSHA256 = func() (string, error) { return member.Artifact.SHA256, nil }
	return o, logical, f
}

func TestInstalledReaderProductionBootstrapPriorityUsesActualRegistration(t *testing.T) {
	o, _, _ := productionInstalledReaderFixture(t)
	got, err := observeCoreInstalledReader(context.Background(), o)
	if err != nil || got.Executable != coreBakedExecutable || got.ReaderClass != "production-bootstrap" || !got.Bound {
		t.Fatal("registered exact production self did not retain priority", got, err)
	}
	o.CurrentExecutable = func() (string, error) { return coreBakedExecutable, nil }
	o.CurrentSHA256 = func() (string, error) { return o.hash(coreBakedExecutable) }
	got, err = observeCoreInstalledReader(context.Background(), o)
	if err != nil || got.ReaderClass != "baked" || got.Bound {
		t.Fatal("canonical current self lost baked classification", got, err)
	}
}

func TestInstalledReaderProductionBootstrapRejectsForeignSelfAndChangedAuthority(t *testing.T) {
	for _, name := range []string{"foreign same bytes", "self bytes", "reader payload", "production record", "target release"} {
		t.Run(name, func(t *testing.T) {
			o, reader, _ := productionInstalledReaderFixture(t)
			switch name {
			case "foreign same bytes":
				o.CurrentExecutable = func() (string, error) { return "/tmp/other-youeye", nil }
			case "self bytes":
				o.CurrentSHA256 = func() (string, error) { return strings.Repeat("f", 64), nil }
			case "reader payload":
				if err := os.WriteFile(o.path(reader), []byte("changed"), 0700); err != nil {
					t.Fatal(err)
				}
			case "production record":
				if err := os.WriteFile(o.path(filepath.Join(systemupdate.CoreStatePath, "bootstrap-coordinator.json")), []byte(`{"schema":"corrupt"}`), 0600); err != nil {
					t.Fatal(err)
				}
			case "target release":
				m := systemupdate.CoreManager{Root: o.path(systemupdate.CoreStatePath)}
				j, err := m.Read()
				if err != nil {
					t.Fatal(err)
				}
				path := filepath.Join(m.Root, "targets", j.ManifestSHA256+".json")
				if err := os.WriteFile(path, []byte(`{"changed":true}`), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := observeCoreInstalledReader(context.Background(), o); err == nil {
				t.Fatal("production permission leaked or changed protected authority accepted")
			}
		})
	}
}

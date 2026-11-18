package systemupdate

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

func TestCoreControlDeliveryDoesNotRepeatLostLaunch(t *testing.T) {
	for _, lose := range []string{"none", "before", "after"} {
		t.Run(lose, func(t *testing.T) {
			m, _, target := coreJournalFixture(t)
			j := prepareCoreFixture(t, m, target)
			launches := 0
			exists := false
			foreign := false
			workingDirectory := ""
			rootDirectory := ""
			runner := CoreControlRunner{Root: m.Root, Executable: "/usr/local/bin/youeye"}
			runner.Capture = func(_ context.Context, name string, args ...string) ([]byte, error) {
				if name == "systemd-run" {
					launches++
					if lose == "before" {
						return nil, fmt.Errorf("lost before submission")
					}
					exists = true
					if lose == "after" {
						return nil, fmt.Errorf("lost after submission")
					}
					return nil, nil
				}
				if name != "systemctl" {
					t.Fatalf("unexpected program %s", name)
				}
				unit := args[len(args)-1]
				if !exists {
					return []byte("Id=" + unit + "\nLoadState=not-found\n"), nil
				}
				user := "root"
				if foreign {
					user = "nobody"
				}
				return []byte("Id=" + unit + "\nLoadState=loaded\nActiveState=active\nSubState=running\nResult=success\nMainPID=123\nDescription=YouEye core continuation " + unit + "\nTransient=yes\nType=exec\nUser=" + user + "\nWorkingDirectory=" + workingDirectory + "\nRootDirectory=" + rootDirectory + "\nRootImage=\nKillMode=control-group\nRestart=no\nRemainAfterExit=yes\n"), nil
			}
			out, err := runner.Start(context.Background(), j.RequestID, "delivery-1")
			if lose == "before" {
				if err == nil || out.State != "unknown" {
					t.Fatal(out, err)
				}
			} else if err != nil || out.State != "running" {
				t.Fatal(out, err)
			}
			out, err = runner.Start(context.Background(), j.RequestID, "delivery-1")
			want := "running"
			if lose == "before" {
				want = "unknown"
			}
			if err != nil || out.State != want || launches != 1 {
				t.Fatal(out, err, launches)
			}
			if lose != "before" {
				workingDirectory = "/"
				if _, err := runner.Start(context.Background(), j.RequestID, "delivery-1"); err != nil {
					t.Fatal("explicit host root rejected", err)
				}
				workingDirectory = "/foreign"
				if _, err := runner.Start(context.Background(), j.RequestID, "delivery-1"); err == nil {
					t.Fatal("foreign working directory admitted")
				}
				workingDirectory, rootDirectory = "", "/foreign"
				if _, err := runner.Start(context.Background(), j.RequestID, "delivery-1"); err == nil {
					t.Fatal("chroot admitted")
				}
				rootDirectory = ""
			}
			exists, foreign = true, true
			if _, err = runner.Start(context.Background(), j.RequestID, "delivery-1"); err == nil || launches != 1 {
				t.Fatal("adopted foreign unit", err, launches)
			}
			if _, err = runner.Start(context.Background(), "foreign-request", "delivery-2"); err == nil || launches != 1 {
				t.Fatal("admitted wrong graph", err, launches)
			}
		})
	}
}
func TestCoreActivationAdmissionRequiresCompletedStageAndKeepsOneRequest(t *testing.T) {
	m, e, target := coreJournalFixture(t)
	target.Members[2].Artifact.SHA256 = strings.Repeat("e", 64)
	j := prepareCoreFixture(t, m, target)
	if _, err := m.RequestActivation(context.Background(), j.RequestID, j.ManifestSHA256); err == nil {
		t.Fatal("incomplete stage armed")
	}
	j, err := m.Advance(context.Background(), j.RequestID, false)
	if err != nil || j.Phase != "awaiting-restart" {
		t.Fatal(j.Phase, err)
	}
	if _, err = m.RequestActivation(context.Background(), j.RequestID, strings.Repeat("a", 64)); err == nil {
		t.Fatal("wrong manifest armed")
	}
	e.denyActivation = true
	if _, err = m.RequestActivation(context.Background(), j.RequestID, j.ManifestSHA256); err == nil {
		t.Fatal("revoked target armed")
	}
	e.denyActivation = false
	j, err = m.RequestActivation(context.Background(), j.RequestID, j.ManifestSHA256)
	if err != nil || !j.ActivationRequested || j.Phase != "applying" || e.starts["checkpoint"] != 0 {
		t.Fatal(j.Phase, err, e.starts)
	}
	again, err := m.RequestActivation(context.Background(), j.RequestID, j.ManifestSHA256)
	if err != nil || again.UpdatedAt != j.UpdatedAt || e.starts["checkpoint"] != 0 {
		t.Fatal("repeated admission changed effects", err)
	}
}

// A finished request leaves no failed units behind; an unfinished one keeps
// every unit, and reset-failed is never called without a unit name.
func TestCoreFinishedRequestResetsOnlyItsOwnFailedUnits(t *testing.T) {
	m, _, target := coreJournalFixture(t)
	j := prepareCoreFixture(t, m, target)
	j.Steps[0].State, j.Steps[0].Evidence = "failed", "fixture failure"
	control := CoreControlRunner{Root: m.Root, Executable: "/usr/local/bin/youeye"}
	control.Capture = func(_ context.Context, name string, args ...string) ([]byte, error) {
		if name == "systemd-run" {
			return nil, nil
		}
		return []byte("Id=" + args[len(args)-1] + "\nLoadState=not-found\n"), nil
	}
	for _, command := range []string{"delivery-1", "delivery-2"} {
		if _, err := control.Start(context.Background(), j.RequestID, command); err != nil {
			t.Fatal(err)
		}
	}
	// A continuation of another request is not ours to reset.
	foreign := CoreControlReceipt{Schema: "youeye.core-control.v1", RequestID: "another-request", CommandID: "delivery-1", ManifestSHA256: j.ManifestSHA256, Unit: "youeye-core-control-" + strings.Repeat("f", 64) + ".service", Executable: "/usr/local/bin/youeye"}
	raw, _ := json.Marshal(foreign)
	if err := atomicWrite(filepath.Join(m.Root, "controllers", foreign.Unit+".json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	var calls [][]string
	runner := CoreSystemdRunner{Root: m.Root, Executable: "/usr/local/bin/youeye", Capture: func(_ context.Context, name string, args ...string) ([]byte, error) {
		calls = append(calls, append([]string{name}, args...))
		return nil, fmt.Errorf("Unit not loaded")
	}}
	for _, phase := range []string{"prepared", "applying", "needs-recovery", "recovering", "cancelling", "awaiting-restart"} {
		j.Phase = phase
		if units := runner.ResetFailedUnits(context.Background(), j); units != nil || len(calls) != 0 {
			t.Fatal("reset units of an unfinished request", phase, units, calls)
		}
	}
	for _, phase := range []string{"cancelled", "committed", "rolled-back"} {
		calls = nil
		j.Phase = phase
		units := runner.ResetFailedUnits(context.Background(), j)
		if len(calls) != 1 || calls[0][0] != "systemctl" || calls[0][1] != "reset-failed" || len(calls[0]) != 2+len(units) {
			t.Fatal(phase, calls)
		}
		// One started action and two continuations; pending actions never ran.
		want := map[string]bool{runner.unit(j, j.Steps[0]): true}
		for _, command := range []string{"delivery-1", "delivery-2"} {
			want[fmt.Sprintf("youeye-core-control-%x.service", sha256.Sum256([]byte(j.RequestID+"\x00"+command)))] = true
		}
		if len(units) != len(want) {
			t.Fatal(phase, units)
		}
		for _, unit := range units {
			if !want[unit] || unit == foreign.Unit {
				t.Fatal("reset a unit that is not this request's", unit)
			}
		}
	}
	// Nothing ran: no unit, so no call (a bare reset-failed clears the whole host).
	calls = nil
	empty := CoreJournal{RequestID: "never-ran", ManifestSHA256: j.ManifestSHA256, Phase: "cancelled", Steps: []CoreStep{{Name: "verify-members", RequestID: "never-ran/verify-members", State: "pending"}}}
	if units := runner.ResetFailedUnits(context.Background(), empty); units != nil || len(calls) != 0 {
		t.Fatal("reset-failed without a unit", units, calls)
	}
}

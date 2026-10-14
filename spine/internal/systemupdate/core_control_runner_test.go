package systemupdate

import (
	"context"
	"fmt"
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

package systemupdate

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStoppedRecoveryReadsOnlyExactBoundHostData(t *testing.T) {
	for _, role := range []string{"cp", "ui"} {
		for _, mode := range []string{"bound", "foreign-source", "shadow", "unsafe-file"} {
			t.Run(role+mode, func(t *testing.T) {
				p := NativeCoreCheckpoint{DataRoot: t.TempDir()}
				name := "youeye-control"
				relative := "state/core-component-schemas"
				destination := "/var/lib/youeye"
				source := p.DataRoot
				if role == "ui" {
					name = "youeye-ui"
					relative = "ui-data/.core-component-schemas"
					destination += "/ui-data"
					source = filepath.Join(source, "ui-data")
				}
				dir := filepath.Join(p.DataRoot, relative)
				if err := os.MkdirAll(dir, 0700); err != nil {
					t.Fatal(err)
				}
				permissions := os.FileMode(0600)
				if mode == "unsafe-file" {
					permissions = 0666
				}
				if err := os.WriteFile(filepath.Join(dir, "fixture.json"), []byte("retained receipt"), permissions); err != nil {
					t.Fatal(err)
				}
				if mode == "foreign-source" {
					source = filepath.Join(p.DataRoot, "foreign")
				}
				a := coreCompletionContainer{Devices: map[string]map[string]string{"data": {"type": "disk", "path": destination, "source": source, "shift": "true"}}}
				if mode == "shadow" {
					a.Devices["shadow"] = map[string]string{"type": "disk", "path": "/var/lib/youeye/" + relative, "source": source, "shift": "true"}
				}
				raw, err := p.recoveredSchemaReader(a)(context.Background(), name, "/var/lib/youeye/"+relative+"/fixture.json", 4096, 0600)
				if (err == nil) != (mode == "bound") {
					t.Fatal(mode, err)
				}
				if err == nil && string(raw) != "retained receipt" {
					t.Fatal("wrong Data receipt")
				}
			})
		}
	}
}

func TestRecoveredPowerNewBootNeverRepeatsUncertainStart(t *testing.T) {
	for _, mode := range []string{"lost-after", "lost-before", "same-boot", "observe", "foreign-owner"} {
		t.Run(mode, func(t *testing.T) {
			m, _, target := coreJournalFixture(t)
			j := prepareCoreFixture(t, m, target)
			j.Phase = "recovering"
			p := NativeCoreCheckpoint{Root: m.Root, DataRoot: t.TempDir(), MachineObservation: func() (CoreMachineIdentity, error) { return j.Previous.Machine, nil }, recoveryPreviousBoot: "11111111-1111-1111-1111-111111111111", recoveryCurrentBoot: "22222222-2222-2222-2222-222222222222"}
			if mode == "same-boot" {
				p.recoveryCurrentBoot = p.recoveryPreviousBoot
			}
			if err := (CoreLifecycleBarrier{Root: filepath.Join(p.DataRoot, "state", "app-updates")}).Begin(j); err != nil {
				t.Fatal(err)
			}
			c := CoreCheckpointContainer{Name: "youeye-caddy", UUID: "fixture", Running: true}
			a := coreCompletionContainer{Status: "Stopped", Config: map[string]string{"volatile.uuid": c.UUID, "user.youeye.core-request": j.RequestID, "boot.autostart": "false"}}
			if mode == "foreign-owner" {
				a.Config["user.youeye.core-request"] = "foreign"
			}
			starts := 0
			p.Capture = func(_ context.Context, _ string, args ...string) ([]byte, error) {
				if args[0] == "query" {
					if args[1] == "/1.0/operations?recursion=1" {
						return []byte(coreProviderResponse(`{}`)), nil
					}
					return json.Marshal(a)
				}
				if args[0] == "start" {
					starts++
					if mode != "lost-before" {
						a.Status = "Running"
					}
					return nil, fmt.Errorf("lost acknowledgement")
				}
				t.Fatal(args)
				return nil, nil
			}
			_, err := p.resumeRecoveredPower(context.Background(), j, c, a, mode == "observe")
			if (err == nil) != (mode == "lost-after") {
				t.Fatal(mode, err)
			}
			if mode == "lost-after" || mode == "lost-before" {
				for _, observe := range []bool{true, false} {
					_, err = p.resumeRecoveredPower(context.Background(), j, c, a, observe)
					if (err == nil) != (mode == "lost-after") {
						t.Fatal(err)
					}
				}
				if starts != 1 {
					t.Fatal("repeated start", starts)
				}
			} else if starts != 0 {
				t.Fatal("inadmissible start")
			}
		})
	}
}

func TestStoppedRecoveredSchemaMustAlreadyBeCompleted(t *testing.T) {
	for _, mode := range []string{"complete", "wrong-marker", "requested", "unreadable", "wrong-role"} {
		t.Run(mode, func(t *testing.T) {
			marker := coreComponentMarker{Schema: "youeye.core-component.v1", RequestID: "fixture", ManifestSHA256: strings.Repeat("a", 64), ArtifactSHA256: strings.Repeat("b", 64), Role: "cp"}
			name := "youeye-control"
			if mode == "wrong-role" {
				name = "youeye-ui"
			}
			reads := 0
			err := verifyStoppedRecoveredSchema(context.Background(), name, marker, func(_ context.Context, container, path string, limit int64, permissions uint32) ([]byte, error) {
				reads++
				if container != name || permissions != 0600 || limit != 4096 {
					t.Fatal("unprotected read")
				}
				if mode == "unreadable" {
					return nil, fmt.Errorf("unavailable")
				}
				if path == "/etc/youeye/core-component.json" {
					m := marker
					if mode == "wrong-marker" {
						m.ArtifactSHA256 = strings.Repeat("c", 64)
					}
					return json.Marshal(m)
				}
				state := "completed"
				if mode == "requested" {
					state = "requested"
				}
				return json.Marshal(struct {
					coreComponentMarker
					State string `json:"state"`
				}{marker, state})
			})
			if (err == nil) != (mode == "complete") {
				t.Fatal(mode, err)
			}
			if mode == "wrong-role" && reads != 0 {
				t.Fatal("foreign role inspected")
			}
		})
	}
}

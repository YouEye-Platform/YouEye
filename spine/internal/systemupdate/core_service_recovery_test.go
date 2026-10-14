package systemupdate

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRecoveredUnitsObserveLostStartWithoutRepeatingIt(t *testing.T) {
	for _, lostBefore := range []bool{false, true} {
		t.Run(fmt.Sprint(lostBefore), func(t *testing.T) {
			starts := 0
			active := false
			s := NativeCoreServices{Checkpoint: NativeCoreCheckpoint{Capture: func(_ context.Context, program string, args ...string) ([]byte, error) {
				if program != "incus" || len(args) < 5 || args[0] != "exec" || args[1] != "youeye-control" || args[2] != "--" || args[3] != "systemctl" {
					t.Fatal("wrong recovery command")
				}
				switch args[4] {
				case "daemon-reload":
					return nil, nil
				case "start":
					starts++
					if strings.Join(args[5:], " ") != "youeye-control youeye-id" {
						t.Fatal("wrong recovery units")
					}
					active = !lostBefore
					return nil, fmt.Errorf("lost start acknowledgement")
				case "is-active":
					if active {
						return []byte("active\n"), nil
					}
					return []byte("inactive\n"), fmt.Errorf("inactive")
				}
				t.Fatal("unexpected recovery effect")
				return nil, nil
			}}}
			err := s.startHeldCoreUnits(context.Background(), "youeye-control", "cp", true)
			if (err != nil) != lostBefore {
				t.Fatal(err)
			}
			err = s.startHeldCoreUnits(context.Background(), "youeye-control", "cp", false)
			if (err != nil) != lostBefore || starts != 1 {
				t.Fatal("lost start was replayed or absence was accepted", err, starts)
			}
		})
	}
}

func TestRecoveredCPSelectionRequiresBothOriginalSignedFiles(t *testing.T) {
	rootPath := t.TempDir()
	dir := filepath.Join(rootPath, "var/lib/youeye-state/core-selection")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	selection := CoreHostSelection{Raw: []byte(`{"fixture":"previous signed release"}`), Signature: []byte(strings.Repeat("s", 64))}
	for name, raw := range map[string][]byte{"core-release.json": selection.Raw, "core-release.json.sig": selection.Signature} {
		if err := os.WriteFile(filepath.Join(dir, name), raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	root, err := os.Open(rootPath)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	if err = verifyRecoveredCoreSelection(root, selection); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dir, "core-release.json.sig"), []byte(strings.Repeat("x", 64)), 0600); err != nil {
		t.Fatal(err)
	}
	if err = verifyRecoveredCoreSelection(root, selection); err == nil {
		t.Fatal("mixed historical/new signature pair accepted")
	}
}

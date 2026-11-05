package cmd

import (
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

func TestCoreAPIReaderOnlyRegistersForUnfinishedStage(t *testing.T) {
	b := &coreAPIReaderBridge{executable: "/protected/signed/youeye", digest: strings.Repeat("a", 64)}
	j := systemupdate.CoreJournal{RequestID: "owner-stage", ManifestSHA256: b.digest}
	for _, action := range []string{"check", "status", "resume", "activate", "recover", "cancel"} {
		t.Run(action, func(t *testing.T) {
			bound, err := b.bindStage(action, j, false,
				func(string, string, string) (string, error) { t.Fatal("registered before owner Stage"); return "", nil },
				func(string) error { t.Fatal("changed boot continuation before owner Stage"); return nil })
			if bound || err != nil {
				t.Fatal(bound, err)
			}
		})
	}
	bound, err := b.bindStage("stage", j, true,
		func(string, string, string) (string, error) {
			t.Fatal("registered a completed historical request")
			return "", nil
		},
		func(string) error { t.Fatal("changed boot continuation for completed request"); return nil })
	if bound || err != nil {
		t.Fatal(bound, err)
	}
	for _, phase := range []string{"committed", "cancelled", "rolled-back"} {
		terminal := j
		terminal.Phase = phase
		if bound, err := b.bindStage("stage", terminal, false,
			func(string, string, string) (string, error) {
				t.Fatal("registered during terminal maintenance cleanup")
				return "", nil
			},
			func(string) error { t.Fatal("changed boot continuation during terminal cleanup"); return nil }); bound || err != nil {
			t.Fatal(bound, err)
		}
	}
	var events []string
	bound, err = b.bindStage("stage", j, false,
		func(request, digest, executable string) (string, error) {
			if request != j.RequestID || digest != b.digest || executable != b.executable {
				t.Fatal("reader was not bound to the exact owner request")
			}
			events = append(events, "register")
			return executable, nil
		}, func(executable string) error {
			if executable != b.executable {
				t.Fatal("boot continuation changed coordinator")
			}
			events = append(events, "boot-override")
			return nil
		})
	if !bound || err != nil || !reflect.DeepEqual(events, []string{"register", "boot-override"}) {
		t.Fatal(bound, events, err)
	}
}

func TestCoreAPIReaderRejectsStaleTargetAndRegistrationFailure(t *testing.T) {
	b := &coreAPIReaderBridge{executable: "/protected/signed/youeye", digest: strings.Repeat("a", 64)}
	j := systemupdate.CoreJournal{RequestID: "owner-stage", ManifestSHA256: strings.Repeat("b", 64)}
	if _, err := b.bindStage("stage", j, false,
		func(string, string, string) (string, error) { t.Fatal("registered a stale selection"); return "", nil },
		func(string) error { t.Fatal("changed boot continuation for stale selection"); return nil }); err == nil {
		t.Fatal("accepted a different manifest")
	}
	j.ManifestSHA256 = b.digest
	for _, failure := range []string{"revoked", "substituted reader"} {
		t.Run(failure, func(t *testing.T) {
			if _, err := b.bindStage("stage", j, false,
				func(string, string, string) (string, error) {
					if failure == "revoked" {
						return "", fmt.Errorf("revoked")
					}
					return "/unrelated/youeye", nil
				}, func(string) error { t.Fatal("changed boot continuation after rejected registration"); return nil }); err == nil {
				t.Fatal("accepted failed reader registration")
			}
		})
	}
}

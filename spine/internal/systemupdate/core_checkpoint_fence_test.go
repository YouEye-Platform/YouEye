package systemupdate

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestCoreProviderFenceRejectsLiveUnknownAndMalformedOperations(t *testing.T) {
	for _, test := range []struct {
		raw string
		ok  bool
	}{
		{`{}`, true},
		{`{"success":[{"id":"old","class":"task","status_code":200}]}`, true},
		{`{"failure":[{"id":"old","class":"websocket","status_code":400}]}`, true},
		{`{"cancelled":[{"id":"old","class":"task","status_code":401}]}`, true},
		{`{"running":[{"id":"enrollment","class":"token","status_code":103}]}`, true},
		{`{"running":[{"id":"writer","class":"websocket","status_code":103}]}`, false},
		{`{"cancelling":[{"id":"writer","class":"task","status_code":104}]}`, false},
		{`{"success":[{"id":"writer","class":"unknown","status_code":200}]}`, false},
		{`{"success":[{"id":"writer","class":"task","status_code":999}]}`, false},
		{`null`, false},
		{`{"running":[{"class":"task","status_code":200}]}`, false},
	} {
		p := NativeCoreCheckpoint{Capture: func(_ context.Context, program string, args ...string) ([]byte, error) {
			if program != "incus" || strings.Join(args, " ") != "query /1.0/operations?recursion=1" {
				t.Fatal("unexpected provider effect")
			}
			return []byte(test.raw), nil
		}}
		if err := p.requireProviderSettled(context.Background()); (err == nil) != test.ok {
			t.Fatal(test.raw, err)
		}
	}
}

func TestCoreRecoveryFenceRequiresNativeProviderAndDatabaseSettlement(t *testing.T) {
	p, j := abortedCheckpointFixture(t)
	j.RecoverySteps[0].State, j.RecoverySteps[0].Evidence = "started", ""
	j.RecoverySteps[1].State = "pending"
	if err := (CoreManager{Root: p.Root}).saveCore(&j); err != nil {
		t.Fatal(err)
	}
	native := p.Capture
	providerRunning := true
	nftWrites := 0
	p.Capture = func(ctx context.Context, program string, args ...string) ([]byte, error) {
		if program == "nft" {
			if args[0] == "--json" {
				return []byte(`{"nftables":[]}`), nil
			}
			nftWrites++
			return nil, nil
		}
		if program == "incus" {
			if args[0] == "config" && args[1] == "set" {
				return nil, nil
			}
			if args[0] == "query" {
				if args[1] == "/1.0/operations?recursion=1" {
					if providerRunning {
						return []byte(`{"running":[{"id":"remote-writer","class":"websocket","status_code":103}]}`), nil
					}
					return []byte(`{}`), nil
				}
				for _, name := range []string{"youeye-control", "youeye-ui"} {
					if args[1] == "/1.0/instances/"+name {
						return json.Marshal(map[string]any{"status": "Stopped", "config": map[string]string{"volatile.uuid": "fixture-" + name}})
					}
				}
			}
		}
		return native(ctx, program, args...)
	}
	runner := CoreSystemdRunner{Root: p.Root, Executable: "/usr/local/bin/youeye", CgroupRoot: t.TempDir(), BootID: func() (string, error) { return "fixture-boot", nil }, Capture: func(_ context.Context, program string, args ...string) ([]byte, error) {
		if program != "systemctl" || len(args) != 3 || args[0] != "show" {
			return nil, fmt.Errorf("unexpected native effect")
		}
		return []byte("Id=" + args[2] + "\nLoadState=not-found\n"), nil
	}}
	if _, err := p.Fence(context.Background(), j.RequestID, runner); err == nil || nftWrites != 1 {
		t.Fatal("accepted live remote operation", err, nftWrites)
	}
	providerRunning = false
	evidence, err := p.Fence(context.Background(), j.RequestID, runner)
	if err != nil || !strings.Contains(evidence, "closed SQL writers") {
		t.Fatal(evidence, err)
	}
	record, err := p.Read(j)
	if err != nil || record.Phase != "files-captured" {
		t.Fatal("fence pretended to capture or restore", record.Phase, err)
	}
}

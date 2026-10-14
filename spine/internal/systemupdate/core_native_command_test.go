package systemupdate

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestCoreNativeIncusProjectBoundary(t *testing.T) {
	for _, tc := range []struct {
		name       string
		args, want []string
	}{
		{"query", []string{"query", "/1.0/instances/youeye-control/state"}, []string{"--force-local", "query", "/1.0/instances/youeye-control/state?project=default"}},
		{"recursive", []string{"query", "/1.0/operations?recursion=1"}, []string{"--force-local", "query", "/1.0/operations?project=default&recursion=1"}},
		{"explicit", []string{"query", "/1.0/instances/youeye-ui?project=default"}, []string{"--force-local", "query", "/1.0/instances/youeye-ui?project=default"}},
		{"ordinary", []string{"network", "get", "incusbr0", "ipv4.address"}, []string{"--force-local", "--project", "default", "network", "get", "incusbr0", "ipv4.address"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := coreNativeIncusArgs(tc.args)
			if err != nil || !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %v, %v; want %v", got, err, tc.want)
			}
		})
	}
	for _, args := range [][]string{
		nil, {"query"}, {"query", "/1.0/instances", "--request=DELETE"},
		{"query", "https://peer.example/1.0/instances"}, {"query", "peer:/1.0/instances"},
		{"query", "/1.0/instances?project=other"}, {"query", "/1.0/instances?project="},
		{"query", "/1.0/instances?project=default&project=other"},
		{"query", "/1.0/instances?project=default&project=default"},
		{"query", "/1.0/instances?bad=%ZZ"}, {"query", "/1.0/%2e%2e/instances"},
	} {
		if _, err := coreNativeIncusArgs(args); err == nil {
			t.Fatalf("accepted unbound query %v", args)
		}
	}
}

func TestCoreNativeCaptureUsesIncusRawQueryContract(t *testing.T) {
	bin := t.TempDir()
	// Match the installed Incus contract: query rejects global --project and
	// this fixture additionally requires our explicit default-project URI.
	script := "#!/bin/sh\n[ \"$1\" = --force-local ] || exit 10\nshift\n[ \"$1\" = query ] || exit 11\n[ \"$2\" = '/1.0/instances/youeye-control/state?project=default' ] || exit 12\nprintf '%s\\n' '{\"status\":\"Running\"}'\n"
	if err := os.WriteFile(filepath.Join(bin, "incus"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin)
	raw, err := captureCoreNative(context.Background(), "incus", "query", "/1.0/instances/youeye-control/state")
	if err != nil || string(raw) != "{\"status\":\"Running\"}\n" {
		t.Fatalf("raw query failed: %q, %v", raw, err)
	}
}

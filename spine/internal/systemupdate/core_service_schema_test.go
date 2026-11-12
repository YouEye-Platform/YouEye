package systemupdate

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCoreSchemaHTTPBindsIdentityAndAuthority(t *testing.T) {
	expected := coreComponentMarker{Schema: "youeye.core-component.v1", Role: "cp", RequestID: "update-1", ManifestSHA256: checksum([]byte("manifest")), ArtifactSHA256: checksum([]byte("artifact"))}
	for _, mode := range []string{"completed", "pending", "started", "unknown", "foreign", "legacy", "oversize", "rejected", "bad-state"} {
		t.Run(mode, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("X-CLI-Token") != "fixture-credential" {
					t.Error("missing exact native credential")
				}
				if r.Method != "POST" || r.ContentLength <= 0 || r.ContentLength > 4096 {
					t.Error("unbounded native POST")
				}
				var body coreComponentMarker
				if json.NewDecoder(r.Body).Decode(&body) != nil || body != expected {
					t.Error("wrong component request")
				}
				if mode == "oversize" {
					io.WriteString(w, strings.Repeat("x", 16385))
					return
				}
				if mode == "rejected" {
					w.WriteHeader(403)
					return
				}
				result := coreSchemaObservation{coreComponentMarker: expected, Managed: true, State: mode}
				if mode == "foreign" {
					result.RequestID = "another"
					result.State = "completed"
				}
				if mode == "legacy" {
					result.Managed = false
					result.State = "completed"
				}
				json.NewEncoder(w).Encode(result)
			}))
			defer server.Close()
			result, err := coreSchemaRequest(context.Background(), server.Client(), server.URL, "X-CLI-Token", "fixture-credential", expected, true)
			valid := mode == "completed" || mode == "pending" || mode == "started" || mode == "unknown"
			if (err == nil) != valid {
				t.Fatal(mode, result.State, err)
			}
			if valid && result.State != mode {
				t.Fatal("changed durable state", result.State)
			}
		})
	}
}

func TestCoreSchemaGETDoesNotStartEffects(t *testing.T) {
	expected := coreComponentMarker{Schema: "youeye.core-component.v1", Role: "ui", RequestID: "install-baseline", ManifestSHA256: checksum([]byte("manifest")), ArtifactSHA256: checksum([]byte("artifact"))}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.ContentLength != 0 || r.Header.Get("X-UI-Bridge-Token") != "fixture" {
			t.Error("observation performed effects or lost scope")
		}
		json.NewEncoder(w).Encode(coreSchemaObservation{coreComponentMarker: expected, Managed: true, State: "started"})
	}))
	defer server.Close()
	result, err := coreSchemaRequest(context.Background(), server.Client(), server.URL, "X-UI-Bridge-Token", "fixture", expected, false)
	if err != nil || result.State != "started" {
		t.Fatal(result, err)
	}
}

func TestCoreSchemaAddressMustBelongToExactPrivateContainer(t *testing.T) {
	for _, mode := range []string{"valid", "public", "wrong-prefix", "wrong-address", "loopback", "stopped"} {
		t.Run(mode, func(t *testing.T) {
			s := NativeCoreServices{Checkpoint: NativeCoreCheckpoint{Capture: func(_ context.Context, program string, args ...string) ([]byte, error) {
				if program != "incus" {
					return nil, fmt.Errorf("unexpected")
				}
				if args[0] == "network" {
					subnet := "10.75.26.1/24"
					if mode == "public" {
						subnet = "203.0.113.1/24"
					}
					if mode == "wrong-prefix" {
						subnet = "10.75.26.1/16"
					}
					return []byte(subnet), nil
				}
				address, device, status := "10.75.26.16", "eth0", "Running"
				if mode == "wrong-address" {
					address = "10.75.26.17"
				}
				if mode == "loopback" {
					device = "lo"
				}
				if mode == "stopped" {
					status = "Stopped"
				}
				return []byte(fmt.Sprintf(`{"status":%q,"network":{%q:{"addresses":[{"family":"inet","scope":"global","address":%q}]}}}`, status, device, address)), nil
			}}}
			address, err := s.componentAddress(context.Background(), "youeye-control", "incusbr0")
			if (err == nil) != (mode == "valid") {
				t.Fatal(address, err)
			}
		})
	}
}

func TestCoreSchemaStartedReceiptDoesNotClaimExecutorLiveness(t *testing.T) {
	for _, state := range []string{"pending", "started", "unknown"} {
		result := coreSchemaActionObservation(coreSchemaObservation{coreComponentMarker: coreComponentMarker{Role: "cp"}, Managed: true, State: state})
		if result.State != "unknown" {
			t.Fatal("nonterminal receipt claimed completion/liveness", state, result.State)
		}
	}
}

func TestCoreSchemaCompletionRequiresNativeDurableReceipt(t *testing.T) {
	marker := coreComponentMarker{Schema: "youeye.core-component.v1", Role: "ui", RequestID: "update-1", ManifestSHA256: checksum([]byte("manifest")), ArtifactSHA256: checksum([]byte("artifact"))}
	root := t.TempDir()
	path := filepath.Join(root, "var/lib/youeye/ui-data/.core-component-schemas")
	if err := os.MkdirAll(path, 0700); err != nil {
		t.Fatal(err)
	}
	dir, err := os.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer dir.Close()
	key := checksum([]byte(strings.Join([]string{marker.Role, marker.RequestID, marker.ManifestSHA256, marker.ArtifactSHA256}, "\x00")))
	file := filepath.Join(path, key+".json")
	if err = verifyCoreSchemaReceiptAt(dir, marker); err == nil {
		t.Fatal("accepted absent durable receipt")
	}
	for _, state := range []string{"started", "unknown", "completed"} {
		raw, _ := json.Marshal(struct {
			coreComponentMarker
			State string `json:"state"`
		}{marker, state})
		if err = os.WriteFile(file, raw, 0600); err != nil {
			t.Fatal(err)
		}
		if got := verifyCoreSchemaReceiptAt(dir, marker); (got == nil) != (state == "completed") {
			t.Fatal(state, got)
		}
	}
	if err = os.Chmod(file, 0666); err != nil {
		t.Fatal(err)
	}
	if err = verifyCoreSchemaReceiptAt(dir, marker); err == nil {
		t.Fatal("accepted writable receipt")
	}
}

package incus

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestPrepareNetworkProcessStateDoesNotTrustReusedPIDs(t *testing.T) {
	for _, tc := range []struct {
		name, executable, network string
		missing, keep             bool
	}{
		{name: "previous boot PID now belongs to daemon", executable: "incusd", network: "incusbr0"},
		{name: "previous boot PID now belongs to unrelated process", executable: "sleep", network: "incusbr0"},
		{name: "previous boot PID absent", missing: true},
		{name: "live helper survives same boot daemon restart", executable: "dnsmasq", network: "incusbr0", keep: true},
		{name: "different network helper cannot validate record", executable: "dnsmasq", network: "yeapp1"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			networks, proc := filepath.Join(root, "networks"), filepath.Join(root, "proc")
			network := filepath.Join(networks, "incusbr0")
			if err := os.MkdirAll(network, 0700); err != nil {
				t.Fatal(err)
			}
			record := []byte("name: dnsmasq\npid: 959\nargs: [--keep-in-foreground]\n")
			path := filepath.Join(network, "dnsmasq.pid")
			if err := os.WriteFile(path, record, 0600); err != nil {
				t.Fatal(err)
			}
			for _, name := range []string{"dnsmasq.raw", "dnsmasq.leases", "dnsmasq.hosts"} {
				if err := os.WriteFile(filepath.Join(network, name), []byte("retained "+name), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if !tc.missing {
				p := filepath.Join(proc, "959")
				if err := os.MkdirAll(p, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink("/usr/sbin/"+tc.executable, filepath.Join(p, "exe")); err != nil {
					t.Fatal(err)
				}
				args := tc.executable + "\x00--interface=" + tc.network + "\x00--conf-file=" + filepath.Join(networks, tc.network, "dnsmasq.raw") + "\x00"
				if err := os.WriteFile(filepath.Join(p, "cmdline"), []byte(args), 0600); err != nil {
					t.Fatal(err)
				}
			}
			for i := 0; i < 2; i++ {
				if err := prepareNetworkProcessState(networks, proc); err != nil {
					t.Fatal(err)
				}
			}
			got, err := os.ReadFile(path)
			if tc.keep {
				if err != nil || !bytes.Equal(got, record) {
					t.Fatalf("live process record changed: %v", err)
				}
			} else if !os.IsNotExist(err) {
				t.Fatalf("stale record remains: %v", err)
			}
			for _, name := range []string{"dnsmasq.raw", "dnsmasq.leases", "dnsmasq.hosts"} {
				got, err := os.ReadFile(filepath.Join(network, name))
				if err != nil || string(got) != "retained "+name {
					t.Fatalf("persistent %s changed: %v", name, err)
				}
			}
		})
	}
}

func TestPrepareNetworkProcessStateRejectsUnsafeRecords(t *testing.T) {
	for _, value := range []string{"name: other\npid: 1\n", "name: dnsmasq\npid: 0\n", "name: [malformed\n"} {
		root := t.TempDir()
		network := filepath.Join(root, "incusbr0")
		if err := os.Mkdir(network, 0700); err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(network, "dnsmasq.pid")
		if err := os.WriteFile(path, []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
		if err := prepareNetworkProcessState(root, filepath.Join(root, "proc")); err == nil {
			t.Fatal("invalid record accepted")
		}
		got, err := os.ReadFile(path)
		if err != nil || string(got) != value {
			t.Fatal("invalid record silently removed")
		}
	}
	root := t.TempDir()
	network := filepath.Join(root, "incusbr0")
	if err := os.Mkdir(network, 0700); err != nil {
		t.Fatal(err)
	}
	protected := filepath.Join(root, "protected")
	if err := os.WriteFile(protected, []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(protected, filepath.Join(network, "dnsmasq.pid")); err != nil {
		t.Fatal(err)
	}
	if err := prepareNetworkProcessState(root, filepath.Join(root, "proc")); err == nil {
		t.Fatal("symlink record accepted")
	}
	got, err := os.ReadFile(protected)
	if err != nil || string(got) != "preserve" {
		t.Fatal("symlink target changed")
	}
}

func TestPrepareNetworkProcessStateBeforeFirstNetwork(t *testing.T) {
	root := t.TempDir()
	if err := prepareNetworkProcessState(filepath.Join(root, "not-created"), filepath.Join(root, "proc")); err != nil {
		t.Fatal(err)
	}
}

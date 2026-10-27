package util

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// Reproduce a cold boot where app bridges precede the DHCP LAN interface.
// The old text-only detector loses the interface identity and selects yeapp1.
func TestDetectPrimaryIPBridgeBeforeLAN(t *testing.T) {
	dir := t.TempDir()
	script := `#!/bin/sh
case "$*" in
  '-j -4 route get 1.1.1.1') printf '%s\n' '[{"dev":"ens18","prefsrc":"192.0.2.90"}]' ;;
  '-j -d -4 address show up') printf '%s\n' '[{"ifname":"yeapp1","flags":["UP"],"linkinfo":{"info_kind":"bridge"},"addr_info":[{"family":"inet","local":"10.76.0.1","scope":"global"}]},{"ifname":"incusbr0","flags":["UP"],"linkinfo":{"info_kind":"bridge"},"addr_info":[{"family":"inet","local":"10.145.109.1","scope":"global"}]},{"ifname":"ens18","flags":["UP"],"addr_info":[{"family":"inet","local":"192.0.2.90","scope":"global"}]}]' ;;
  *) printf '%s\n' '    inet 10.76.0.1/24 scope global yeapp1' '    inet 10.145.109.1/24 scope global incusbr0' '    inet 192.0.2.90/24 scope global ens18' ;;
esac
`
	if err := os.WriteFile(filepath.Join(dir, "ip"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
	if got := detectPrimaryIPOnce(); got != "192.0.2.90" {
		t.Fatalf("selected %q; want actual routed LAN address", got)
	}
}

func TestPrimaryIPSelection(t *testing.T) {
	iface := func(name, kind string, addresses ...string) primaryIPInterface {
		i := primaryIPInterface{Name: name, Flags: []string{"UP"}}
		i.LinkInfo.Kind = kind
		for _, address := range addresses {
			i.Addresses = append(i.Addresses, struct {
				Family string `json:"family"`
				Local  string `json:"local"`
				Scope  string `json:"scope"`
			}{"inet", address, "global"})
		}
		return i
	}
	lan := iface("ens18", "", "192.0.2.90")
	bridge := iface("yeapp1", "bridge", "10.76.0.1")
	down := lan
	down.Flags = nil
	for _, tc := range []struct {
		name       string
		interfaces []primaryIPInterface
		routes     string
		want       string
	}{
		{"routed LAN after bridge", []primaryIPInterface{bridge, lan}, `[{"dev":"ens18","prefsrc":"192.0.2.90"}]`, "192.0.2.90"},
		{"LAN uses former excluded subnet", []primaryIPInterface{iface("enp1s0", "", "10.199.59.9")}, `[{"dev":"enp1s0","prefsrc":"10.199.59.9"}]`, "10.199.59.9"},
		{"offline single LAN", []primaryIPInterface{bridge, lan}, `[]`, "192.0.2.90"},
		{"slow DHCP bridge only", []primaryIPInterface{bridge}, `[]`, ""},
		{"ambiguous offline LANs", []primaryIPInterface{lan, iface("ens19", "", "198.51.100.8")}, `[]`, ""},
		{"multiple addresses no route", []primaryIPInterface{iface("ens18", "", "192.0.2.90", "192.0.2.91")}, `[]`, ""},
		{"routed alias", []primaryIPInterface{iface("ens18", "", "192.0.2.90", "192.0.2.91")}, `[{"dev":"ens18","prefsrc":"192.0.2.91"}]`, "192.0.2.91"},
		{"unassigned route source", []primaryIPInterface{lan}, `[{"dev":"ens18","prefsrc":"192.0.2.91"}]`, ""},
		{"missing route interface", []primaryIPInterface{lan}, `[{"dev":"ens19","prefsrc":"192.0.2.90"}]`, ""},
		{"missing route source", []primaryIPInterface{lan}, `[{"dev":"ens18"}]`, ""},
		{"down interface", []primaryIPInterface{down}, `[{"dev":"ens18","prefsrc":"192.0.2.90"}]`, ""},
		{"routed host bridge", []primaryIPInterface{iface("br0", "bridge", "192.0.2.90")}, `[{"dev":"br0","prefsrc":"192.0.2.90"}]`, "192.0.2.90"},
		{"unrouted generic bridge", []primaryIPInterface{iface("br0", "bridge", "192.0.2.90")}, `[]`, ""},
		{"tunnel retains physical LAN", []primaryIPInterface{iface("wg0", "wireguard", "10.1.2.3"), lan}, `[{"dev":"wg0","prefsrc":"10.1.2.3"}]`, "192.0.2.90"},
		{"tunnel alone", []primaryIPInterface{iface("wg0", "wireguard", "10.1.2.3")}, `[{"dev":"wg0","prefsrc":"10.1.2.3"}]`, ""},
		{"managed bridge route is not LAN", []primaryIPInterface{bridge}, `[{"dev":"yeapp1","prefsrc":"10.76.0.1"}]`, ""},
		{"malformed route", []primaryIPInterface{lan}, `{`, ""},
		{"ambiguous routes", []primaryIPInterface{lan}, `[{"dev":"ens18","prefsrc":"192.0.2.90"},{"dev":"ens18","prefsrc":"192.0.2.90"}]`, ""},
		{"link local", []primaryIPInterface{iface("ens18", "", "169.254.1.1")}, `[]`, ""},
		{"invalid address", []primaryIPInterface{iface("ens18", "", "not-ip")}, `[]`, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b, err := json.Marshal(tc.interfaces)
			if err != nil {
				t.Fatal(err)
			}
			if got := selectPrimaryIP(b, []byte(tc.routes)); got != tc.want {
				t.Fatalf("got %q want %q", got, tc.want)
			}
		})
	}
	if got := selectPrimaryIP([]byte(`{`), []byte(`[]`)); got != "" {
		t.Fatal(got)
	}
}

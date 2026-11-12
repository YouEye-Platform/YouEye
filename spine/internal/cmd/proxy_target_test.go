package cmd

import (
	"fmt"
	"strings"
	"testing"
)

func TestParseProxyTarget(t *testing.T) {
	good := map[string][2]any{
		"10.0.0.5:8080":   {"10.0.0.5", 8080},
		"NAS.lan:5000":    {"nas.lan", 5000},
		" host-1.a.b:1 ":  {"host-1.a.b", 1},
		"192.168.1.1:443": {"192.168.1.1", 443},
	}
	for in, want := range good {
		host, port, err := parseProxyTarget(in)
		if err != nil || host != want[0] || port != want[1] {
			t.Errorf("%q: got %q %d %v, want %v", in, host, port, err, want)
		}
	}
	for _, in := range []string{"10.0.0.5", "fd00::5:8080", "host:0", "host:65536", "host:http", "-bad-:80", "a b:80", ":80", "http://x:80"} {
		if _, _, err := parseProxyTarget(in); err == nil {
			t.Errorf("%q accepted", in)
		}
	}
	// The Control Panel dials IPv4 and DNS names only: refuse IPv6 here, clearly.
	for _, in := range []string{"[fd00::5]:8080", "[::1]:80"} {
		if _, _, err := parseProxyTarget(in); err == nil || !strings.Contains(err.Error(), "IPv6") {
			t.Errorf("%q: %v", in, err)
		}
	}
}

func TestExpandProxyHostname(t *testing.T) {
	domain := func() (string, error) { return "Sandy-Spring.ui.bingo.", nil }
	for in, want := range map[string]string{
		"nas":              "nas.sandy-spring.ui.bingo",
		" NAS ":            "nas.sandy-spring.ui.bingo",
		"nas.example.com":  "nas.example.com",
		"Nas.Example.com.": "nas.example.com",
	} {
		got, err := expandProxyHostname(in, domain)
		if err != nil || got != want {
			t.Errorf("%q: got %q %v, want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"", "  ", "-nas", "na s", "*.example.com", "nas_1"} {
		if got, err := expandProxyHostname(in, domain); err == nil {
			t.Errorf("%q accepted as %q", in, got)
		}
	}
	noDomain := func() (string, error) { return "", nil }
	if _, err := expandProxyHostname("nas", noDomain); err == nil || !strings.Contains(err.Error(), "no platform domain") {
		t.Fatal(err)
	}
	if got, err := expandProxyHostname("nas.lan", noDomain); err != nil || got != "nas.lan" {
		t.Fatal(got, err)
	}
	unreachable := func() (string, error) { return "", fmt.Errorf("control panel unreachable") }
	if _, err := expandProxyHostname("nas", unreachable); err == nil {
		t.Fatal("domain lookup failure ignored")
	}
}

func TestProxyAddedRouteID(t *testing.T) {
	// Shape of POST /api/caddy/routes: {success, route: {route: ProxyRoute, warning}}.
	result := map[string]interface{}{"success": true, "route": map[string]interface{}{
		"route": map[string]interface{}{"id": "route-1", "hostname": "nas.example.com"}, "warning": "check upstream",
	}}
	if id := str(proxyAddedRoute(result), "id"); id != "route-1" {
		t.Fatalf("route id %q", id)
	}
	if warning := firstOf(proxyAddedResult(result), "warning"); warning != "check upstream" {
		t.Fatalf("warning %q", warning)
	}
	if id := str(proxyAddedRoute(map[string]interface{}{"success": true}), "id"); id != "" {
		t.Fatalf("invented route id %q", id)
	}
}

package mdns

import (
	"strings"
	"testing"
)

func TestConfigLimitsAvahiToTheLANAdapter(t *testing.T) {
	text, err := Config("ens18")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"host-name=youeye\n", "allow-interfaces=ens18\n", "use-ipv6=no\n", "publish-hinfo=no\n", "publish-workstation=no\n", "enable-reflector=no\n", "enable-wide-area=no\n"} {
		if !strings.Contains(text, want) {
			t.Errorf("config lacks %q", want)
		}
	}
	for _, bad := range []string{"ens*", "a,b", "eth0 incusbr0", "", "x/../y"} {
		if _, err := Config(bad); err == nil {
			t.Errorf("Config(%q) accepted", bad)
		}
	}
}

func TestLANInterfaceIsTheDefaultRoute(t *testing.T) {
	table := "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n" +
		"incusbr0\t00004C0A\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0\n" +
		"ens18\t00000000\t011FA8C0\t0003\t0\t0\t1024\t00000000\t0\t0\t0\n" +
		"ens18\t001FA8C0\t00000000\t0001\t0\t0\t1024\t00FFFFFF\t0\t0\t0\n"
	got, err := LANInterface(strings.NewReader(table))
	if err != nil || got != "ens18" {
		t.Fatalf("LANInterface = %q, %v", got, err)
	}
	onlyBridge := "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\n" +
		"incusbr0\t00000000\t00000000\t0001\t0\t0\t0\t00000000\n"
	if _, err := LANInterface(strings.NewReader(onlyBridge)); err == nil {
		t.Fatal("a container bridge was taken for the LAN adapter")
	}
	if _, err := LANInterface(strings.NewReader("Iface\tDestination\n")); err == nil {
		t.Fatal("no default route accepted")
	}
}

func TestParseBusctl(t *testing.T) {
	for input, want := range map[string]string{`s "youeye.local"`: "youeye.local", "s \"youeye-2.local\"\n": "youeye-2.local"} {
		if got, err := ParseBusctl(input); err != nil || got != want {
			t.Errorf("ParseBusctl(%q) = %q, %v", input, got, err)
		}
	}
	for _, input := range []string{`s "evil.example"`, `youeye.local`, `s "youeye11.local"`, `s "a.youeye.local"`} {
		if _, err := ParseBusctl(input); err == nil {
			t.Errorf("ParseBusctl(%q) accepted", input)
		}
	}
}

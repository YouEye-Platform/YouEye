package installer

import (
	"net"
	"testing"
)

func TestDiscoverApplianceNetworkAdaptersUsesStablePhysicalIdentities(t *testing.T) {
	previous := listNetworkInterfaces
	listNetworkInterfaces = func() ([]net.Interface, error) {
		return []net.Interface{
			{Name: "veth9", HardwareAddr: net.HardwareAddr{0x02, 0, 0, 0, 0, 9}},
			{Name: "enp2s0", HardwareAddr: net.HardwareAddr{0x02, 0, 0, 0, 0, 2}},
			{Name: "enp1s0", HardwareAddr: net.HardwareAddr{0x02, 0, 0, 0, 0, 1}},
			{Name: "lo", Flags: net.FlagLoopback},
			{Name: "multicast", HardwareAddr: net.HardwareAddr{0x01, 0, 0, 0, 0, 1}},
		}, nil
	}
	t.Cleanup(func() { listNetworkInterfaces = previous })

	adapters, err := discoverApplianceNetworkAdapters()
	if err != nil {
		t.Fatal(err)
	}
	if len(adapters) != 2 || adapters[0].Name != "enp1s0" || adapters[1].MAC != "02:00:00:00:00:02" {
		t.Fatalf("unexpected physical adapter set: %+v", adapters)
	}
}

package installer

import (
	"net"
	"sort"
	"strings"
)

type applianceNetworkAdapter struct {
	Name string
	MAC  string
}

var listNetworkInterfaces = net.Interfaces

func discoverApplianceNetworkAdapters() ([]applianceNetworkAdapter, error) {
	interfaces, err := listNetworkInterfaces()
	if err != nil {
		return nil, err
	}
	adapters := make([]applianceNetworkAdapter, 0, len(interfaces))
	for _, candidate := range interfaces {
		name := strings.TrimSpace(candidate.Name)
		hardware := candidate.HardwareAddr
		if candidate.Flags&net.FlagLoopback != 0 || virtualNetworkInterface(name) || len(hardware) != 6 || hardware[0]&1 != 0 {
			continue
		}
		adapters = append(adapters, applianceNetworkAdapter{Name: name, MAC: hardware.String()})
	}
	sort.Slice(adapters, func(left, right int) bool {
		return adapters[left].Name < adapters[right].Name
	})
	return adapters, nil
}

func virtualNetworkInterface(name string) bool {
	for _, prefix := range []string{"br-", "docker", "fwbr", "incusbr", "lo", "lxdbr", "tap", "tun", "veth", "virbr"} {
		if name == prefix || strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

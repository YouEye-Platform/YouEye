package systemupdate

import (
	"context"
	"fmt"
	"net"
	"strings"
)

// CoreDNSBinding retains the old binding and any separate repair-start intent.
// It never erases the original power receipt or grants a general start retry.
type CoreDNSBinding struct {
	UUID                   string `json:"uuid"`
	Recovery               bool   `json:"recovery"`
	BootID                 string `json:"boot_id,omitempty"`
	Address                string `json:"address"`
	PreviousTCP            string `json:"previous_tcp"`
	PreviousUDP            string `json:"previous_udp"`
	PreviousStartRequested bool   `json:"previous_start_requested"`
	RepairStart            string `json:"repair_start,omitempty"`
}

func dnsListenAddress(value, protocol string) (string, bool) {
	if !strings.HasPrefix(value, protocol+":") {
		return "", false
	}
	host, port, err := net.SplitHostPort(strings.TrimPrefix(value, protocol+":"))
	ip := net.ParseIP(host)
	return host, err == nil && port == "53" && ip != nil && ip.To4() != nil && ip.IsGlobalUnicast()
}

// Called under the checkpoint power lock after exact inventory, lease and
// provider settlement checks. Only the two installed DNS listen addresses move;
// ordinary host migration stays fenced until the core transaction completes.
func (p NativeCoreCheckpoint) prepareDNSBinding(ctx context.Context, j CoreJournal, record *NativeCoreCheckpointRecord, c CoreCheckpointContainer, actual coreCompletionContainer, recovery, observeOnly, hasStart bool) (coreCompletionContainer, error) {
	if c.Name != "youeye-pihole" || !c.Running || p.DNSHostAddress == nil {
		return actual, nil
	}
	address, err := p.DNSHostAddress(ctx)
	ip := net.ParseIP(address)
	if err != nil || ip == nil || ip.To4() == nil || !ip.IsGlobalUnicast() {
		return actual, fmt.Errorf("assigned DNS host address unavailable")
	}
	check := func(a coreCompletionContainer) error {
		if a.Config["volatile.uuid"] != c.UUID || a.Config["user.youeye.core-request"] != j.RequestID || a.Config["boot.autostart"] != "false" {
			return fmt.Errorf("DNS repair ownership changed")
		}
		for i, protocol := range []string{"tcp", "udp"} {
			d := a.Devices[fmt.Sprintf("proxy%d", i)]
			if _, ok := dnsListenAddress(d["listen"], protocol); !ok || d["type"] != "proxy" || d["connect"] != protocol+":127.0.0.1:53" {
				return fmt.Errorf("installed DNS proxy contract changed")
			}
		}
		return nil
	}
	if err = check(actual); err != nil {
		return actual, err
	}
	index := -1
	newBoot := recovery && p.allowDNSRepairStart && len(p.recoveryPreviousBoot) == 36 && len(p.recoveryCurrentBoot) == 36 && p.recoveryPreviousBoot != p.recoveryCurrentBoot
	seenBoots := map[string]bool{}
	for i, b := range record.DNSBindings {
		if b.Recovery == recovery {
			if b.UUID != c.UUID || seenBoots[b.BootID] || (b.BootID != "" && len(b.BootID) != 36) {
				return actual, fmt.Errorf("DNS repair binding identity changed")
			}
			seenBoots[b.BootID] = true
			index = i
		}
	}
	if index >= 0 && record.DNSBindings[index].Address != address {
		previous := record.DNSBindings[index]
		// A different DHCP address on a proven later boot creates a new binding
		// receipt. Keep the previous binding and start history immutable. Same-
		// boot uncertainty and changes outside our recorded devices stay fenced.
		if !newBoot || observeOnly || actual.Status != "Stopped" || seenBoots[p.recoveryCurrentBoot] {
			return actual, fmt.Errorf("DNS repair binding identity changed")
		}
		for i, protocol := range []string{"tcp", "udp"} {
			old := previous.PreviousTCP
			if i == 1 {
				old = previous.PreviousUDP
			}
			got := actual.Devices[fmt.Sprintf("proxy%d", i)]["listen"]
			if got != protocol+":"+previous.Address+":53" && got != old {
				return actual, fmt.Errorf("DNS proxy changed outside its repair")
			}
		}
		index = -1
	}
	changed := actual.Devices["proxy0"]["listen"] != "tcp:"+address+":53" || actual.Devices["proxy1"]["listen"] != "udp:"+address+":53"
	if index < 0 && !changed {
		return actual, nil
	}
	if index < 0 {
		if observeOnly || actual.Status != "Stopped" || (hasStart && !(recovery && p.allowDNSRepairStart)) {
			return actual, fmt.Errorf("DNS binding repair requires an owned stopped instance and explicit settled recovery")
		}
		record.DNSBindings = append(record.DNSBindings, CoreDNSBinding{UUID: c.UUID, Recovery: recovery, Address: address, PreviousTCP: actual.Devices["proxy0"]["listen"], PreviousUDP: actual.Devices["proxy1"]["listen"], PreviousStartRequested: hasStart})
		index = len(record.DNSBindings) - 1
		if newBoot {
			record.DNSBindings[index].BootID = p.recoveryCurrentBoot
		}
		if err = p.saveRecord(*record); err != nil {
			return actual, err
		}
	}
	b := &record.DNSBindings[index]
	if _, ok := dnsListenAddress(b.PreviousTCP, "tcp"); !ok {
		return actual, fmt.Errorf("DNS repair original TCP binding invalid")
	}
	if _, ok := dnsListenAddress(b.PreviousUDP, "udp"); !ok {
		return actual, fmt.Errorf("DNS repair original UDP binding invalid")
	}
	if b.PreviousTCP == "tcp:"+address+":53" && b.PreviousUDP == "udp:"+address+":53" {
		return actual, fmt.Errorf("DNS repair has no changed binding")
	}
	if b.RepairStart != "" && b.RepairStart != "requested" && b.RepairStart != "running" {
		return actual, fmt.Errorf("DNS repair start receipt invalid")
	}
	for i, protocol := range []string{"tcp", "udp"} {
		device := fmt.Sprintf("proxy%d", i)
		want := protocol + ":" + address + ":53"
		previous := b.PreviousTCP
		if i == 1 {
			previous = b.PreviousUDP
		}
		got := actual.Devices[device]["listen"]
		if got != want && got != previous {
			return actual, fmt.Errorf("DNS proxy changed outside its repair")
		}
		if got == want {
			continue
		}
		if observeOnly || actual.Status != "Stopped" || b.RepairStart != "" {
			return actual, fmt.Errorf("DNS binding is not ready for observation")
		}
		if err = p.requireProviderSettled(ctx); err != nil {
			return actual, err
		}
		_, _ = p.capture(ctx, "incus", "config", "device", "set", c.Name, device, "listen", want)
		actual, err = p.completionContainer(ctx, c)
		if err != nil {
			return actual, err
		}
		if err = check(actual); err != nil {
			return actual, err
		}
		if actual.Devices[device]["listen"] != want {
			return actual, fmt.Errorf("DNS binding mutation not observed")
		}
	}
	// The separate per-boot power receipt owns the start on a proven later
	// boot, including observation after a lost acknowledgement. Do not replay
	// the historical DNS repair start or create a second start authority.
	if !b.PreviousStartRequested || newBoot {
		return actual, nil
	}
	if b.RepairStart == "" && actual.Status == "Stopped" {
		if !recovery || !p.allowDNSRepairStart || observeOnly {
			return actual, fmt.Errorf("settled recovery required for distinct DNS repair start")
		}
		if err = p.requireProviderSettled(ctx); err != nil {
			return actual, err
		}
		b.RepairStart = "requested"
		if err = p.saveRecord(*record); err != nil {
			return actual, err
		}
		_, _ = p.capture(ctx, "incus", "start", c.Name)
		actual, err = p.completionContainer(ctx, c)
		if err != nil {
			return actual, err
		}
		if err = check(actual); err != nil {
			return actual, err
		}
	}
	if b.RepairStart == "" || actual.Status != "Running" {
		return actual, fmt.Errorf("DNS repair start remains uncertain; replay refused")
	}
	b.RepairStart = "running"
	return actual, p.saveRecord(*record)
}

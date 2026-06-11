package incus

import "testing"

func TestIncusBridgeDnsmasqStale(t *testing.T) {
	tests := []struct {
		name        string
		processList string
		expectedIP  string
		want        bool
	}{
		{
			name:       "single current bridge dnsmasq is clean",
			expectedIP: "10.82.15.1",
			processList: "268909 dnsmasq --interface=incusbr0 --listen-address=10.82.15.1 " +
				"--dhcp-range 10.82.15.100,10.82.15.254,1h",
			want: false,
		},
		{
			name:       "single old bridge dnsmasq is stale",
			expectedIP: "10.82.15.1",
			processList: "18825 dnsmasq --interface=incusbr0 --listen-address=10.47.104.1 " +
				"--dhcp-range 10.47.104.100,10.47.104.254,1h",
			want: true,
		},
		{
			name:       "multiple bridge dnsmasq processes are stale",
			expectedIP: "10.82.15.1",
			processList: "18825 dnsmasq --interface=incusbr0 --listen-address=10.47.104.1\n" +
				"268909 dnsmasq --interface=incusbr0 --listen-address=10.82.15.1",
			want: true,
		},
		{
			name:        "non-incusbr0 dnsmasq is ignored",
			expectedIP:  "10.82.15.1",
			processList: "123 dnsmasq --interface=otherbr0 --listen-address=10.10.10.1",
			want:        false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := incusBridgeDnsmasqStale(tt.processList, tt.expectedIP)
			if got != tt.want {
				t.Fatalf("incusBridgeDnsmasqStale() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestStaleIncusBridgeDnsmasqPIDs(t *testing.T) {
	processList := "18825 dnsmasq --interface=incusbr0 --listen-address=10.47.104.1\n" +
		"25770 dnsmasq --interface=incusbr0 --listen-address=10.85.229.1\n" +
		"283406 dnsmasq --interface=incusbr0 --listen-address=10.49.153.1\n" +
		"99999 dnsmasq --interface=otherbr0 --listen-address=10.10.10.1"

	got := staleIncusBridgeDnsmasqPIDs(processList, "10.49.153.1")
	want := []string{"18825", "25770"}
	if len(got) != len(want) {
		t.Fatalf("staleIncusBridgeDnsmasqPIDs() = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("staleIncusBridgeDnsmasqPIDs() = %v, want %v", got, want)
		}
	}
}

func TestActiveIncusBridgeDnsmasqCount(t *testing.T) {
	processList := "18825 dnsmasq --interface=incusbr0 --listen-address=10.47.104.1\n" +
		"283406 dnsmasq --interface=incusbr0 --listen-address=10.49.153.1\n" +
		"283500 dnsmasq --interface=incusbr0 --listen-address=10.49.153.1"

	got := activeIncusBridgeDnsmasqCount(processList, "10.49.153.1")
	if got != 2 {
		t.Fatalf("activeIncusBridgeDnsmasqCount() = %d, want 2", got)
	}
}

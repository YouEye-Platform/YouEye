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

package ordering

import "testing"

func TestApplianceVersionOrdering(t *testing.T) {
	cases := []struct {
		left, right string
		want        int
	}{
		{"0.6.0-dev.9", "0.6.0-dev.10", -1},
		{"0.6.0-dev.25", "0.6.0", -1},
		{"1.0.0-alpha.1", "1.0.0-alpha.beta", -1},
		{"1.0.0+build.1", "1.0.0+build.2", 0},
		{"0.5.23.0.0.5", "0.5.23.0.0.6", -1},
		{"0.5.23.0.0.6", "0.5.23.0.0.7", -1},
		{"0.5.23.0.0.7", "0.5.23.0.0.8", -1},
		{"0.5.23.0.0.8", "0.5.23.0.0.9", -1},
		{"0.5.23.0.0.9", "0.5.23.0.0.10", -1},
		{"0.5.23.0.0.10", "0.5.23.0.0.12", -1},
		{"0.5.23", "0.5.23.0.0", 0},
		{"0.5.23.1", "0.5.23.0.99", 1},
	}
	for _, tc := range cases {
		left, err := ParseVersion(tc.left)
		if err != nil {
			t.Fatal(err)
		}
		right, err := ParseVersion(tc.right)
		if err != nil {
			t.Fatal(err)
		}
		if got := CompareVersion(left, right); got != tc.want {
			t.Fatalf("CompareVersion(%q, %q) = %d, want %d", tc.left, tc.right, got, tc.want)
		}
	}
}

func TestRejectMalformedVersionsAndUnsafeVersionMoves(t *testing.T) {
	for _, value := range []string{"", "1", "1.2", "01.2.3", "1.02.3", "1.2.03", "1.2.3-01", "1.2.3-", "1.2.3+", "1.2.3.4.5.6.7.8.9.10.11"} {
		if _, err := ParseVersion(value); err == nil {
			t.Fatalf("ParseVersion(%q) succeeded", value)
		}
	}
	if err := RequireUpgradeIdentity("0.6.0-dev.25", "0.6.0-dev.26"); err != nil {
		t.Fatalf("ordered identity upgrade was rejected: %v", err)
	}
	if err := RequireUpgradeIdentity("0.6.0-dev.25", "0.6.0-dev.24"); err == nil {
		t.Fatal("downgraded version was accepted")
	}
	if err := RequireUpgradeIdentity("0.5.23.0.0.5", "0.5.23.0.0.6"); err != nil {
		t.Fatalf("ordered multi-segment identity upgrade was rejected: %v", err)
	}
	if err := RequireUpgradeIdentity("0.5.23.0.0.6", "0.5.23.0.0.7"); err != nil {
		t.Fatalf("ordered accepted-candidate identity upgrade was rejected: %v", err)
	}
	if err := RequireUpgradeIdentity("0.5.23.0.0.7", "0.5.23.0.0.8"); err != nil {
		t.Fatalf("ordered network-migration identity upgrade was rejected: %v", err)
	}
	if err := RequireUpgradeIdentity("0.5.23.0.0.8", "0.5.23.0.0.9"); err != nil {
		t.Fatalf("ordered static-network identity upgrade was rejected: %v", err)
	}
	if err := RequireUpgradeIdentity("0.5.23.0.0.9", "0.5.23.0.0.10"); err != nil {
		t.Fatalf("ordered operator-metadata identity upgrade was rejected: %v", err)
	}
	if err := RequireUpgradeIdentity("0.5.23.0.0.10", "0.5.23.0.0.12"); err != nil {
		t.Fatalf("ordered console-truth identity upgrade was rejected: %v", err)
	}
}

package version

import (
	"testing"
)

func TestCompareVersions(t *testing.T) {
	tests := []struct {
		name     string
		a, b     string
		expected int
	}{
		// Equal versions
		{"equal 3-digit", "0.1.54", "0.1.54", 0},
		{"equal 4-digit", "0.1.54.1", "0.1.54.1", 0},
		{"equal with trailing zero", "0.1.54", "0.1.54.0", 0},

		// a < b
		{"patch less", "0.1.53", "0.1.54", -1},
		{"minor less", "0.0.54", "0.1.54", -1},
		{"major less", "0.1.54", "1.1.54", -1},
		{"4th digit less", "0.1.54.1", "0.1.54.12", -1},
		{"3-digit vs 4-digit newer", "0.1.54", "0.1.54.1", -1},

		// a > b
		{"patch greater", "0.1.55", "0.1.54", 1},
		{"minor greater", "0.2.0", "0.1.99", 1},
		{"major greater", "1.0.0", "0.99.99", 1},
		{"4th digit greater", "0.1.54.12", "0.1.54.1", 1},
		{"4-digit vs 3-digit newer", "0.1.54.1", "0.1.54", 1},

		// Edge cases
		{"empty strings", "", "", 0},
		{"single digit", "1", "2", -1},
		{"v-prefix stripped", "v0.1.54", "0.1.54", 0},
		{"both v-prefix", "v1.0.0", "v0.9.9", 1},
		{"multi-digit segments", "0.1.103.1", "0.1.54.12", 1},
		{"numeric not lexicographic", "0.1.9", "0.1.54", -1},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := CompareVersions(tt.a, tt.b)
			if result != tt.expected {
				t.Errorf("CompareVersions(%q, %q) = %d, want %d", tt.a, tt.b, result, tt.expected)
			}
		})
	}
}

func TestIsNewer(t *testing.T) {
	tests := []struct {
		name              string
		candidate, current string
		expected          bool
	}{
		{"newer patch", "0.1.55", "0.1.54", true},
		{"same version", "0.1.54", "0.1.54", false},
		{"older version", "0.1.53", "0.1.54", false},
		{"newer 4th digit", "0.1.54.2", "0.1.54.1", true},
		{"4-digit vs 3-digit", "0.1.54.1", "0.1.54", true},
		{"3-digit vs 4-digit newer", "0.1.55", "0.1.54.99", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := IsNewer(tt.candidate, tt.current)
			if result != tt.expected {
				t.Errorf("IsNewer(%q, %q) = %v, want %v", tt.candidate, tt.current, result, tt.expected)
			}
		})
	}
}

func TestSortVersionsDesc(t *testing.T) {
	versions := []string{"0.1.54", "0.1.54.12", "0.1.54.1", "0.1.53", "0.1.55", "1.0.0"}
	SortVersionsDesc(versions)

	expected := []string{"1.0.0", "0.1.55", "0.1.54.12", "0.1.54.1", "0.1.54", "0.1.53"}
	for i, v := range versions {
		if v != expected[i] {
			t.Errorf("SortVersionsDesc: index %d = %q, want %q", i, v, expected[i])
		}
	}
}

package ordering

import "testing"

func TestReleaseIdentity(t *testing.T) {
	for _, value := range []string{"0.0.0", "1.0.0", "0.5.37-dev.1", "0.5.37-worker-sebastian42.10", "1.0.0-alpha.9007199254740991"} {
		v, err := ParseReleaseVersion(value)
		if err != nil || v.String() != value {
			t.Fatalf("identity %q: %v, %v", value, v, err)
		}
	}
	for _, value := range []string{"", "v1.0.0", "1.0", "1.0.0.0", "01.0.0", "1.0.0-dev.0", "1.0.0-dev.01", "1.0.0-Dev.1", "1.0.0-agent/test.1", "1.0.0-dev-.1", "1.0.0-dev.1+build", "1.0.0-dev.9007199254740992", "9007199254740992.0.0", " 1.0.0"} {
		if _, err := ParseReleaseVersion(value); err == nil {
			t.Errorf("accepted invalid identity %q", value)
		}
	}
}

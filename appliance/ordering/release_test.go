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

func TestReleaseOrdering(t *testing.T) {
	values := []string{"0.5.36", "0.5.37-alpha.1", "0.5.37-beta.1", "0.5.37-dev.9", "0.5.37-dev.10", "0.5.37", "0.5.38-dev.1"}
	for i, a := range values {
		av, _ := ParseReleaseVersion(a)
		for j, b := range values {
			bv, _ := ParseReleaseVersion(b)
			want := 0
			if i < j {
				want = -1
			}
			if i > j {
				want = 1
			}
			if got := CompareReleaseVersion(av, bv); got != want {
				t.Errorf("%s versus %s: %d != %d", a, b, got, want)
			}
		}
	}
}

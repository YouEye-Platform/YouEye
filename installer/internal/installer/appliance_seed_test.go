package installer

import "testing"

func TestParseApplianceSeedAcceptsInfraContract(t *testing.T) {
	seed, err := parseApplianceSeed([]byte(`{
		"schema":"youeye.appliance.seed.v1",
		"rig_id":"rig-123",
		"artifact_id":"artifact-123",
		"manifest_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		"operation":"install",
		"profile":"youeye-minimum-128",
		"profile_version":"youeye-minimum-128/v1",
		"profile_digest":"profile-digest",
		"scenario":"blank-install",
		"faults":[{"name":"wrong-target","trigger":"pre-confirmation","action":"reject-target-serial-mismatch","state":"scheduled"}],
		"target_serial":"YEIRIG123"
	}` + "\n"))
	if err != nil {
		t.Fatal(err)
	}
	if seed.Operation != "install" || seed.TargetSerial != "YEIRIG123" || len(seed.Faults) != 1 {
		t.Fatalf("unexpected seed: %+v", seed)
	}
}

func TestParseApplianceSeedRejectsUnknownFieldsAndBadIdentity(t *testing.T) {
	cases := []struct {
		name string
		raw  string
	}{
		{name: "unknown field", raw: `{"schema":"youeye.appliance.seed.v1","rig_id":"r","artifact_id":"a","manifest_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","operation":"install","profile":"p","profile_version":"pv","profile_digest":"pd","scenario":"s","target_serial":"t","extra":true}`},
		{name: "bad schema", raw: `{"schema":"old","rig_id":"r","artifact_id":"a","manifest_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","operation":"install","profile":"p","profile_version":"pv","profile_digest":"pd","scenario":"s","target_serial":"t"}`},
		{name: "missing rig", raw: `{"schema":"youeye.appliance.seed.v1","artifact_id":"a","manifest_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","operation":"install","profile":"p","profile_version":"pv","profile_digest":"pd","scenario":"s","target_serial":"t"}`},
		{name: "bad digest", raw: `{"schema":"youeye.appliance.seed.v1","rig_id":"r","artifact_id":"a","manifest_sha256":"bad","operation":"install","profile":"p","profile_version":"pv","profile_digest":"pd","scenario":"s","target_serial":"t"}`},
		{name: "bad operation", raw: `{"schema":"youeye.appliance.seed.v1","rig_id":"r","artifact_id":"a","manifest_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","operation":"wipe","profile":"p","profile_version":"pv","profile_digest":"pd","scenario":"s","target_serial":"t"}`},
		{name: "resume without transaction", raw: `{"schema":"youeye.appliance.seed.v1","rig_id":"r","artifact_id":"a","manifest_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","operation":"resume","profile":"p","profile_version":"pv","profile_digest":"pd","scenario":"s","target_serial":"t"}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := parseApplianceSeed([]byte(tc.raw)); err == nil {
				t.Fatal("expected rejection")
			}
		})
	}
}

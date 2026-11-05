package installer

import "testing"

func TestFullEraseTargetCheckAllowsAnyExistingReleaseIdentity(t *testing.T) {
	selected := applianceDisk{Path: "/dev/vda", Serial: "TARGET", SizeBytes: 128 * applianceGiB, Signatures: []string{"label:YE-STATE"}}
	current := selected
	current.Signatures = []string{"label:FOREIGN", "partition:old-system"}
	if err := verifyApplianceTargetUnchanged(selected, current); err != nil {
		t.Fatalf("confirmed full erase was incorrectly coupled to existing contents: %v", err)
	}
}

func TestFullEraseTargetCheckRejectsIdentityAndSafetyDrift(t *testing.T) {
	selected := applianceDisk{Path: "/dev/vda", Serial: "TARGET", SizeBytes: 128 * applianceGiB}
	for name, current := range map[string]applianceDisk{
		"path":    {Path: "/dev/vdb", Serial: "TARGET", SizeBytes: 128 * applianceGiB},
		"serial":  {Path: "/dev/vda", Serial: "OTHER", SizeBytes: 128 * applianceGiB},
		"size":    {Path: "/dev/vda", Serial: "TARGET", SizeBytes: 127 * applianceGiB},
		"mounted": {Path: "/dev/vda", Serial: "TARGET", SizeBytes: 128 * applianceGiB, Mounted: true},
	} {
		t.Run(name, func(t *testing.T) {
			if err := verifyApplianceTargetUnchanged(selected, current); err == nil {
				t.Fatal("expected target drift rejection")
			}
		})
	}
}

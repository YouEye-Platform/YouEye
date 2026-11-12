package installer

// installConfig is the booted installer-media execution contract. Proxmox
// provisioning has its own host-side config because it never writes a guest
// disk directly; both paths converge on the same ISO and manifest.
type installConfig struct {
	ApplianceSeedPath     string
	ApplianceAnswerPath   string
	ApplianceManifestPath string
	ApplianceTargetDisk   string
	ApplianceTargetDiskGB int
	AppliancePlanOnly     bool

	ResultIP string
}

func newConfig() installConfig {
	return installConfig{
		ApplianceManifestPath: defaultApplianceManifestPath,
	}
}

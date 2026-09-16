package installer

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

const applianceSeedSchema = "youeye.appliance.seed.v1"

type applianceRigFault struct {
	Name    string `json:"name"`
	Trigger string `json:"trigger"`
	Action  string `json:"action"`
	State   string `json:"state"`
}

type applianceSeed struct {
	Schema         string              `json:"schema"`
	RigID          string              `json:"rig_id"`
	ArtifactID     string              `json:"artifact_id"`
	ManifestSHA256 string              `json:"manifest_sha256"`
	Operation      string              `json:"operation"`
	TransactionID  string              `json:"transaction_id,omitempty"`
	Profile        string              `json:"profile"`
	ProfileVersion string              `json:"profile_version"`
	ProfileDigest  string              `json:"profile_digest"`
	Scenario       string              `json:"scenario"`
	Faults         []applianceRigFault `json:"faults"`
	TargetSerial   string              `json:"target_serial"`
}

func parseApplianceSeed(data []byte) (applianceSeed, error) {
	var seed applianceSeed
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&seed); err != nil {
		return seed, fmt.Errorf("decode appliance seed: %w", err)
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		return seed, fmt.Errorf("decode appliance seed: trailing JSON value")
	}
	if err := validateApplianceSeed(seed); err != nil {
		return seed, err
	}
	return seed, nil
}

func validateApplianceSeed(seed applianceSeed) error {
	if seed.Schema != applianceSeedSchema {
		return fmt.Errorf("unsupported appliance seed schema %q", seed.Schema)
	}
	required := map[string]string{
		"rig_id":          seed.RigID,
		"artifact_id":     seed.ArtifactID,
		"manifest_sha256": seed.ManifestSHA256,
		"profile":         seed.Profile,
		"profile_version": seed.ProfileVersion,
		"profile_digest":  seed.ProfileDigest,
		"scenario":        seed.Scenario,
		"target_serial":   seed.TargetSerial,
	}
	for name, value := range required {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("appliance seed %s is required", name)
		}
	}
	if err := validateApplianceArtifacts(applianceArtifactSet{
		RootPayloadBytes: 1, ManifestSHA256: seed.ManifestSHA256, Verified: true, Compatible: true,
	}); err != nil {
		return fmt.Errorf("appliance seed manifest_sha256: %w", err)
	}
	switch seed.Operation {
	case "install", "reinstall", "resume", "cancel":
	default:
		return fmt.Errorf("unsupported appliance seed operation %q", seed.Operation)
	}
	if seed.TransactionID != "" && !validApplianceTransactionID(seed.TransactionID) {
		return fmt.Errorf("appliance seed transaction_id must be 32 lowercase hexadecimal characters")
	}
	if seed.Operation == "resume" && seed.TransactionID == "" {
		return fmt.Errorf("appliance seed resume requires transaction_id")
	}
	for _, fault := range seed.Faults {
		if strings.TrimSpace(fault.Name) == "" || strings.TrimSpace(fault.Trigger) == "" || strings.TrimSpace(fault.Action) == "" {
			return fmt.Errorf("appliance seed fault entries require name, trigger, and action")
		}
	}
	return nil
}

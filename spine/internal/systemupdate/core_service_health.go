package systemupdate

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"time"
)

// coreHealthPayloadMode decides how the final health gate checks one service
// tree. Strict only for a tree this request wrote: the request replaces the
// member (its artifact differs from the installed one), which the journal's
// step order guarantees happened before authenticated-health may start. Every
// other tree is one this request did not write and is only recorded: a reused
// member, both members of a no-op or metadata-only request (their graph has no
// apply steps), and the restored trees of a recovery.
func coreHealthPayloadMode(j CoreJournal, role string, recovery bool) (CorePayloadMode, error) {
	target, err := coreServiceMember(j.Target, role)
	if err != nil {
		return CorePayloadRecord, err
	}
	previous, err := coreServiceMember(j.Previous.Release, role)
	if err != nil {
		return CorePayloadRecord, err
	}
	if recovery || j.NoOp || j.MetadataOnly || target.Artifact.SHA256 == previous.Artifact.SHA256 {
		return CorePayloadRecord, nil
	}
	return CorePayloadStrict, nil
}

// coreHealthPayloadEvidence names what the walk found, in counts only.
func coreHealthPayloadEvidence(base string, found map[string]CorePayloadFindings) string {
	for _, role := range []string{"cp", "ui"} {
		if f, ok := found[role]; ok && (f.Differs() || f.Unrecorded > 0) {
			base += "; installed " + role + " differs: " + f.Counts()
		}
	}
	return base
}

// Health checks the installed static payloads, completed schema receipts and
// current authenticated CP -> UI bridge against live database reads. It never
// starts migrations or creates a user/session to manufacture sign-in evidence.
// A tree this request did not write never fails it; see coreHealthPayloadMode.
func (s NativeCoreServices) Health(ctx context.Context, request string, recovery bool) (string, error) {
	m := CoreManager{Root: s.Checkpoint.Root}
	j, err := m.Read()
	if err != nil || j.RequestID != request {
		return "", fmt.Errorf("exact core health request required")
	}
	phase, name, steps := "applying", "authenticated-health", j.Steps
	release, digest := j.Target, j.ManifestSHA256
	if recovery {
		phase, name, steps = "recovering", "recovery-health", j.RecoverySteps
		release, digest = j.Previous.Release, j.Previous.ManifestSHA256
	}
	active := false
	for _, step := range steps {
		if step.Name == name && step.State == "started" {
			active = true
		}
	}
	if j.Phase != phase || !active {
		return "", fmt.Errorf("active core health action required")
	}
	receipt, err := m.ReadReceipt()
	if err != nil || !reflect.DeepEqual(receipt, j.Previous) {
		return "", fmt.Errorf("core health receipt advanced")
	}
	if _, _, err = m.Selection(digest); err != nil {
		return "", err
	}
	if !j.NoOp && !j.MetadataOnly {
		if err = s.Checkpoint.verifyReservation(j); err != nil {
			return "", err
		}
	} else if _, err = (CoreLifecycleBarrier{Root: filepath.Join(s.Checkpoint.DataRoot, "state", "app-updates")}).Read(); !errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("another maintenance operation prevents no-op health")
	}
	machine, err := s.Checkpoint.observeMachine()
	if err != nil || machine != j.Previous.Machine {
		return "", fmt.Errorf("core health machine changed")
	}
	var record NativeCoreCheckpointRecord
	bridge := s.Checkpoint.Bridge
	if !j.NoOp && !j.MetadataOnly {
		record, err = s.Checkpoint.Read(j)
		if err != nil {
			return "", err
		}
		bridge = record.Inventory.Bridge
		if err = s.Checkpoint.verifyContainerIdentities(ctx, record.Inventory, false); err != nil {
			return "", err
		}
	}
	ip, err := s.componentAddress(ctx, "youeye-control", bridge)
	if err != nil {
		return "", err
	}
	port := s.CPPort
	if port == 0 {
		port = 3000
	}
	if port < 1 || port > 65535 {
		return "", fmt.Errorf("invalid core health port")
	}
	raw, err := ReadCoreState(filepath.Join(s.Checkpoint.DataRoot, "config", "cli-token"), 128)
	if err != nil {
		return "", fmt.Errorf("current native credential unavailable")
	}
	token := strings.TrimSpace(string(raw))
	if !validSHA256(token) {
		return "", fmt.Errorf("invalid native credential")
	}
	transport := &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 5 * time.Second}).DialContext}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	found := map[string]CorePayloadFindings{}
	for _, role := range []string{"cp", "ui"} {
		member, err := coreServiceMember(release, role)
		if err != nil {
			return "", err
		}
		mode, err := coreHealthPayloadMode(j, role, recovery)
		if err != nil {
			return "", err
		}
		container, appDir, path := "youeye-control", s.CPAppDir, "/api/appliance/core-component"
		if role == "ui" {
			container, appDir, path = "youeye-ui", s.UIAppDir, "/api/appliance/core-ui"
		}
		pid, err := nativeCoreContainerPID(ctx, container)
		if err != nil {
			return "", err
		}
		process, err := nativeProcessIdentity(pid)
		if err != nil {
			return "", err
		}
		marker, err := readNativeCoreMarker(pid)
		if err != nil || marker.Role != role || marker.ArtifactSHA256 != member.Artifact.SHA256 {
			return "", fmt.Errorf("health component differs from selected payload")
		}
		index, err := m.LoadPayloadIndex(member.Artifact.SHA256)
		if err != nil {
			return "", err
		}
		if found[role], err = VerifyCoreContainerPayload(ctx, container, appDir, index, mode); err != nil {
			return "", fmt.Errorf("%s payload health: %w", role, err)
		}
		if err = verifyNativeCoreSchemaReceipt(pid, marker); err != nil {
			return "", err
		}
		endpoint := fmt.Sprintf("http://%s:%d%s?health=1", ip, port, path)
		if err = coreAuthenticatedHealthRequest(ctx, client, endpoint, token, marker); err != nil {
			return "", err
		}
		after, err := nativeCoreContainerPID(ctx, container)
		if err != nil || after != pid {
			return "", fmt.Errorf("health component restarted")
		}
		afterProcess, err := nativeProcessIdentity(pid)
		if err != nil || afterProcess != process {
			return "", fmt.Errorf("health process changed")
		}
		final, err := readNativeCoreMarker(pid)
		if err != nil || final != marker {
			return "", fmt.Errorf("health marker changed")
		}
	}
	if !j.NoOp && !j.MetadataOnly {
		if err = s.Checkpoint.verifyContainerIdentities(ctx, record.Inventory, false); err != nil {
			return "", err
		}
	}
	return coreHealthPayloadEvidence("CP/UI static payloads and schema receipts; authenticated native CP/UI bridge and live database reads", found), nil
}

func coreAuthenticatedHealthRequest(ctx context.Context, client *http.Client, endpoint, token string, marker coreComponentMarker) error {
	observed, err := coreSchemaRequest(ctx, client, endpoint, "X-CLI-Token", token, marker, false)
	if err != nil {
		return err
	}
	if observed.State != "completed" || !observed.DatabaseReady {
		return fmt.Errorf("authenticated component database health incomplete")
	}
	return nil
}

package systemupdate

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"time"
)

type coreSchemaObservation struct {
	DatabaseReady bool `json:"databaseReady"`
	coreComponentMarker
	Managed bool   `json:"managed"`
	State   string `json:"state"`
}

// Schema observes/requests one exact durable component schema identity. It
// never treats an HTTP success or a version string as completed migration, and
// never resubmits a started/unknown receipt. Normal admin/user acceptance is a
// separate final health gate, not implied by this privileged native endpoint.
func (s NativeCoreServices) Schema(ctx context.Context, request, role string, begin bool) (CoreActionObservation, error) {
	if role != "cp" && role != "ui" {
		return CoreActionObservation{}, fmt.Errorf("exact core schema role required")
	}
	m := CoreManager{Root: s.Checkpoint.Root}
	j, err := m.Read()
	if err != nil || j.RequestID != request || j.Phase != "applying" {
		return CoreActionObservation{}, fmt.Errorf("active core apply required")
	}
	active := false
	for _, step := range j.Steps {
		if step.Name == "apply-"+role && step.State == "started" {
			active = true
		}
	}
	if !active {
		return CoreActionObservation{}, fmt.Errorf("exact active core component action required")
	}
	if err = s.Checkpoint.verifyReservation(j); err != nil {
		return CoreActionObservation{}, err
	}
	machine, err := s.Checkpoint.observeMachine()
	if err != nil || machine != j.Previous.Machine {
		return CoreActionObservation{}, fmt.Errorf("schema machine identity changed")
	}
	current, err := m.ReadReceipt()
	if err != nil || !reflect.DeepEqual(current, j.Previous) {
		return CoreActionObservation{}, fmt.Errorf("core schema commitment changed")
	}
	if _, _, err = m.Selection(j.ManifestSHA256, s.Cache.TrustKeyPath); err != nil {
		return CoreActionObservation{}, err
	}
	record, err := s.Checkpoint.Read(j)
	if err != nil {
		return CoreActionObservation{}, err
	}
	if err = s.Checkpoint.verifyContainerIdentities(ctx, record.Inventory, false); err != nil {
		return CoreActionObservation{}, err
	}
	stageRaw, err := ReadCoreState(s.stagePath(request, role), 64<<10)
	if err != nil {
		return CoreActionObservation{}, err
	}
	var stage CoreServiceStage
	if json.Unmarshal(stageRaw, &stage) != nil || stage.RequestID != request || stage.ManifestSHA256 != j.ManifestSHA256 || stage.Role != role || (stage.Phase != "swapped" && stage.Phase != "reused") || (stage.Phase == "swapped" && stage.MarkerState != "installed") || (role == "cp" && stage.SelectionState != "installed") || (stage.StartState != "requested" && stage.StartState != "started") {
		return CoreActionObservation{}, fmt.Errorf("complete verified service stage required")
	}
	member, err := coreServiceMember(j.Target, role)
	if err != nil || member.Artifact.SHA256 != stage.ArtifactSHA256 {
		return CoreActionObservation{}, fmt.Errorf("core schema target differs")
	}
	if err = CheckCoreMemberAuthority(member, j.Target.Channel, s.Cache.TrustKeyPath); err != nil {
		return CoreActionObservation{}, err
	}

	name, port, path := "youeye-control", 3000, "/api/appliance/core-component"
	if s.CPPort != 0 {
		port = s.CPPort
	}
	if role == "ui" {
		name, path = "youeye-ui", "/api/appliance/core-ui"
	}
	header, tokenPath := "X-CLI-Token", filepath.Join(s.Checkpoint.DataRoot, "config", "cli-token")
	if port < 1 || port > 65535 {
		return CoreActionObservation{}, fmt.Errorf("invalid native service port")
	}
	// Host descriptors retain the component marker and static file truth. The
	// HTTP reply must match them, including the older identity of a reused member.
	pid, err := nativeCoreContainerPID(ctx, name)
	if err != nil {
		return CoreActionObservation{}, err
	}
	processIdentity, err := nativeProcessIdentity(pid)
	if err != nil {
		return CoreActionObservation{}, err
	}
	marker, err := readNativeCoreMarker(pid)
	if err != nil || marker.Role != role || marker.ArtifactSHA256 != member.Artifact.SHA256 || marker != stage.Component || (stage.Phase == "swapped" && (marker.RequestID != j.RequestID || marker.ManifestSHA256 != j.ManifestSHA256)) {
		return CoreActionObservation{}, fmt.Errorf("installed core marker differs")
	}
	index, err := m.LoadPayloadIndex(member.Artifact.SHA256)
	if err != nil {
		return CoreActionObservation{}, err
	}
	if err = VerifyCoreContainerPayload(ctx, name, stage.AppDir, index); err != nil {
		return CoreActionObservation{}, err
	}
	ip, err := s.componentAddress(ctx, "youeye-control", record.Inventory.Bridge)
	if err != nil {
		return CoreActionObservation{}, err
	}
	rawToken, err := ReadCoreState(tokenPath, 128)
	if err != nil {
		return CoreActionObservation{}, fmt.Errorf("current native component credential unavailable")
	}
	token := strings.TrimSpace(string(rawToken))
	if !validSHA256(token) {
		return CoreActionObservation{}, fmt.Errorf("invalid current native component credential")
	}
	transport := &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 5 * time.Second}).DialContext}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	endpoint := fmt.Sprintf("http://%s:%d%s", ip, port, path)
	observed, err := coreSchemaRequest(ctx, client, endpoint, header, token, marker, false)
	if err != nil {
		return CoreActionObservation{State: "unknown"}, err
	}
	if observed.State == "pending" && begin {
		observed, err = coreSchemaRequest(ctx, client, endpoint, header, token, marker, true)
		if err != nil {
			return CoreActionObservation{State: "unknown"}, err
		}
	}
	if err = s.Checkpoint.verifyContainerIdentities(ctx, record.Inventory, false); err != nil {
		return CoreActionObservation{State: "unknown"}, err
	}
	after, err := nativeCoreContainerPID(ctx, name)
	if err != nil || after != pid {
		return CoreActionObservation{State: "unknown"}, fmt.Errorf("component restarted during schema observation")
	}
	afterIdentity, err := nativeProcessIdentity(pid)
	if err != nil || afterIdentity != processIdentity {
		return CoreActionObservation{State: "unknown"}, fmt.Errorf("component process changed during schema observation")
	}
	finalMarker, err := readNativeCoreMarker(pid)
	if err != nil || finalMarker != marker {
		return CoreActionObservation{State: "unknown"}, fmt.Errorf("component marker changed during schema observation")
	}
	if observed.State == "completed" {
		if err = verifyNativeCoreSchemaReceipt(pid, marker); err != nil {
			return CoreActionObservation{State: "unknown"}, err
		}
		if err = VerifyCoreContainerPayload(ctx, name, stage.AppDir, index); err != nil {
			return CoreActionObservation{State: "unknown"}, err
		}
	}
	return coreSchemaActionObservation(observed), nil
}

func coreSchemaActionObservation(observed coreSchemaObservation) CoreActionObservation {
	marker := observed.coreComponentMarker
	switch observed.State {
	case "completed":
		return CoreActionObservation{State: "succeeded", Evidence: "core-component/" + marker.Role + "/" + marker.ManifestSHA256 + "/" + marker.ArtifactSHA256}
	default:
		// A started receipt alone is not evidence that its original executor lives.
		// Only the native runner can positively report running; absence of a terminal
		// schema receipt stays unknown and never blocks a verified recovery fence.
		return CoreActionObservation{State: "unknown", Evidence: "core-component/" + marker.Role + "/schema-" + observed.State}
	}
}

func coreSchemaRequest(ctx context.Context, client *http.Client, endpoint, header, token string, expected coreComponentMarker, begin bool) (coreSchemaObservation, error) {
	var result coreSchemaObservation
	method := "GET"
	var body io.Reader
	if begin {
		method = "POST"
		raw, err := json.Marshal(expected)
		if err != nil {
			return result, err
		}
		body = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return result, fmt.Errorf("invalid native component request")
	}
	req.Header.Set(header, token)
	if begin {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
	if err != nil {
		return result, fmt.Errorf("native component response unavailable")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return result, fmt.Errorf("native component did not accept exact schema request")
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 16385))
	if err != nil || len(raw) > 16384 || json.Unmarshal(raw, &result) != nil || !result.Managed || result.coreComponentMarker != expected {
		return result, fmt.Errorf("native component receipt differs from installed identity")
	}
	switch result.State {
	case "pending", "started", "completed", "unknown":
	default:
		return result, fmt.Errorf("invalid native component schema state")
	}
	return result, nil
}

func (s NativeCoreServices) componentAddress(ctx context.Context, name, bridge string) (string, error) {
	if !coreContainerName.MatchString(bridge) {
		return "", fmt.Errorf("exact native bridge required")
	}
	raw, err := s.Checkpoint.capture(ctx, "incus", "network", "get", bridge, "ipv4.address")
	if err != nil {
		return "", err
	}
	network, err := netip.ParsePrefix(strings.TrimSpace(string(raw)))
	if err != nil || !network.Addr().Is4() || !network.Addr().IsPrivate() || network.Bits() != 24 {
		return "", fmt.Errorf("verified native service subnet required")
	}
	base := network.Masked().Addr().As4()
	offset := byte(16)
	if name == "youeye-ui" {
		offset = 15
	} else if name != "youeye-control" {
		return "", fmt.Errorf("unknown native component")
	}
	base[3] = offset
	address := netip.AddrFrom4(base)
	raw, err = s.Checkpoint.capture(ctx, "incus", "query", "/1.0/instances/"+name+"/state")
	if err != nil {
		return "", err
	}
	var state struct {
		Status  string `json:"status"`
		Network map[string]struct {
			Addresses []struct {
				Family  string `json:"family"`
				Address string `json:"address"`
				Scope   string `json:"scope"`
			} `json:"addresses"`
		} `json:"network"`
	}
	if json.Unmarshal(raw, &state) != nil || state.Status != "Running" {
		return "", fmt.Errorf("native component network is not running")
	}
	for device, n := range state.Network {
		if device == "lo" {
			continue
		}
		for _, a := range n.Addresses {
			if a.Family == "inet" && a.Scope == "global" && a.Address == address.String() {
				return address.String(), nil
			}
		}
	}
	return "", fmt.Errorf("native component lacks its exact private address")
}

func readNativeCoreMarker(pid int) (coreComponentMarker, error) {
	var marker coreComponentMarker
	root, err := os.Open(fmt.Sprintf("/proc/%d/root", pid))
	if err != nil {
		return marker, fmt.Errorf("core process filesystem unavailable")
	}
	defer root.Close()
	dir, err := openCorePayloadDirectory(int(root.Fd()), "etc/youeye")
	if err != nil {
		return marker, err
	}
	defer dir.Close()
	raw, err := readCoreContainerStateAt(dir, "core-component.json")
	if err != nil {
		return marker, err
	}
	if json.Unmarshal(raw, &marker) != nil || marker.Schema != "youeye.core-component.v1" || !coreRequestPattern.MatchString(marker.RequestID) || !validSHA256(marker.ManifestSHA256) || !validSHA256(marker.ArtifactSHA256) {
		return marker, fmt.Errorf("invalid native core component marker")
	}
	return marker, nil
}

func verifyNativeCoreSchemaReceipt(pid int, marker coreComponentMarker) error {
	root, err := os.Open(fmt.Sprintf("/proc/%d/root", pid))
	if err != nil {
		return fmt.Errorf("component schema filesystem unavailable")
	}
	defer root.Close()
	return verifyCoreSchemaReceiptAt(root, marker)
}

// The authenticated bridge response must agree with the component's protected
// durable receipt. An HTTP 200 cannot replace native observation of the attempt.
func verifyCoreSchemaReceiptAt(root *os.File, marker coreComponentMarker) error {
	directory := "var/lib/youeye/state/core-component-schemas"
	if marker.Role == "ui" {
		directory = "var/lib/youeye/ui-data/.core-component-schemas"
	} else if marker.Role != "cp" {
		return fmt.Errorf("exact component receipt role required")
	}
	dir, err := openCorePayloadDirectory(int(root.Fd()), directory)
	if err != nil {
		return err
	}
	defer dir.Close()
	key := sha256.Sum256([]byte(strings.Join([]string{marker.Role, marker.RequestID, marker.ManifestSHA256, marker.ArtifactSHA256}, "\x00")))
	raw, err := readCoreContainerStateAt(dir, fmt.Sprintf("%x.json", key))
	if err != nil {
		return err
	}
	var receipt struct {
		coreComponentMarker
		State string `json:"state"`
	}
	if json.Unmarshal(raw, &receipt) != nil || receipt.coreComponentMarker != marker || receipt.State != "completed" {
		return fmt.Errorf("native schema completion receipt is absent or differs")
	}
	return nil
}

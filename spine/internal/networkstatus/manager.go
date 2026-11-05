package networkstatus

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const (
	StatusSchema = "youeye.host-network-status.v1"
	DefaultRoot  = "/var/lib/youeye-state/bootstrap"
)

type profile struct {
	Schema string `json:"schema"`
	ID     string `json:"id"`
	Kind   string `json:"kind"`
	IPv4   struct {
		Mode    string   `json:"mode"`
		Address string   `json:"address,omitempty"`
		Gateway string   `json:"gateway,omitempty"`
		DNS     []string `json:"dns,omitempty"`
	} `json:"ipv4"`
}

type appliedStatus struct {
	Schema    string `json:"schema"`
	Phase     string `json:"phase"`
	Interface string `json:"interface"`
	Kind      string `json:"kind"`
	IPv4Mode  string `json:"ipv4_mode"`
	Attempt   int    `json:"attempt"`
	Percent   int    `json:"percent"`
	ErrorCode string `json:"error_code,omitempty"`
	Detail    string `json:"detail,omitempty"`
	UpdatedAt string `json:"updated_at"`
}

type Status struct {
	Schema            string `json:"schema"`
	Phase             string `json:"phase"`
	Adapter           string `json:"adapter,omitempty"`
	Kind              string `json:"kind"`
	IPv4Mode          string `json:"ipv4_mode"`
	IPv4Address       string `json:"ipv4_address,omitempty"`
	ErrorCode         string `json:"error_code,omitempty"`
	Detail            string `json:"detail,omitempty"`
	UpdatedAt         string `json:"updated_at,omitempty"`
	WiFiSupported     bool   `json:"wifi_supported"`
	CanConfigureLocal bool   `json:"can_configure_locally"`
}

type Manager struct {
	Root      string
	Addresses func(string) ([]net.Addr, error)
}

func NewDefault() *Manager { return &Manager{Root: DefaultRoot, Addresses: interfaceAddresses} }

func interfaceAddresses(name string) ([]net.Addr, error) {
	device, err := net.InterfaceByName(name)
	if err != nil {
		return nil, err
	}
	return device.Addrs()
}

func (manager *Manager) Status() (Status, error) {
	root := manager.Root
	if root == "" {
		root = DefaultRoot
	}
	profileRaw, err := os.ReadFile(filepath.Join(root, "network-profile.json"))
	if err != nil {
		return Status{}, fmt.Errorf("read saved host network profile: %w", err)
	}
	var desired profile
	if err := strictJSON(profileRaw, &desired); err != nil || desired.Schema != "youeye.network-profile.v1" || desired.ID != "primary" || desired.Kind != "ethernet" || (desired.IPv4.Mode != "dhcp" && desired.IPv4.Mode != "static") {
		return Status{}, errors.New("saved host network profile is invalid")
	}
	result := Status{
		Schema: StatusSchema, Phase: "starting", Kind: "ethernet", IPv4Mode: desired.IPv4.Mode,
		WiFiSupported: false, CanConfigureLocal: true,
	}
	statusRaw, err := os.ReadFile(filepath.Join(root, "network-status.json"))
	if errors.Is(err, os.ErrNotExist) {
		return result, nil
	}
	if err != nil {
		return Status{}, fmt.Errorf("read applied host network status: %w", err)
	}
	var applied appliedStatus
	if err := strictJSON(statusRaw, &applied); err != nil || applied.Schema != "youeye.bootstrap-network.v1" || !validAppliedStatus(applied) {
		return Status{}, errors.New("applied host network status is invalid")
	}
	result.Phase = applied.Phase
	result.Adapter = applied.Interface
	result.IPv4Mode = applied.IPv4Mode
	result.ErrorCode = applied.ErrorCode
	result.Detail = boundedDetail(applied.Detail)
	result.UpdatedAt = applied.UpdatedAt
	addresses := manager.Addresses
	if addresses == nil {
		addresses = interfaceAddresses
	}
	if applied.Interface != "" {
		if values, addressErr := addresses(applied.Interface); addressErr == nil {
			for _, value := range values {
				ip, _, parseErr := net.ParseCIDR(value.String())
				if parseErr == nil && ip.To4() != nil && !ip.IsLoopback() && !ip.IsLinkLocalUnicast() {
					result.IPv4Address = ip.String()
					break
				}
			}
		}
	}
	return result, nil
}

func validAppliedStatus(status appliedStatus) bool {
	if !regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,32}$`).MatchString(status.Interface) || status.Kind != "ethernet" || (status.IPv4Mode != "dhcp" && status.IPv4Mode != "static") || status.Attempt < 1 || status.Attempt > 20 || status.Percent < 0 || status.Percent > 100 {
		return false
	}
	switch status.Phase {
	case "checking", "ready", "needs_attention":
		return true
	default:
		return false
	}
}

func boundedDetail(value string) string {
	value = strings.Map(func(char rune) rune {
		if char < 0x20 || char == 0x7f {
			return -1
		}
		return char
	}, strings.TrimSpace(value))
	if len(value) > 256 {
		return value[:256]
	}
	return value
}

func strictJSON(raw []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("trailing JSON")
	}
	return nil
}

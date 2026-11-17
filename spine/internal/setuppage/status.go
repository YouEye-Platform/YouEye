package setuppage

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Status is GET /api/preparing.
type Status struct {
	State       string   `json:"state"` // running | retrying | restarting | needs_attention | complete
	Stage       string   `json:"stage"`
	Detail      string   `json:"detail"`
	Percent     int      `json:"percent"`
	Attempt     int      `json:"attempt"`
	MaxAttempts int      `json:"max_attempts"`
	UpdatedAt   string   `json:"updated_at"`
	Network     Network  `json:"network"`
	Addresses   Address  `json:"addresses"`
	Log         []string `json:"log"`
	// CAFingerprint is the box CA root's SHA-256 (compare before trusting it).
	CAFingerprint string `json:"ca_fingerprint,omitempty"`
}

// Network is what the page can say about the wired network.
type Network struct {
	Phase   string `json:"phase"` // checking | ready | needs_attention | "" (not checked yet)
	Online  bool   `json:"online"`
	DNS     bool   `json:"dns"`
	Problem string `json:"problem,omitempty"`
}

// Address lists where the page (and later the claim page) is reachable.
type Address struct {
	IP    string `json:"ip,omitempty"`
	Local string `json:"local,omitempty"`
}

// MaxAttempts matches first-deploy.sh's default.
const MaxAttempts = 8

// ReadStatus builds the status from State files and journal lines.
func ReadStatus(stateRoot string, journal []string) Status {
	status := Status{State: "running", Stage: "starting", Detail: "Starting YouEye", MaxAttempts: MaxAttempts, Log: []string{}}
	var progress struct {
		State     string `json:"state"`
		Stage     string `json:"stage"`
		Detail    string `json:"detail"`
		Percent   int    `json:"percent"`
		Attempt   int    `json:"attempt"`
		UpdatedAt string `json:"updated_at"`
	}
	if readJSON(filepath.Join(stateRoot, "first-deploy/progress.json"), &progress) {
		status.Stage = cleanText(progress.Stage, 48)
		status.Detail = cleanText(progress.Detail, 200)
		status.Attempt = progress.Attempt
		status.UpdatedAt = cleanText(progress.UpdatedAt, 40)
		if progress.Percent >= 0 && progress.Percent <= 100 {
			status.Percent = progress.Percent
		}
		switch progress.State {
		case "retrying", "needs_attention", "complete":
			status.State = progress.State
		}
		switch status.Stage {
		case "system_restart":
			status.State = "restarting"
		case "setup":
			// First deploy is opening the gate: the claim page comes next.
			status.State = "complete"
		}
	}
	if info, err := os.Stat(filepath.Join(stateRoot, "first-deploy/complete")); err == nil && info.Mode().IsRegular() {
		status.State, status.Percent = "complete", 100
	}
	var network struct {
		Phase  string `json:"phase"`
		Code   string `json:"error_code"`
		Detail string `json:"detail"`
	}
	status.Network = Network{Online: true, DNS: true}
	if readJSON(filepath.Join(stateRoot, "bootstrap/network-status.json"), &network) {
		status.Network.Phase = cleanText(network.Phase, 32)
		if network.Phase != "ready" {
			switch network.Code {
			case "link_down", "address_unavailable", "route_unavailable", "no_adapter", "invalid_profile":
				status.Network.Online, status.Network.DNS = false, false
			case "dns_unavailable":
				status.Network.DNS = false
			}
			if network.Code != "" {
				status.Network.Problem = cleanText(network.Detail, 200)
			}
		}
	}
	for _, line := range journal {
		if line = Redact(line); line != "" {
			status.Log = append(status.Log, line)
		}
	}
	if len(status.Log) > 30 {
		status.Log = status.Log[len(status.Log)-30:]
	}
	return status
}

func readJSON(path string, into any) bool {
	raw, err := os.ReadFile(path)
	if err != nil || len(raw) > 1<<20 {
		return false
	}
	return json.Unmarshal(raw, into) == nil
}

func cleanText(value string, limit int) string {
	value = strings.Map(func(char rune) rune {
		if char < 0x20 || char == 0x7f {
			return -1
		}
		return char
	}, strings.TrimSpace(value))
	if len(value) > limit {
		value = value[:limit]
	}
	return value
}

var (
	secretAssignment = regexp.MustCompile(`(?i)((?:password|passwd|passphrase|secret|token|api[_-]?key|authorization|private[_-]?key|credential|cookie|session)[a-z_-]*)(["']?\s*[:=]\s*["']?)[^\s"',;&]+`)
	bearer           = regexp.MustCompile(`(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}`)
	urlUserInfo      = regexp.MustCompile(`(://)[^/\s:@]+:[^/\s@]+@`)
	longToken        = regexp.MustCompile(`[A-Za-z0-9+/_=-]{40,}`)
	pemBlock         = regexp.MustCompile(`-----BEGIN [A-Z ]+-----.*`)
)

// Redact removes anything that could be a secret from one journal line. The
// page is open to the whole LAN before anyone has claimed the box, so it is
// strict: long tokens (digests included) are hidden too.
func Redact(line string) string {
	line = cleanText(line, 400)
	line = pemBlock.ReplaceAllString(line, "[hidden]")
	line = urlUserInfo.ReplaceAllString(line, "${1}[hidden]@")
	line = bearer.ReplaceAllString(line, "${1} [hidden]")
	line = secretAssignment.ReplaceAllString(line, "${1}${2}[hidden]")
	line = longToken.ReplaceAllString(line, "[hidden]")
	if len(line) > 240 {
		line = line[:240] + "…"
	}
	return line
}

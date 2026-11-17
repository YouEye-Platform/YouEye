package installer

import (
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"

	"rsc.io/qr"
)

// consoleLocalNameCommand asks Spine for the mDNS name Avahi publishes.
var consoleLocalNameCommand = []string{"/usr/local/bin/youeye", "mdns", "name"}

var (
	consoleLocalNameMu      sync.Mutex
	consoleLocalNameValue   string
	consoleLocalNameChecked time.Time
	consoleLocalNamePattern = regexp.MustCompile(`^youeye(-[0-9]{1,4})?\.local$`)
)

// consoleLocalName returns the published name, read at most every 10 s ("" when
// it can't be read; the console then shows youeye.local).
func consoleLocalName(now time.Time) string {
	if value, ok := os.LookupEnv("YOUEYE_CONSOLE_LOCAL_NAME"); ok {
		return value
	}
	consoleLocalNameMu.Lock()
	defer consoleLocalNameMu.Unlock()
	if !consoleLocalNameChecked.IsZero() && now.Sub(consoleLocalNameChecked) < 10*time.Second {
		return consoleLocalNameValue
	}
	consoleLocalNameChecked = now
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, consoleLocalNameCommand[0], consoleLocalNameCommand[1:]...).Output()
	name := strings.TrimSpace(string(out))
	if err != nil || !consoleLocalNamePattern.MatchString(name) {
		name = ""
	}
	consoleLocalNameValue = name
	return name
}

// consoleQRCode draws text as a QR code with Unicode half blocks: two module
// rows per text line, light modules drawn as blocks so the code reads dark on
// light on the console's dark background.
func consoleQRCode(text string) string {
	code, err := qr.Encode(text, qr.M)
	if err != nil {
		return ""
	}
	const quiet = 2
	size := code.Size
	light := func(x, y int) bool {
		if x < -quiet || y < -quiet || x >= size+quiet || y >= size+quiet {
			return false
		}
		if x < 0 || y < 0 || x >= size || y >= size {
			return true
		}
		return !code.Black(x, y)
	}
	var lines []string
	for y := -quiet; y < size+quiet; y += 2 {
		var line strings.Builder
		for x := -quiet; x < size+quiet; x++ {
			top, bottom := light(x, y), light(x, y+1)
			switch {
			case top && bottom:
				line.WriteRune('█')
			case top:
				line.WriteRune('▀')
			case bottom:
				line.WriteRune('▄')
			default:
				line.WriteRune(' ')
			}
		}
		lines = append(lines, line.String())
	}
	return strings.Join(lines, "\n")
}

// consoleCAFingerprint is the SHA-256 of the box CA root (colon-separated
// upper-case hex, as browsers show it), or "" before Spine made it.
func consoleCAFingerprint(path string) string {
	raw, err := os.ReadFile(path)
	if err != nil || len(raw) > 1<<16 {
		return ""
	}
	block, _ := pem.Decode(raw)
	if block == nil || block.Type != "CERTIFICATE" {
		return ""
	}
	if _, err := x509.ParseCertificate(block.Bytes); err != nil {
		return ""
	}
	sum := sha256.Sum256(block.Bytes)
	parts := make([]string, len(sum))
	for index, value := range sum {
		parts[index] = fmt.Sprintf("%02X", value)
	}
	return strings.Join(parts, ":")
}

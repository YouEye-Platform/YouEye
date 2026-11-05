package systemupdate

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
)

// Observe the prepared credential values in current files and actual service
// process environments. URL/host changes may alter surrounding configuration;
// authority must still be this copy's generated value, not just a journal flag.
func (m CoreManager) VerifyIndependentCopyAuthority(ctx context.Context, request CoreCopyRequest, p NativeCoreCheckpoint) error {
	raw, err := ReadCoreState(filepath.Join(m.Root, "copy-runtime-authority.json"), 4<<20)
	var j copyAuthorityJournal
	if err != nil || json.Unmarshal(raw, &j) != nil || j.Request != request || !j.Prepared || validateCopyAuthorityFiles(j.Files, p.DataRoot) != nil {
		return fmt.Errorf("prepared runtime authority unavailable")
	}
	for _, f := range j.Files {
		current, e := readCopyAuthorityFile(ctx, p, f)
		if e != nil {
			return e
		}
		prefix := ""
		unit := ""
		if strings.HasSuffix(f.Path, ".service") {
			prefix = "Environment="
			unit = strings.TrimSuffix(filepath.Base(f.Path), ".service")
		}
		if strings.HasSuffix(f.Path, ".service") || strings.HasSuffix(f.Path, ".env") {
			want, e := copyEnvironmentAuthority(f.Content, prefix)
			if e != nil {
				return e
			}
			got, e := copyEnvironmentAuthority(string(current), prefix)
			if e != nil {
				return e
			}
			for key, value := range want {
				if got[key] != value {
					return fmt.Errorf("prepared runtime authority binding changed")
				}
			}
			if f.Container != "" {
				if unit == "" {
					unit = f.Container
				}
				pidBytes, e := p.capture(ctx, "incus", "exec", f.Container, "--", "systemctl", "show", unit, "--property=MainPID", "--value")
				pid, e2 := strconv.Atoi(strings.TrimSpace(string(pidBytes)))
				if e != nil || e2 != nil || pid < 1 {
					return fmt.Errorf("prepared service process unavailable")
				}
				environment, e := p.capture(ctx, "incus", "exec", f.Container, "--", "cat", fmt.Sprintf("/proc/%d/environ", pid))
				if e != nil {
					return fmt.Errorf("prepared process authority unavailable")
				}
				live, e := copyEnvironmentAuthority(strings.ReplaceAll(string(environment), "\x00", "\n"), "")
				if e != nil {
					return e
				}
				for key, value := range want {
					if live[key] != value {
						return fmt.Errorf("service has not loaded prepared copy authority")
					}
				}
			}
		} else if strings.TrimSpace(string(current)) != strings.TrimSpace(f.Content) {
			return fmt.Errorf("prepared machine credential changed")
		}
	}
	raw, err = ReadCoreState(filepath.Join(m.Root, "copy-incus-authority.json"), 65536)
	var incus copyIncusJournal
	if err != nil || json.Unmarshal(raw, &incus) != nil || incus.Request != request || !incus.Prepared {
		return fmt.Errorf("prepared Incus authority unavailable")
	}
	actual, err := p.InspectCopyIncusAuthority(ctx)
	if err != nil {
		return err
	}
	server, e := copyCertificateFingerprint([]byte(incus.ServerCertificate))
	client, e2 := copyCertificateFingerprint([]byte(incus.ClientCertificate))
	if e != nil || e2 != nil || actual.ServerFingerprint != server || actual.ClientFingerprint != client || actual.ServerFingerprint == incus.Source.ServerFingerprint || actual.ClientFingerprint == incus.Source.ClientFingerprint {
		return fmt.Errorf("live Incus authority differs from copy")
	}
	return nil
}

func copyEnvironmentAuthority(raw, prefix string) (map[string]string, error) {
	keys := map[string]bool{"JWT_SECRET": true, "ENCRYPTION_SECRET": true, "DATABASE_URL": true, "TEST_ADMIN_SECRET": true, "PIHOLE_PASSWORD": true}
	result := map[string]string{}
	for _, line := range strings.Split(raw, "\n") {
		if !strings.HasPrefix(line, prefix) {
			continue
		}
		key, value, ok := strings.Cut(strings.TrimPrefix(line, prefix), "=")
		if !ok || !keys[key] {
			continue
		}
		if value == "" || result[key] != "" {
			return nil, fmt.Errorf("ambiguous runtime credential declaration")
		}
		result[key] = value
	}
	if len(result) == 0 {
		return nil, fmt.Errorf("runtime credential declaration absent")
	}
	return result, nil
}

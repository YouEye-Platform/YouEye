package systemupdate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

type copyCaddyJournal struct {
	Schema        string          `json:"schema"`
	Request       CoreCopyRequest `json:"request"`
	SourceSHA256  string          `json:"source_sha256"`
	Configuration json.RawMessage `json:"configuration"`
	Prepared      bool            `json:"prepared"`
}

// Caddy routes are ordinary copied configuration. Its loaded certificates,
// private CA and issuance account/cache are machine authority and are replaced.
func copiedCaddyConfiguration(raw []byte) ([]byte, error) {
	var config map[string]any
	if json.Unmarshal(raw, &config) != nil || config == nil {
		return nil, fmt.Errorf("copy requires a valid saved Caddy configuration")
	}
	if storage, ok := config["storage"]; ok && storage != nil {
		return nil, fmt.Errorf("custom Caddy storage requires a copy adapter")
	}
	apps, ok := config["apps"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("copied Caddy application configuration unavailable")
	}
	if pki, ok := apps["pki"].(map[string]any); ok && len(pki) > 0 {
		authorities, ok := pki["certificate_authorities"].(map[string]any)
		if !ok || len(pki) != 1 || len(authorities) != 1 {
			return nil, fmt.Errorf("custom Caddy PKI requires a copy adapter")
		}
		local, ok := authorities["local"].(map[string]any)
		if !ok {
			return nil, fmt.Errorf("custom Caddy PKI requires a copy adapter")
		}
		allowed := map[string]bool{"name": true, "root_common_name": true, "intermediate_common_name": true, "root_lifetime": true, "intermediate_lifetime": true, "install_trust": true}
		for key := range local {
			if !allowed[key] {
				return nil, fmt.Errorf("external Caddy signing authority requires a copy adapter")
			}
		}
	}
	if tls, ok := apps["tls"].(map[string]any); ok {
		if certificates, ok := tls["certificates"].(map[string]any); ok {
			for key := range certificates {
				if key != "load_pem" && key != "automate" {
					return nil, fmt.Errorf("custom Caddy certificate loader requires a copy adapter")
				}
			}
			delete(certificates, "load_pem")
			delete(certificates, "automate")
		}
		if automation, ok := tls["automation"].(map[string]any); ok {
			if policies, ok := automation["policies"].([]any); ok {
				for _, value := range policies {
					policy, ok := value.(map[string]any)
					if !ok {
						return nil, fmt.Errorf("invalid copied TLS policy")
					}
					policy["issuers"] = []any{map[string]any{"module": "internal"}}
					delete(policy, "managers")
				}
			}
		}
	}
	return json.Marshal(config)
}

func (p NativeCoreCheckpoint) InspectCopyCaddyAuthority() (string, error) {
	raw, err := ReadCoreState(filepath.Join(p.DataRoot, "caddy/config/caddy/autosave.json"), 4<<20)
	if err != nil {
		return "", fmt.Errorf("saved copied Caddy configuration unavailable")
	}
	if _, err = copiedCaddyConfiguration(raw); err != nil {
		return "", err
	}
	return copyAuthorityDigest(raw), nil
}

func (m CoreManager) PrepareIndependentCopyCaddy(ctx context.Context, request CoreCopyRequest, b CoreLifecycleBarrier, p NativeCoreCheckpoint, observeHardware func() (string, error)) error {
	if request.Validate() != nil || observeHardware == nil {
		return fmt.Errorf("exact copy Caddy context required")
	}
	hardware, err := observeHardware()
	if err != nil || hardware != request.DestinationHardware {
		return fmt.Errorf("copy Caddy hardware differs")
	}
	unlock, err := m.lockCoreRaw()
	if err != nil {
		return err
	}
	defer unlock()
	copy, err := m.readCopy()
	if err != nil || copy.Request != request || copy.Phase != "verifying" {
		return fmt.Errorf("native copy admission required")
	}
	reservation, err := b.ReadCopy()
	if err != nil || reservation.Role != "destination" || reservation.Request != request {
		return fmt.Errorf("destination copy lifecycle required")
	}
	source, err := m.ReadCopySource(request)
	if err != nil || !source.Quiesced {
		return fmt.Errorf("quiesced copied inventory required")
	}
	if err = verifyCopyStoppedRuntime(ctx, p, source); err != nil {
		return err
	}
	configurationPath := filepath.Join(p.DataRoot, "caddy/config/caddy/autosave.json")
	current, err := ReadCoreState(configurationPath, 4<<20)
	if err != nil {
		return err
	}
	journalPath := filepath.Join(m.Root, "copy-caddy-authority.json")
	var j copyCaddyJournal
	raw, err := ReadCoreState(journalPath, 4<<20)
	if err == nil {
		if json.Unmarshal(raw, &j) != nil || j.Schema != "youeye.copy-caddy-authority.v1" || j.Request.Validate() != nil {
			return fmt.Errorf("invalid copy Caddy journal")
		}
		if j.Request != request {
			var previous CoreCopyJournal
			prior, e := ReadCoreState(filepath.Join(m.Root, "copy-history", j.Request.RequestID+".json"), 4<<20)
			if e != nil || json.Unmarshal(prior, &previous) != nil || previous.Request != j.Request || previous.Phase != "committed" || j.Request.DestinationHardware != request.SourceHardware || !j.Prepared {
				return fmt.Errorf("another copy owns Caddy authority")
			}
			err = os.ErrNotExist
		}
	}
	if errors.Is(err, os.ErrNotExist) {
		if copyAuthorityDigest(current) != source.Resources.CaddyAuthoritySHA256 {
			return fmt.Errorf("copied Caddy configuration differs from source")
		}
		next, e := copiedCaddyConfiguration(current)
		if e != nil {
			return e
		}
		j = copyCaddyJournal{Schema: "youeye.copy-caddy-authority.v1", Request: request, SourceSHA256: source.Resources.CaddyAuthoritySHA256, Configuration: next}
		raw, e = json.Marshal(j)
		if e != nil {
			return e
		}
		if e = atomicWrite(journalPath, raw, 0600); e != nil {
			return e
		}
	} else if err != nil {
		return err
	}
	if j.SourceSHA256 != source.Resources.CaddyAuthoritySHA256 || !json.Valid(j.Configuration) {
		return fmt.Errorf("copied Caddy request binding changed")
	}
	if string(current) != string(j.Configuration) {
		if copyAuthorityDigest(current) != j.SourceSHA256 {
			return fmt.Errorf("Caddy configuration changed outside copy preparation")
		}
		if err = atomicWrite(configurationPath, j.Configuration, 0600); err != nil {
			return err
		}
	}
	if !j.Prepared {
		// Exact generated authority/cache directories only. Routes, static files
		// and all other copied application data remain intact.
		for _, name := range []string{"pki", "acme", "certificates", "ocsp", "locks"} {
			directory := filepath.Join(p.DataRoot, "caddy/data/caddy", name)
			info, e := os.Lstat(directory)
			if errors.Is(e, os.ErrNotExist) {
				continue
			}
			if e != nil || !info.IsDir() {
				return fmt.Errorf("copied Caddy authority storage is not an owned directory")
			}
			if e = os.RemoveAll(directory); e != nil {
				return e
			}
		}
		j.Prepared = true
		raw, err = json.Marshal(j)
		if err != nil {
			return err
		}
		if err = atomicWrite(journalPath, raw, 0600); err != nil {
			return err
		}
	}
	return nil
}

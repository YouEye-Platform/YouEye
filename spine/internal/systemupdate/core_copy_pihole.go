package systemupdate

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/pelletier/go-toml/v2"
)

// The standard appliance owns the Pi-hole password. Separately enrolled
// app/2FA credentials and password environment overrides need a disposition
// before copying; do not silently retain them or change the source.
func (p NativeCoreCheckpoint) inspectCopyPihole(ctx context.Context) error {
	raw, err := p.capture(ctx, "incus", "file", "pull", "youeye-pihole/etc/pihole/pihole.toml", "-")
	if err != nil || len(raw) > 1<<20 {
		return fmt.Errorf("Pi-hole copy configuration unavailable")
	}
	if err = validateCopyPiholeConfiguration(raw); err != nil {
		return err
	}
	raw, err = p.capture(ctx, "incus", "query", "/1.0/instances/youeye-pihole")
	var instance struct {
		ExpandedConfig map[string]string `json:"expanded_config"`
	}
	if err != nil || json.Unmarshal(raw, &instance) != nil || instance.ExpandedConfig == nil {
		return fmt.Errorf("Pi-hole copy environment unavailable")
	}
	for _, key := range []string{"environment.FTLCONF_webserver_api_password", "environment.WEBPASSWORD", "environment.FTLCONF_webserver_api_pwhash", "environment.FTLCONF_webserver_api_app_pwhash", "environment.FTLCONF_webserver_api_totp_secret"} {
		if instance.ExpandedConfig[key] != "" {
			return fmt.Errorf("Pi-hole password environment override requires a copy adapter")
		}
	}
	return nil
}

func validateCopyPiholeConfiguration(raw []byte) error {
	var config struct {
		Webserver struct {
			API struct {
				Hash    *string `toml:"pwhash"`
				AppHash *string `toml:"app_pwhash"`
				TOTP    *string `toml:"totp_secret"`
			} `toml:"api"`
		} `toml:"webserver"`
	}
	if toml.Unmarshal(raw, &config) != nil {
		return fmt.Errorf("unsupported Pi-hole copy configuration")
	}
	api := config.Webserver.API
	if api.Hash == nil || *api.Hash == "" || api.AppHash == nil || *api.AppHash != "" || api.TOTP == nil || *api.TOTP != "" {
		return fmt.Errorf("Pi-hole requires the native password layout without separate app or 2FA authority before copying")
	}
	return nil
}

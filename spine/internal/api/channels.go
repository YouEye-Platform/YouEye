package api

import (
	"fmt"
	"strings"

	"github.com/youeye-platform/YouEye/spine/internal/channels"
	"github.com/youeye-platform/YouEye/spine/internal/releases"
	"github.com/youeye-platform/YouEye/spine/internal/update"
	"github.com/youeye-platform/YouEye/spine/internal/version"
)

// channelsView is the release_channels payload returned by GET /api/config. It
// exposes both the raw per-component override map (what is persisted) and the
// effective (merged) channel for each core component so the Control Panel can
// render the editor without re-implementing the merge rules.
type channelsView struct {
	Effective map[string]channels.Channel  `json:"effective"`
	Override  map[string]*channels.Channel `json:"override"`
}

// buildChannelsView assembles the effective + raw override view for the config
// GET response.
func (s *Server) buildChannelsView(c *channels.Config) channelsView {
	view := channelsView{
		Effective: map[string]channels.Channel{},
		Override:  map[string]*channels.Channel{},
	}

	components := []string{channels.ComponentDefault, channels.ComponentSpine, channels.ComponentControl, channels.ComponentUI}
	for _, comp := range components {
		view.Effective[comp] = c.Effective(comp, s.cfg)
	}
	// Effective view for each configured app.
	for _, comp := range c.ConfiguredComponents() {
		if _, exists := view.Effective[comp]; !exists {
			view.Effective[comp] = c.Effective(comp, s.cfg)
		}
	}

	// Raw override map: default always present; core overrides only when set.
	def := c.Default
	view.Override[channels.ComponentDefault] = &def
	if !c.Spine.IsZero() {
		v := c.Spine
		view.Override[channels.ComponentSpine] = &v
	}
	if !c.Control.IsZero() {
		v := c.Control
		view.Override[channels.ComponentControl] = &v
	}
	if !c.UI.IsZero() {
		v := c.UI
		view.Override[channels.ComponentUI] = &v
	}
	for id, ch := range c.Apps {
		v := ch
		view.Override[channels.AppPrefix+id] = &v
	}
	return view
}

// applyChannelsPatch applies a {"<component>": {…} | null} patch to the channels
// config, validating each entry. A null value clears the override (resets to
// default for core components / removes app overrides). Returns the number of
// components changed.
func applyChannelsPatch(c *channels.Config, patch map[string]interface{}) error {
	for comp, raw := range patch {
		normalized, err := normalizeAPIComponent(comp)
		if err != nil {
			return err
		}

		if raw == nil {
			if err := c.ResetChannel(normalized); err != nil {
				return err
			}
			continue
		}

		obj, ok := raw.(map[string]interface{})
		if !ok {
			return fmt.Errorf("channel %q must be an object or null", comp)
		}
		ch, err := channelFromMap(obj)
		if err != nil {
			return fmt.Errorf("channel %q: %w", comp, err)
		}
		if err := c.SetChannel(normalized, ch); err != nil {
			return err
		}
	}
	return nil
}

// channelFromMap builds a Channel from a decoded JSON object, honoring the
// nil-vs-empty fallback distinction (absent key = inherit; explicit [] = disable).
func channelFromMap(obj map[string]interface{}) (channels.Channel, error) {
	var ch channels.Channel
	if v, ok := obj["source"]; ok {
		s, ok := v.(string)
		if !ok {
			return ch, fmt.Errorf("source must be a string")
		}
		ch.Source = s
	}
	if v, ok := obj["branch"]; ok {
		s, ok := v.(string)
		if !ok {
			return ch, fmt.Errorf("branch must be a string")
		}
		b, err := channels.NormalizeBranch(s)
		if err != nil {
			return ch, err
		}
		ch.Branch = b
	}
	if v, ok := obj["tag"]; ok {
		s, ok := v.(string)
		if !ok {
			return ch, fmt.Errorf("tag must be a string")
		}
		ch.Tag = strings.TrimSpace(s)
	}
	if v, ok := obj["artifact_sha256"]; ok {
		s, ok := v.(string)
		if !ok {
			return ch, fmt.Errorf("artifact_sha256 must be a string")
		}
		ch.ArtifactSHA256 = strings.ToLower(strings.TrimSpace(s))
	}
	if v, ok := obj["fallback"]; ok {
		if v == nil {
			ch.Fallback = nil
		} else {
			arr, ok := v.([]interface{})
			if !ok {
				return ch, fmt.Errorf("fallback must be an array or null")
			}
			fb := []string{}
			for _, item := range arr {
				s, ok := item.(string)
				if !ok {
					return ch, fmt.Errorf("fallback entries must be strings")
				}
				b, err := channels.NormalizeBranch(s)
				if err != nil {
					return ch, err
				}
				fb = append(fb, b)
			}
			ch.Fallback = fb
		}
	}
	return ch, nil
}

func normalizeAPIComponent(component string) (string, error) {
	switch component {
	case channels.ComponentDefault, channels.ComponentSpine, channels.ComponentControl, channels.ComponentUI:
		return component, nil
	}
	if len(component) > len(channels.AppPrefix) && component[:len(channels.AppPrefix)] == channels.AppPrefix {
		return component, nil
	}
	return "", fmt.Errorf("unknown component %q", component)
}

// componentUpdateInfo is the per-component update entry surfaced by
// GET /api/updates/check. Legacy fields are retained for old Control Panels,
// but are made identical to the channel-authoritative candidate.
type componentUpdateInfo struct {
	channelDetail   channelDetail
	installed       versionRef
	candidate       versionRef
	updateAvailable bool
	switchPending   bool
	currentDisplay  string
	latestDisplay   string
}

type channelDetail struct {
	Source         string   `json:"source"`
	Branch         string   `json:"branch"`
	Tag            string   `json:"tag,omitempty"`
	ArtifactSHA256 string   `json:"artifact_sha256,omitempty"`
	Fallback       []string `json:"fallback"`
}

type versionRef struct {
	Version string `json:"version"`
	Branch  string `json:"branch"`
	Tag     string `json:"tag"`
}

// resolveComponentUpdate computes the channel-aware update info for a core
// component given its current installed version.
func (s *Server) resolveComponentUpdate(component, repo, tagPrefix, currentVersion string) componentUpdateInfo {
	chCfg, err := channels.Load()
	if err != nil {
		return componentUpdateInfo{currentDisplay: version.FormatVersion(currentVersion)}
	}
	eff := chCfg.Effective(component, s.cfg)

	info := componentUpdateInfo{
		channelDetail: channelDetail{
			Source:         eff.Source,
			Branch:         eff.Branch,
			Tag:            eff.Tag,
			ArtifactSHA256: eff.ArtifactSHA256,
			Fallback:       eff.Fallback,
		},
		currentDisplay: version.FormatVersion(currentVersion),
	}

	// Installed provenance (branch/tag) where recorded.
	if prov, ok := update.GetProvenance(component); ok {
		info.installed = versionRef{Version: prov.Version, Branch: prov.Branch, Tag: prov.Tag}
	} else {
		info.installed = versionRef{Version: currentVersion}
	}

	cand, err := releases.ResolveComponent(s.cfg, component, repo, tagPrefix)
	if err != nil {
		return info
	}
	info.candidate = versionRef{Version: cand.Version, Branch: cand.Branch, Tag: cand.Tag}
	info.latestDisplay = version.FormatVersion(cand.Version)

	installedBranch := info.installed.Branch
	sameBranch := installedBranch == "" || installedBranch == cand.Branch
	if sameBranch {
		info.updateAvailable = version.IsNewer(cand.Version, currentVersion)
	} else {
		// Channel switched: an install is pending unless the candidate is newer
		// on the new branch (then it surfaces as a normal update instead).
		if version.IsNewer(cand.Version, currentVersion) {
			info.updateAvailable = true
		} else {
			info.switchPending = true
		}
	}
	return info
}

// merge writes one authoritative answer through both the current and legacy
// field names. Repository-newer-but-unpromoted releases must never leak through
// latest/available while execution follows candidate/update_available.
func (info componentUpdateInfo) merge(entry map[string]interface{}) {
	entry["latest"] = info.candidate.Version
	entry["available"] = info.updateAvailable
	entry["channel"] = info.channelDetail
	entry["installed"] = info.installed
	entry["candidate"] = info.candidate
	entry["update_available"] = info.updateAvailable
	entry["switch_pending"] = info.switchPending
	entry["current_display"] = info.currentDisplay
	entry["latest_display"] = info.latestDisplay
}

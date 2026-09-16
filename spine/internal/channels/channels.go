// Package channels manages per-component release channels stored in youeye.yaml.
//
// Each component (Spine, Control Panel, UI, and native apps) can independently
// select which repo + branch it installs from, with a configurable fallback
// branch chain. Spine is the sole writer of this config; the Control Panel
// reads and edits it through Spine's PATCH /api/config.
//
// Config shape (youeye.yaml):
//
//	release_channels:
//	  default: { source: "<repo url>", branch: main, fallback: [main] }
//	  spine:   { branch: f-x, fallback: [] }
//	  control: {}
//	  ui:      {}
//	  apps:
//	    <appId>: { source: "...", branch: "..." }
//
// YAML/JSON semantics for fallback: an absent key (nil) means "inherit from
// default"; an explicit empty list means "fallback disabled". The Channel type
// preserves this distinction via a non-nil-but-empty vs nil slice.
package channels

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/youeye-platform/YouEye/spine/internal/config"
	"gopkg.in/yaml.v3"
)

// ConfigPath is the runtime youeye.yaml location. Overridable in tests.
var ConfigPath = "/var/lib/youeye/config/youeye.yaml"

var mu sync.Mutex

// Component identifiers.
const (
	ComponentDefault = "default"
	ComponentSpine   = "spine"
	ComponentControl = "control"
	ComponentUI      = "ui"
)

// AppPrefix is the component-id prefix for native apps: "app:<id>".
const AppPrefix = "app:"

// Channel is a per-component release channel override.
//
// Fallback distinguishes three states:
//   - nil          → inherit the effective fallback from the default channel
//   - non-nil empty → fallback disabled (hold on the selected branch)
//   - populated     → ordered fallback branch chain
//
// A plain slice with `omitempty` cannot preserve the "disabled" state on
// marshal (yaml/json omit an empty non-nil slice identically to nil), so
// Channel carries custom marshalers that emit `fallback` whenever it is
// non-nil and omit it only when nil.
type Channel struct {
	Source         string   `yaml:"source,omitempty" json:"source,omitempty"`
	Branch         string   `yaml:"branch,omitempty" json:"branch,omitempty"`
	Tag            string   `yaml:"tag,omitempty" json:"tag,omitempty"`
	ArtifactSHA256 string   `yaml:"artifact_sha256,omitempty" json:"artifact_sha256,omitempty"`
	Fallback       []string `yaml:"-" json:"-"`
}

// channelWire is the on-the-wire representation. Fallback is a pointer so that
// nil (inherit) is omitted while a non-nil (including empty) chain is emitted.
type channelWire struct {
	Source         string    `yaml:"source,omitempty" json:"source,omitempty"`
	Branch         string    `yaml:"branch,omitempty" json:"branch,omitempty"`
	Tag            string    `yaml:"tag,omitempty" json:"tag,omitempty"`
	ArtifactSHA256 string    `yaml:"artifact_sha256,omitempty" json:"artifact_sha256,omitempty"`
	Fallback       *[]string `yaml:"fallback,omitempty" json:"fallback,omitempty"`
}

func (ch Channel) wire() channelWire {
	w := channelWire{
		Source: ch.Source, Branch: ch.Branch, Tag: ch.Tag,
		ArtifactSHA256: ch.ArtifactSHA256,
	}
	if ch.Fallback != nil {
		fb := ch.Fallback
		w.Fallback = &fb
	}
	return w
}

func (ch *Channel) fromWire(w channelWire) {
	ch.Source = w.Source
	ch.Branch = w.Branch
	ch.Tag = w.Tag
	ch.ArtifactSHA256 = w.ArtifactSHA256
	if w.Fallback != nil {
		ch.Fallback = *w.Fallback
		if ch.Fallback == nil {
			// Normalize a decoded-but-nil pointer target to a non-nil empty
			// slice so "disabled" survives a round-trip.
			ch.Fallback = []string{}
		}
	} else {
		ch.Fallback = nil
	}
}

// MarshalYAML implements yaml.Marshaler.
func (ch Channel) MarshalYAML() (interface{}, error) { return ch.wire(), nil }

// UnmarshalYAML implements yaml.Unmarshaler.
func (ch *Channel) UnmarshalYAML(value *yaml.Node) error {
	var w channelWire
	if err := value.Decode(&w); err != nil {
		return err
	}
	ch.fromWire(w)
	return nil
}

// MarshalJSON implements json.Marshaler.
func (ch Channel) MarshalJSON() ([]byte, error) { return json.Marshal(ch.wire()) }

// UnmarshalJSON implements json.Unmarshaler.
func (ch *Channel) UnmarshalJSON(data []byte) error {
	var w channelWire
	if err := json.Unmarshal(data, &w); err != nil {
		return err
	}
	ch.fromWire(w)
	return nil
}

// Config is the parsed release_channels block.
type Config struct {
	Default Channel            `yaml:"default,omitempty" json:"default,omitempty"`
	Spine   Channel            `yaml:"spine,omitempty" json:"spine,omitempty"`
	Control Channel            `yaml:"control,omitempty" json:"control,omitempty"`
	UI      Channel            `yaml:"ui,omitempty" json:"ui,omitempty"`
	Apps    map[string]Channel `yaml:"apps,omitempty" json:"apps,omitempty"`

	// present reports whether release_channels existed in the file. When false,
	// legacy release_branch migration seeds default.branch (persisted on Save).
	present bool
	// legacyBranch is the value of the legacy release_branch key, retained so
	// migration and the release_branch mirror stay consistent.
	legacyBranch string
}

// Load reads the release_channels block from youeye.yaml. If the block is
// absent but a legacy release_branch is set, default.branch is seeded from it
// in memory (persisted on the first Save). A missing file yields an empty
// config (all effective defaults apply).
func Load() (*Config, error) {
	mu.Lock()
	defer mu.Unlock()
	return loadLocked()
}

func loadLocked() (*Config, error) {
	c := &Config{}
	data, err := os.ReadFile(ConfigPath)
	if err != nil {
		if os.IsNotExist(err) {
			return c, nil
		}
		return nil, fmt.Errorf("read config: %w", err)
	}

	var doc struct {
		ReleaseBranch   string  `yaml:"release_branch"`
		ReleaseChannels *Config `yaml:"release_channels"`
	}
	if err := yaml.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}

	c.legacyBranch = doc.ReleaseBranch
	if doc.ReleaseChannels != nil {
		*c = *doc.ReleaseChannels
		c.present = true
		c.legacyBranch = doc.ReleaseBranch
		return c, nil
	}

	// Migration: no release_channels — seed default.branch from release_branch.
	if doc.ReleaseBranch != "" && doc.ReleaseBranch != "main" {
		c.Default.Branch = doc.ReleaseBranch
	}
	return c, nil
}

// override returns the raw override channel for a component id and whether it
// was explicitly configured. For apps, id is "app:<appId>".
func (c *Config) override(component string) (Channel, bool) {
	switch component {
	case ComponentDefault:
		return c.Default, true
	case ComponentSpine:
		return c.Spine, true
	case ComponentControl:
		return c.Control, true
	case ComponentUI:
		return c.UI, true
	}
	if appID, ok := strings.CutPrefix(component, AppPrefix); ok {
		if c.Apps != nil {
			ch, present := c.Apps[appID]
			return ch, present
		}
	}
	return Channel{}, false
}

// Effective resolves the channel for a component by merging its override onto
// the default channel, then applying ultimate defaults (source = cfg repo URL,
// branch "main", fallback ["main"]). Per-field merge: an override field wins
// only when set. Fallback nil means inherit; non-nil (even empty) wins.
func (c *Config) Effective(component string, cfg *config.Config) Channel {
	// Base = default channel merged onto ultimate defaults.
	base := Channel{
		Source:   defaultSource(cfg),
		Branch:   "main",
		Fallback: []string{"main"},
	}
	base = mergeChannel(base, c.Default)

	if component == ComponentDefault {
		return base
	}

	ov, _ := c.override(component)
	return mergeChannel(base, ov)
}

// mergeChannel overlays override onto base per field.
func mergeChannel(base, override Channel) Channel {
	out := base
	if override.Source != "" {
		out.Source = override.Source
	}
	if override.Branch != "" {
		out.Branch = override.Branch
	}
	if override.Tag != "" {
		out.Tag = override.Tag
	}
	if override.ArtifactSHA256 != "" {
		out.ArtifactSHA256 = override.ArtifactSHA256
	}
	// Fallback: nil = inherit; non-nil (including empty) = replace.
	if override.Fallback != nil {
		out.Fallback = override.Fallback
	}
	return out
}

func defaultSource(cfg *config.Config) string {
	if cfg == nil {
		return ""
	}
	if cfg.Releases.RepoURL != "" {
		return cfg.Releases.RepoURL
	}
	return cfg.CoreReleaseRepo().RepoURL
}

// DefaultBranch returns the configured default channel branch (or "main").
// Used to mirror into legacy release_branch and for the deprecated `branch`
// command.
func (c *Config) DefaultBranch() string {
	if c.Default.Branch != "" {
		return c.Default.Branch
	}
	return "main"
}

// SetChannel replaces a component's override with ch. For apps use
// component "app:<id>". Passing the default component sets the default channel.
func (c *Config) SetChannel(component string, ch Channel) error {
	if err := ValidateChannel(ch); err != nil {
		return err
	}
	switch component {
	case ComponentDefault:
		c.Default = ch
	case ComponentSpine:
		c.Spine = ch
	case ComponentControl:
		c.Control = ch
	case ComponentUI:
		c.UI = ch
	default:
		appID, ok := strings.CutPrefix(component, AppPrefix)
		if !ok || appID == "" {
			return fmt.Errorf("unknown component %q", component)
		}
		if c.Apps == nil {
			c.Apps = map[string]Channel{}
		}
		c.Apps[appID] = ch
	}
	c.present = true
	return nil
}

// ResetChannel drops a component's override. For "default" it resets the
// default channel to main + [main].
func (c *Config) ResetChannel(component string) error {
	switch component {
	case ComponentDefault:
		c.Default = Channel{Branch: "main", Fallback: []string{"main"}}
	case ComponentSpine:
		c.Spine = Channel{}
	case ComponentControl:
		c.Control = Channel{}
	case ComponentUI:
		c.UI = Channel{}
	default:
		appID, ok := strings.CutPrefix(component, AppPrefix)
		if !ok || appID == "" {
			return fmt.Errorf("unknown component %q", component)
		}
		delete(c.Apps, appID)
	}
	c.present = true
	return nil
}

// ResetAll clears every override and returns the default channel to main.
func (c *Config) ResetAll() {
	c.Default = Channel{Branch: "main", Fallback: []string{"main"}}
	c.Spine = Channel{}
	c.Control = Channel{}
	c.UI = Channel{}
	c.Apps = nil
	c.present = true
}

// ConfiguredComponents returns the list of component ids that carry an explicit
// override (excludes "default"), sorted app ids appended as "app:<id>".
func (c *Config) ConfiguredComponents() []string {
	var out []string
	if !c.Spine.IsZero() {
		out = append(out, ComponentSpine)
	}
	if !c.Control.IsZero() {
		out = append(out, ComponentControl)
	}
	if !c.UI.IsZero() {
		out = append(out, ComponentUI)
	}
	for id := range c.Apps {
		out = append(out, AppPrefix+id)
	}
	return out
}

// IsZero reports whether the channel carries no override (all fields unset).
func (ch Channel) IsZero() bool {
	return ch.Source == "" && ch.Branch == "" && ch.Tag == "" && ch.ArtifactSHA256 == "" && ch.Fallback == nil
}

// Save writes the release_channels block back into youeye.yaml, preserving all
// unrelated keys via a read-modify-write on the full yaml document. When the
// default branch changes it is mirrored into the legacy release_branch key so
// an older Control Panel keeps working during the update window.
func (c *Config) Save() error {
	mu.Lock()
	defer mu.Unlock()

	root, err := readDocument()
	if err != nil {
		return err
	}

	// Encode the channels config into a mapping node.
	var chNode yaml.Node
	if err := chNode.Encode(c); err != nil {
		return fmt.Errorf("encode release_channels: %w", err)
	}

	setMapKey(root, "release_channels", &chNode)

	// Mirror default branch into legacy release_branch.
	branch := c.DefaultBranch()
	var branchNode yaml.Node
	if branch == "main" {
		branchNode.SetString("")
	} else {
		branchNode.SetString(branch)
	}
	setMapKey(root, "release_branch", &branchNode)

	return writeDocument(root)
}

// readDocument reads youeye.yaml as a mapping node, creating an empty mapping
// when the file is absent.
func readDocument() (*yaml.Node, error) {
	data, err := os.ReadFile(ConfigPath)
	if err != nil {
		if os.IsNotExist(err) {
			return &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}, nil
		}
		return nil, fmt.Errorf("read config: %w", err)
	}

	var doc yaml.Node
	if err := yaml.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	// Unwrap the document node to its content mapping.
	if doc.Kind == yaml.DocumentNode {
		if len(doc.Content) == 0 {
			return &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}, nil
		}
		return doc.Content[0], nil
	}
	if doc.Kind == 0 {
		return &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}, nil
	}
	return &doc, nil
}

// setMapKey inserts or replaces key in a mapping node with the given value node.
func setMapKey(mapping *yaml.Node, key string, value *yaml.Node) {
	for i := 0; i+1 < len(mapping.Content); i += 2 {
		if mapping.Content[i].Value == key {
			mapping.Content[i+1] = value
			return
		}
	}
	keyNode := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}
	mapping.Content = append(mapping.Content, keyNode, value)
}

// writeDocument atomically writes the mapping node back to youeye.yaml
// (tmp file + rename), preserving the managed-by header.
func writeDocument(root *yaml.Node) error {
	if err := os.MkdirAll(filepath.Dir(ConfigPath), 0755); err != nil {
		return fmt.Errorf("create config dir: %w", err)
	}

	body, err := yaml.Marshal(root)
	if err != nil {
		return fmt.Errorf("marshal config: %w", err)
	}

	header := "# YouEye Configuration\n# Managed by Spine - do not edit manually unless you know what you're doing\n\n"
	tmp := ConfigPath + ".tmp"
	if err := os.WriteFile(tmp, []byte(header+string(body)), 0644); err != nil {
		return fmt.Errorf("write config: %w", err)
	}
	return os.Rename(tmp, ConfigPath)
}

// ValidateChannel validates a channel's branch and source.
func ValidateChannel(ch Channel) error {
	if ch.Branch != "" {
		if _, err := NormalizeBranch(ch.Branch); err != nil {
			return err
		}
	}
	for _, fb := range ch.Fallback {
		if _, err := NormalizeBranch(fb); err != nil {
			return fmt.Errorf("invalid fallback branch: %w", err)
		}
	}
	if ch.Source != "" {
		if err := validateSource(ch.Source); err != nil {
			return err
		}
	}
	if ch.Tag != "" {
		if len(ch.Tag) > 255 {
			return fmt.Errorf("release tag is too long")
		}
		for _, c := range ch.Tag {
			if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
				(c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.') {
				return fmt.Errorf("invalid release tag %q: only [A-Za-z0-9._-] are allowed", ch.Tag)
			}
		}
	}
	if ch.ArtifactSHA256 != "" {
		if ch.Tag == "" {
			return fmt.Errorf("artifact_sha256 requires an exact release tag")
		}
		if len(ch.ArtifactSHA256) != 64 {
			return fmt.Errorf("artifact_sha256 must be a 64-character hexadecimal digest")
		}
		for _, c := range ch.ArtifactSHA256 {
			if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
				return fmt.Errorf("artifact_sha256 must be a 64-character hexadecimal digest")
			}
		}
	}
	return nil
}

// NormalizeBranch validates a branch name against [a-z0-9_-] and lowercases it.
// Empty is rejected — callers wanting "unset" pass an empty Channel field.
func NormalizeBranch(branch string) (string, error) {
	if branch == "" {
		return "", fmt.Errorf("branch name is empty")
	}
	lower := strings.ToLower(branch)
	for _, c := range lower {
		if !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_') {
			return "", fmt.Errorf("invalid branch name %q: only [a-z0-9_-] are allowed", branch)
		}
	}
	return lower, nil
}

func validateSource(source string) error {
	u, err := url.Parse(source)
	if err != nil {
		return fmt.Errorf("invalid source URL %q: %w", source, err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("source URL %q must be http(s)", source)
	}
	if u.Host == "" {
		return fmt.Errorf("source URL %q is missing a host", source)
	}
	return nil
}

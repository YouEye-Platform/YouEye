package releasecache

// A core release is a flat, immutable assembly. BuildVersion describes the
// original bytes; Version identifies the complete installed selection. A
// service-only release therefore never relabels its unchanged host image.
import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

const CoreReleaseSchema = "youeye.core-release.v1"
const CoreReleaseReader = 1

// CoreReleaseAuthority is the only accepted trust model: the exact document
// digest (recorded in protected State by the installer, or fetched over HTTPS
// for an update) binds every member artifact by sha256 and size.
const CoreReleaseAuthority = "digest"

type CoreRelease struct {
	Schema                 string            `json:"schema"`
	Version                string            `json:"version"`
	Tag                    string            `json:"tag"`
	Source                 string            `json:"source"`
	Branch                 string            `json:"branch"`
	SourceCommit           string            `json:"source_commit"`
	Channel                string            `json:"channel"`
	Sequence               uint64            `json:"sequence"`
	PreviousManifestSHA256 string            `json:"previous_manifest_sha256,omitempty"`
	MinimumReader          int               `json:"minimum_reader"`
	Authority              string            `json:"authority"`
	Compatibility          CoreCompatibility `json:"compatibility"`
	Members                []CoreMember      `json:"members"`
}

type CoreCompatibility struct {
	StateMin       int      `json:"state_min"`
	StateMax       int      `json:"state_max"`
	DataMin        int      `json:"data_min"`
	DataMax        int      `json:"data_max"`
	MinimumRelease string   `json:"minimum_release"`
	Capabilities   []string `json:"capabilities"`
}

type CoreBlob struct {
	Name      string `json:"name"` // Exact release asset name.
	URL       string `json:"url"`
	SHA256    string `json:"sha256"`
	SizeBytes int64  `json:"size_bytes"`
}

type CoreMember struct {
	Role         string    `json:"role"`
	BuildVersion string    `json:"build_version"`
	Source       string    `json:"source"`
	Branch       string    `json:"branch"`
	SourceCommit string    `json:"source_commit"`
	Tag          string    `json:"tag"`
	InputSHA256  string    `json:"input_sha256"`
	Artifact     CoreBlob  `json:"artifact"`
	BuildInputs  *CoreBlob `json:"build_inputs,omitempty"`
	DependsOn    []string  `json:"depends_on,omitempty"`
}

var installationCommit = regexp.MustCompile(`^[0-9a-f]{40}$`)
var installationHash = regexp.MustCompile(`^[0-9a-f]{64}$`)

var coreVersionPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\.([1-9][0-9]*))?$`)

func ValidCoreVersion(value string) bool {
	m := coreVersionPattern.FindStringSubmatch(value)
	if m == nil || len(m[4]) > 63 {
		return false
	}
	for _, part := range []string{m[1], m[2], m[3], m[5]} {
		if part == "" {
			continue
		}
		n, err := strconv.ParseUint(part, 10, 64)
		if err != nil || n > 9007199254740991 {
			return false
		}
	}
	return true
}

// ValidCoreBranch preserves the exact ref spelling; a display token is never
// used to reconstruct a branch or its authority scope.
func ValidCoreBranch(value string) bool {
	if value == "" || len(value) > 128 || strings.ContainsAny(value, " ~^:?*[\\%\x00\t\r\n") || strings.Contains(value, "..") || strings.Contains(value, "@{") {
		return false
	}
	for _, char := range value {
		if char < 0x20 || char == 0x7f {
			return false
		}
	}
	for _, part := range strings.Split(value, "/") {
		if part == "" || strings.HasPrefix(part, ".") || strings.HasSuffix(part, ".") || strings.HasSuffix(part, ".lock") {
			return false
		}
	}
	return true
}

func coreSource(value string) (*url.URL, error) {
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.RawPath != "" || strings.ContainsAny(u.Path, "\\\x00") {
		return nil, fmt.Errorf("invalid core source")
	}
	parts := strings.Split(strings.TrimPrefix(u.Path, "/"), "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" || parts[0] == "." || parts[0] == ".." || parts[1] == "." || parts[1] == ".." {
		return nil, fmt.Errorf("core source must name an exact repository")
	}
	return u, nil
}

func (blob CoreBlob) validate(source, tag string) error {
	if !coreAssetName.MatchString(blob.Name) || blob.Name == "." || blob.Name == ".." {
		return fmt.Errorf("core blob requires its exact asset name")
	}
	if !installationHash.MatchString(blob.SHA256) || blob.SizeBytes <= 0 {
		return fmt.Errorf("core blob requires exact digest and size")
	}
	u, err := url.Parse(blob.URL)
	if err != nil || u.Scheme != "https" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || strings.ContainsAny(u.Path, "\\\x00") {
		return fmt.Errorf("invalid core blob URL")
	}
	// Forgejo and GitHub both expose immutable assets at this path. The tag
	// itself may contain a slash; PathEscape prevents ambiguous path segments.
	prefix := source + "/releases/download/" + url.PathEscape(tag) + "/"
	if !strings.HasPrefix(blob.URL, prefix) {
		return fmt.Errorf("blob is outside its exact source/tag")
	}
	name := strings.TrimPrefix(blob.URL, prefix)
	decoded, err := url.PathUnescape(name)
	if err != nil || name == "" || decoded == "." || decoded == ".." || strings.ContainsAny(decoded, "/\\\x00") {
		return fmt.Errorf("unsafe core blob asset name")
	}
	return nil
}

var coreAssetName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$`)

// CoreMemberChannel retains the original public payload's channel even when a
// newer release selects it from the other public branch. A selected release may
// retain any original member, including a development build.
func CoreMemberChannel(member CoreMember, assemblyChannel string) (string, error) {
	if member.Source != "https://github.com/YouEye-Platform/YouEye" {
		return assemblyChannel, nil
	}
	version := coreVersionPattern.FindStringSubmatch(member.BuildVersion)
	if version == nil {
		return "", fmt.Errorf("invalid original core member version")
	}
	if member.Branch == "main" && version[4] == "" {
		return "stable", nil
	}
	if member.Branch == "beta" && version[4] == "beta" {
		return "beta", nil
	}
	return "", fmt.Errorf("core member has no compatible public source branch")
}

func (r CoreRelease) Validate() error {
	if r.Schema != CoreReleaseSchema || !ValidCoreVersion(r.Version) || r.Tag != "youeye-v"+r.Version || r.MinimumReader != CoreReleaseReader {
		return fmt.Errorf("unsupported core release identity or reader")
	}
	if _, err := coreSource(r.Source); err != nil {
		return err
	}
	if r.Authority != CoreReleaseAuthority {
		return fmt.Errorf("unsupported core release authority")
	}
	if !ValidCoreBranch(r.Branch) || !installationCommit.MatchString(r.SourceCommit) || r.Sequence == 0 || r.Sequence > 9007199254740991 {
		return fmt.Errorf("core release provenance is incomplete")
	}
	if r.PreviousManifestSHA256 != "" && !installationHash.MatchString(r.PreviousManifestSHA256) {
		return fmt.Errorf("invalid core release lineage")
	}
	m := coreVersionPattern.FindStringSubmatch(r.Version)
	switch r.Channel {
	case "stable":
		if m[4] != "" {
			return fmt.Errorf("Stable release cannot have a suffix")
		}
	case "beta", "alpha", "dev":
		if m[4] != r.Channel {
			return fmt.Errorf("release suffix does not match selected channel")
		}
	case "feature":
		if m[4] == "" || m[4] == "beta" || m[4] == "alpha" || m[4] == "dev" {
			return fmt.Errorf("feature release needs its exact branch token")
		}
	default:
		return fmt.Errorf("unsupported core release channel")
	}
	c := r.Compatibility
	if c.StateMin < 1 || c.StateMax < c.StateMin || c.DataMin < 1 || c.DataMax < c.DataMin || !ValidCoreVersion(c.MinimumRelease) {
		return fmt.Errorf("invalid core compatibility range")
	}
	capabilities := map[string]bool{}
	for _, v := range c.Capabilities {
		if v == "" || capabilities[v] {
			return fmt.Errorf("invalid capability list")
		}
		capabilities[v] = true
	}
	if !capabilities["core-release-v1"] {
		return fmt.Errorf("core release reader capability missing")
	}
	required := map[string]bool{"installer": false, "media": false, "appliance": false, "system-update": false, "spine": false, "cp": false, "ui": false, "system-root": false, "system-a-uki": false, "system-b-uki": false, "system-updater": false, "internal-recovery": false, "recovery-uki": false, "update-bootstrap": false}
	for _, member := range r.Members {
		present, known := required[member.Role]
		if !known || present {
			return fmt.Errorf("unknown or duplicate core role %q", member.Role)
		}
		required[member.Role] = true
		if !ValidCoreVersion(member.BuildVersion) || !installationCommit.MatchString(member.SourceCommit) || !installationHash.MatchString(member.InputSHA256) || !ValidCoreBranch(member.Branch) || member.Tag == "" {
			return fmt.Errorf("incomplete %s provenance", member.Role)
		}
		if _, err := coreSource(member.Source); err != nil {
			return err
		}
		if r.Channel == "stable" || r.Channel == "beta" {
			if _, err := CoreMemberChannel(member, r.Channel); err != nil {
				return err
			}
		}
		if err := member.Artifact.validate(member.Source, member.Tag); err != nil {
			return fmt.Errorf("%s: %w", member.Role, err)
		}
		if member.Role == "appliance" {
			if member.BuildInputs == nil {
				return fmt.Errorf("appliance build inputs are required")
			}
			if err := member.BuildInputs.validate(member.Source, member.Tag); err != nil {
				return err
			}
		} else if member.BuildInputs != nil {
			return fmt.Errorf("unexpected build inputs")
		}
	}
	for role, present := range required {
		if !present {
			return fmt.Errorf("missing core role %s", role)
		}
	}
	// A deterministic topological graph is part of the release contract. All
	// dependencies must be present, unique and earlier in the flat selection.
	seen := map[string]bool{}
	for _, member := range r.Members {
		deps := map[string]bool{}
		for _, dependency := range member.DependsOn {
			if !seen[dependency] || deps[dependency] {
				return fmt.Errorf("invalid or cyclic dependency for %s", member.Role)
			}
			deps[dependency] = true
		}
		if member.Role == "cp" && !deps["spine"] {
			return fmt.Errorf("CP requires selected Spine")
		}
		if member.Role == "ui" && !deps["cp"] {
			return fmt.Errorf("UI requires selected CP")
		}
		seen[member.Role] = true
	}
	return nil
}

func ParseCoreRelease(raw []byte) (CoreRelease, string, error) {
	var release CoreRelease
	if len(raw) > 1<<20 {
		return release, "", fmt.Errorf("core release exceeds maximum size")
	}
	if err := uniqueCoreJSON(raw); err != nil {
		return release, "", err
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(&release); err != nil {
		return release, "", err
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		return release, "", fmt.Errorf("trailing core release JSON")
	}
	// An empty depends_on list and an absent one mean the same thing. Keep one
	// in-memory form (nil) so a release survives JSON round trips through
	// receipts and journals (which omit empty lists) and still compares equal.
	for i := range release.Members {
		if len(release.Members[i].DependsOn) == 0 {
			release.Members[i].DependsOn = nil
		}
	}
	if err := release.Validate(); err != nil {
		return release, "", err
	}
	digest := sha256.Sum256(raw)
	return release, hex.EncodeToString(digest[:]), nil
}

// Reject duplicate object keys (including nested objects) before decoding into
// structs. Different runtimes must never accept different interpretations of
// the same digest-bound document. Token traversal also bounds nesting.
func uniqueCoreJSON(raw []byte) error {
	d := json.NewDecoder(bytes.NewReader(raw))
	var value func(int) error
	value = func(depth int) error {
		if depth > 32 {
			return fmt.Errorf("core JSON nesting exceeds limit")
		}
		t, err := d.Token()
		if err != nil {
			return err
		}
		if delimiter, ok := t.(json.Delim); ok {
			switch delimiter {
			case '{':
				seen := map[string]bool{}
				for d.More() {
					key, err := d.Token()
					if err != nil {
						return err
					}
					name, ok := key.(string)
					if !ok || seen[name] {
						return fmt.Errorf("duplicate core JSON key")
					}
					seen[name] = true
					if err := value(depth + 1); err != nil {
						return err
					}
				}
			case '[':
				for d.More() {
					if err := value(depth + 1); err != nil {
						return err
					}
				}
			default:
				return fmt.Errorf("invalid core JSON delimiter")
			}
			_, err = d.Token()
			return err
		}
		return nil
	}
	if err := value(0); err != nil {
		return err
	}
	if _, err := d.Token(); err != io.EOF {
		return fmt.Errorf("trailing core JSON")
	}
	return nil
}

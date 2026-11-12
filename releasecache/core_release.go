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
	Schema        string            `json:"schema"`
	Version       string            `json:"version"`
	Tag           string            `json:"tag"`
	SourceTree    string            `json:"source_tree"`
	Sequence      uint64            `json:"sequence"`
	MinimumReader int               `json:"minimum_reader"`
	Authority     string            `json:"authority"`
	Compatibility CoreCompatibility `json:"compatibility"`
	Members       []CoreMember      `json:"members"`
}

type CoreCompatibility struct {
	StateMin       int      `json:"state_min"`
	StateMax       int      `json:"state_max"`
	DataMin        int      `json:"data_min"`
	DataMax        int      `json:"data_max"`
	MinimumRelease string   `json:"minimum_release"`
	Capabilities   []string `json:"capabilities"`
}

// CoreBlob names one release asset. The document never says where it lives:
// a client resolves <repository>/releases/download/<tag>/<name>, where the
// repository and tag come from where it found the document, unless Release
// names another release of the same repository. The bytes are therefore the
// same on every host a release is promoted to.
type CoreBlob struct {
	Name      string `json:"name"`
	SHA256    string `json:"sha256"`
	SizeBytes int64  `json:"size_bytes"`
	Release   string `json:"release,omitempty"`
}

type CoreMember struct {
	Role         string    `json:"role"`
	BuildVersion string    `json:"build_version"`
	SourceTree   string    `json:"source_tree"`
	InputSHA256  string    `json:"input_sha256"`
	Artifact     CoreBlob  `json:"artifact"`
	BuildInputs  *CoreBlob `json:"build_inputs,omitempty"`
	DependsOn    []string  `json:"depends_on,omitempty"`
}

var gitTree = regexp.MustCompile(`^[0-9a-f]{40}$`)
var installationHash = regexp.MustCompile(`^[0-9a-f]{64}$`)

var coreVersionPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\.([1-9][0-9]*))?$`)

// ValidCoreVersion accepts X.Y.Z[-token.N]. Builds are X.Y.Z-rc.N; the suffix
// never names a channel.
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

// CompareVersions orders X.Y.Z[-token.N] numerically: X, Y, Z, then N. A
// version without a suffix sorts after every suffixed build of the same line.
// Invalid versions sort first.
func CompareVersions(a, b string) int {
	key := func(v string) []uint64 {
		m := coreVersionPattern.FindStringSubmatch(v)
		if m == nil {
			return nil
		}
		out := make([]uint64, 5)
		for i, part := range []string{m[1], m[2], m[3]} {
			out[i], _ = strconv.ParseUint(part, 10, 64)
		}
		if m[5] == "" {
			out[3] = 1
		} else {
			out[4], _ = strconv.ParseUint(m[5], 10, 64)
		}
		return out
	}
	ka, kb := key(a), key(b)
	switch {
	case ka == nil && kb == nil:
		return 0
	case ka == nil:
		return -1
	case kb == nil:
		return 1
	}
	for i := range ka {
		if ka[i] != kb[i] {
			if ka[i] < kb[i] {
				return -1
			}
			return 1
		}
	}
	return 0
}

// ValidGitTree accepts a 40-hex git tree id, the build identity.
func ValidGitTree(value string) bool { return gitTree.MatchString(value) }

var coreAssetName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$`)

func validReleaseTag(value string) bool {
	return len(value) <= 128 && coreAssetName.MatchString(value) && !strings.Contains(value, "..")
}

func (blob CoreBlob) validate() error {
	if !coreAssetName.MatchString(blob.Name) {
		return fmt.Errorf("core blob requires its exact asset name")
	}
	if !installationHash.MatchString(blob.SHA256) || blob.SizeBytes <= 0 {
		return fmt.Errorf("core blob requires exact digest and size")
	}
	if blob.Release != "" && !(strings.HasPrefix(blob.Release, "youeye-v") && ValidCoreVersion(strings.TrimPrefix(blob.Release, "youeye-v"))) {
		return fmt.Errorf("core blob may only reference another youeye-v release")
	}
	return nil
}

// AssetURL locates a blob of a release found at repository/tag.
func AssetURL(repository, tag string, blob CoreBlob) string {
	if blob.Release != "" {
		tag = blob.Release
	}
	return repository + "/releases/download/" + url.PathEscape(tag) + "/" + url.PathEscape(blob.Name)
}

// CoreRoles lists the 14 System roles in document order.
var CoreRoles = []string{"installer", "media", "appliance", "system-update", "system-root", "system-a-uki", "system-b-uki", "system-updater", "internal-recovery", "recovery-uki", "update-bootstrap", "spine", "cp", "ui"}

func (r CoreRelease) Validate() error {
	if r.Schema != CoreReleaseSchema || !ValidCoreVersion(r.Version) || r.Tag != "youeye-v"+r.Version || r.MinimumReader != CoreReleaseReader {
		return fmt.Errorf("unsupported core release identity or reader")
	}
	if r.Authority != CoreReleaseAuthority {
		return fmt.Errorf("unsupported core release authority")
	}
	if !ValidGitTree(r.SourceTree) || r.Sequence == 0 || r.Sequence > 9007199254740991 {
		return fmt.Errorf("core release provenance is incomplete")
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
	required := map[string]bool{}
	for _, role := range CoreRoles {
		required[role] = false
	}
	for _, member := range r.Members {
		present, known := required[member.Role]
		if !known || present {
			return fmt.Errorf("unknown or duplicate core role %q", member.Role)
		}
		required[member.Role] = true
		if !ValidCoreVersion(member.BuildVersion) || !ValidGitTree(member.SourceTree) || !installationHash.MatchString(member.InputSHA256) {
			return fmt.Errorf("incomplete %s provenance", member.Role)
		}
		if err := member.Artifact.validate(); err != nil {
			return fmt.Errorf("%s: %w", member.Role, err)
		}
		if member.Role == "appliance" {
			if member.BuildInputs == nil {
				return fmt.Errorf("appliance build inputs are required")
			}
			if err := member.BuildInputs.validate(); err != nil {
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

// Member returns the member with role.
func (r CoreRelease) Member(role string) (CoreMember, bool) {
	for _, member := range r.Members {
		if member.Role == role {
			return member, true
		}
	}
	return CoreMember{}, false
}

// Blobs lists every digest-bound blob of a member.
func (m CoreMember) Blobs() []CoreBlob {
	blobs := []CoreBlob{m.Artifact}
	if m.BuildInputs != nil {
		blobs = append(blobs, *m.BuildInputs)
	}
	return blobs
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

package systemupdate

import (
	"archive/tar"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

// CorePayloadIndex is derived from an authenticated CP/UI archive, then kept in
// protected host State. A version file alone cannot detect an installed overlay.
type CorePayloadIndex struct {
	Schema         string             `json:"schema"`
	ArtifactSHA256 string             `json:"artifact_sha256"`
	Entries        []CorePayloadEntry `json:"entries"`
}

type CorePayloadEntry struct {
	Path   string `json:"path"`
	Kind   string `json:"kind"`
	Mode   int64  `json:"mode"`
	Size   int64  `json:"size,omitempty"`
	SHA256 string `json:"sha256,omitempty"`
	Link   string `json:"link,omitempty"`
}

// corePayloadRuntimeRoots are written by the running service, never shipped:
// every check skips them and everything under them, and no archive or index
// may contain them. Next.js writes its response cache under route-cache.
var corePayloadRuntimeRoots = []string{".next/cache", ".next/server/route-cache"}

func mutableCorePayloadPath(name string) bool {
	if name == ".env" {
		return true
	}
	for _, root := range corePayloadRuntimeRoots {
		if name == root || strings.HasPrefix(name, root+"/") {
			return true
		}
	}
	return false
}

// CorePayloadMode says what a check of an installed tree may refuse. Which
// mode a caller uses is decided by who wrote the tree, never by convenience:
// a check that runs in the installed Spine must not refuse an update, a
// recovery or a boot because of the state of a tree this request did not write.
type CorePayloadMode int

const (
	// CorePayloadRecord is for a tree this request did not write: about to be
	// replaced, reused, restored or merely installed. Differences are counted
	// and reported, never refused. Only a tree that cannot be reached at all
	// (no container, no application directory, a cancelled context) is an error.
	CorePayloadRecord CorePayloadMode = iota
	// CorePayloadStrict is for a tree written in this request, a freshly
	// extracted stage and a fresh install: a recorded path that is missing or
	// changed is refused. Paths that were not shipped are counted, never refused.
	CorePayloadStrict
)

// CorePayloadFindings is what one complete walk of a tree found. Counts and
// reasons may be written to durable evidence; Paths never is.
type CorePayloadFindings struct {
	Unrecorded int `json:"unrecorded"`
	Changed    int `json:"changed"`
	Missing    int `json:"missing"`
	// UnrecordedCapped: the walk stopped descending into directories that were
	// not shipped, so Unrecorded is a lower bound.
	UnrecordedCapped bool `json:"unrecorded_capped,omitempty"`
	// Reasons counts the changed paths by kind (changed-bytes, changed-mode,
	// changed-link, invalid-type-or-link, changed-during-observation, unreadable).
	Reasons map[string]int `json:"reasons,omitempty"`
	// Paths is a bounded sample for an operator's terminal.
	Paths []CorePayloadFinding `json:"paths,omitempty"`
}

type CorePayloadFinding struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
}

const corePayloadSampleLimit = 20

// corePayloadUnrecordedLimit and corePayloadUnrecordedDepth bound the walk of
// files we did not ship, so a huge or bottomless foreign directory cannot hold
// an update, a recovery or a health gate (each level keeps a descriptor open).
var corePayloadUnrecordedLimit = 100000

const corePayloadUnrecordedDepth = 64

// Differs: a recorded path is missing or changed. Paths that were not shipped
// do not make a tree differ.
func (f CorePayloadFindings) Differs() bool { return f.Changed+f.Missing > 0 }

func (f *CorePayloadFindings) note(name, reason string) {
	switch reason {
	case "unrecorded-path":
		f.Unrecorded++
	case "missing-path":
		f.Missing++
	default:
		f.Changed++
		if f.Reasons == nil {
			f.Reasons = map[string]int{}
		}
		f.Reasons[reason]++
	}
	if len(f.Paths) < corePayloadSampleLimit {
		if len(name) > 256 {
			name = name[:256] + "…"
		}
		f.Paths = append(f.Paths, CorePayloadFinding{Path: name, Reason: reason})
	}
}

// Counts is the durable form: numbers and reasons, never a path.
func (f CorePayloadFindings) Counts() string {
	bound := ""
	if f.UnrecordedCapped {
		bound = "at least "
	}
	out := fmt.Sprintf("%s%d unrecorded, %d changed, %d missing", bound, f.Unrecorded, f.Changed, f.Missing)
	if len(f.Reasons) == 0 {
		return out
	}
	reasons := make([]string, 0, len(f.Reasons))
	for reason, count := range f.Reasons {
		reasons = append(reasons, fmt.Sprintf("%s %d", reason, count))
	}
	sort.Strings(reasons)
	return out + " (" + strings.Join(reasons, ", ") + ")"
}

// Summary is one of the three states a reader sees: "verified",
// "verified, 3 extra files" or "modified (1 changed, 0 missing)".
func (f CorePayloadFindings) Summary() string {
	extra := ""
	if f.Unrecorded > 0 {
		bound, plural := "", "s"
		if f.UnrecordedCapped {
			bound = "at least "
		}
		if f.Unrecorded == 1 {
			plural = ""
		}
		extra = fmt.Sprintf(", %s%d extra file%s", bound, f.Unrecorded, plural)
	}
	if f.Differs() {
		return fmt.Sprintf("modified (%d changed, %d missing)%s", f.Changed, f.Missing, extra)
	}
	return "verified" + extra
}

// CorePayloadDifferenceError is the strict refusal. Its text carries counts and
// reasons only, so it may reach durable evidence.
type CorePayloadDifferenceError struct{ Findings CorePayloadFindings }

func (e *CorePayloadDifferenceError) Error() string {
	return "installed payload differs from its recorded files: " + e.Findings.Counts()
}

func cleanPayloadPath(name string) (string, error) {
	if strings.ContainsAny(name, "\x00\r\n\\") || strings.HasPrefix(name, "/") {
		return "", fmt.Errorf("unsafe core payload path")
	}
	clean := path.Clean(name)
	if clean == ".." || strings.HasPrefix(clean, "../") || len(clean) > 4096 {
		return "", fmt.Errorf("unsafe core payload path")
	}
	return clean, nil
}

// IndexCorePayload validates an uncompressed standalone tar before extraction.
// The caller must also verify its member signature and exact artifact digest.
// Indexing does not grant authority to execute an archive.
func IndexCorePayload(archive string, expectedSHA256 string) (CorePayloadIndex, error) {
	index := CorePayloadIndex{Schema: "youeye.core-payload.v1", ArtifactSHA256: expectedSHA256}
	if !validSHA256(expectedSHA256) {
		return index, fmt.Errorf("exact payload digest required")
	}
	f, err := os.Open(archive)
	if err != nil {
		return index, err
	}
	defer f.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, f); err != nil {
		return index, err
	}
	if fmt.Sprintf("%x", hash.Sum(nil)) != expectedSHA256 {
		return index, fmt.Errorf("core payload archive changed")
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return index, err
	}
	reader := tar.NewReader(f)
	entries := map[string]CorePayloadEntry{}
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return index, err
		}
		name, err := cleanPayloadPath(header.Name)
		if err != nil {
			return index, err
		}
		if name == "." && header.Typeflag == tar.TypeDir {
			continue
		}
		if name == "." || mutableCorePayloadPath(name) || len(entries) >= 500000 || header.Mode&07000 != 0 {
			return index, fmt.Errorf("unsupported core payload member")
		}
		if _, exists := entries[name]; exists {
			return index, fmt.Errorf("duplicate core payload path")
		}
		e := CorePayloadEntry{Path: name, Mode: header.Mode & 0777}
		switch header.Typeflag {
		case tar.TypeReg, tar.TypeRegA:
			e.Kind, e.Size = "file", header.Size
			hash := sha256.New()
			if _, err := io.Copy(hash, reader); err != nil {
				return index, err
			}
			e.SHA256 = fmt.Sprintf("%x", hash.Sum(nil))
		case tar.TypeDir:
			e.Kind = "directory"
		case tar.TypeSymlink:
			e.Kind, e.Link, e.Mode = "symlink", header.Linkname, 0777
			if _, err := cleanPayloadPath(header.Linkname); err != nil && !strings.HasPrefix(header.Linkname, "../") {
				return index, err
			}
			if strings.HasPrefix(header.Linkname, "/") || strings.ContainsAny(header.Linkname, "\x00\r\n\\") {
				return index, fmt.Errorf("unsafe core payload link")
			}
			if _, err := cleanPayloadPath(path.Join(path.Dir(name), header.Linkname)); err != nil {
				return index, err
			}
		case tar.TypeLink:
			e.Kind = "hardlink"
			e.Link, err = cleanPayloadPath(header.Linkname)
			if err != nil {
				return index, err
			}
		default:
			return index, fmt.Errorf("core payload contains special files")
		}
		entries[name] = e
	}
	// No archive entry may be reached through a symlink/file ancestor, regardless
	// of tar order. Materialize implicit directories for installed tree checks.
	for name := range entries {
		for parent := path.Dir(name); parent != "."; parent = path.Dir(parent) {
			if e, ok := entries[parent]; ok && e.Kind != "directory" {
				return index, fmt.Errorf("core archive writes through a non-directory")
			}
		}
	}
	flattened := map[string]CorePayloadEntry{}
	for name, e := range entries {
		if e.Kind == "hardlink" {
			target, ok := entries[e.Link]
			if !ok || target.Kind != "file" {
				return index, fmt.Errorf("core hardlink must refer directly to an archived regular file")
			}
			e.Kind, e.Mode, e.Size, e.SHA256, e.Link = "file", target.Mode, target.Size, target.SHA256, ""
		}
		flattened[name] = e
	}
	entries = flattened
	for name := range entries {
		for parent := path.Dir(name); parent != "."; parent = path.Dir(parent) {
			if _, ok := entries[parent]; !ok {
				entries[parent] = CorePayloadEntry{Path: parent, Kind: "directory", Mode: 0755}
			}
		}
	}
	if server, ok := entries["server.js"]; !ok || server.Kind != "file" {
		return index, fmt.Errorf("core standalone payload has no server.js")
	}
	for _, e := range entries {
		index.Entries = append(index.Entries, e)
	}
	sort.Slice(index.Entries, func(i, j int) bool { return index.Entries[i].Path < index.Entries[j].Path })
	return index, nil
}

func (index CorePayloadIndex) Validate() error {
	if index.Schema != "youeye.core-payload.v1" || !validSHA256(index.ArtifactSHA256) || len(index.Entries) == 0 || len(index.Entries) > 500000 {
		return fmt.Errorf("invalid core payload index")
	}
	seen := map[string]CorePayloadEntry{}
	for _, e := range index.Entries {
		clean, err := cleanPayloadPath(e.Path)
		if err != nil || clean != e.Path || clean == "." || mutableCorePayloadPath(clean) || e.Mode < 0 || e.Mode > 0777 {
			return fmt.Errorf("invalid indexed core path")
		}
		if _, exists := seen[clean]; exists {
			return fmt.Errorf("duplicate indexed core path")
		}
		switch e.Kind {
		case "file":
			if !validSHA256(e.SHA256) || e.Size < 0 || e.Link != "" {
				return fmt.Errorf("invalid indexed file")
			}
		case "directory":
			if e.SHA256 != "" || e.Size != 0 || e.Link != "" {
				return fmt.Errorf("invalid indexed directory")
			}
		case "symlink":
			if e.Link == "" || e.Mode != 0777 || strings.HasPrefix(e.Link, "/") || strings.ContainsAny(e.Link, "\x00\r\n\\") {
				return fmt.Errorf("invalid indexed link")
			}
			if _, err := cleanPayloadPath(path.Join(path.Dir(e.Path), e.Link)); err != nil {
				return err
			}
		default:
			return fmt.Errorf("invalid indexed core type")
		}
		seen[clean] = e
	}
	for name := range seen {
		for parent := path.Dir(name); parent != "."; parent = path.Dir(parent) {
			if e, ok := seen[parent]; !ok || e.Kind != "directory" {
				return fmt.Errorf("invalid indexed parent")
			}
		}
	}
	if e, ok := seen["server.js"]; !ok || e.Kind != "file" {
		return fmt.Errorf("indexed core payload has no server.js")
	}
	return nil
}

// VerifyCorePayload walks the whole tree under root against its index and
// counts paths that were not shipped, recorded paths that changed (bytes, mode,
// link, type) and recorded paths that are missing. It never follows a symlink
// directory and skips the runtime directories. See CorePayloadMode.
func VerifyCorePayload(root string, index CorePayloadIndex, mode CorePayloadMode) (CorePayloadFindings, error) {
	if err := index.Validate(); err != nil {
		return CorePayloadFindings{}, err
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() {
		return CorePayloadFindings{}, fmt.Errorf("installed core payload root is not a directory")
	}
	dir, err := openCorePayloadDirectoryFromRoot(root)
	if err != nil {
		return CorePayloadFindings{}, err
	}
	defer dir.Close()
	return verifyCorePayloadDescriptor(context.Background(), dir, index, mode)
}

func (m CoreManager) SavePayloadIndex(index CorePayloadIndex) error {
	if err := index.Validate(); err != nil {
		return err
	}
	raw, err := json.Marshal(index)
	if err != nil {
		return err
	}
	return atomicWrite(filepath.Join(m.Root, "payloads", index.ArtifactSHA256+".json"), raw, 0600)
}

// LoadPayloadIndex reads host-owned file truth and binds it to the exact signed
// artifact. Missing or damaged evidence never becomes an empty payload.
func (m CoreManager) LoadPayloadIndex(digest string) (CorePayloadIndex, error) {
	var index CorePayloadIndex
	if !validSHA256(digest) {
		return index, fmt.Errorf("exact payload digest required")
	}
	raw, err := ReadCoreState(filepath.Join(m.Root, "payloads", digest+".json"), 256<<20)
	if err != nil {
		return index, err
	}
	if err = json.Unmarshal(raw, &index); err != nil {
		return index, err
	}
	if index.ArtifactSHA256 != digest {
		return index, fmt.Errorf("payload evidence belongs to another artifact")
	}
	return index, index.Validate()
}

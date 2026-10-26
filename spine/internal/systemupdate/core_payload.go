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

	"github.com/youeye-platform/YouEye/releasecache"
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

// These are runtime state, never signed executable payload. All other unknown
// files, including added JavaScript, are modifications to the installed member.
func mutableCorePayloadPath(name string) bool {
	return name == ".env" || name == ".next/cache" || strings.HasPrefix(name, ".next/cache/")
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
		if name == "." || mutableCorePayloadPath(name) || coreResponseCachePath(name) || len(entries) >= 500000 || header.Mode&07000 != 0 {
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

// VerifyCorePayload observes every installed static path and refuses extra code,
// modified bytes, executable modes and altered links. It never follows a symlink
// directory. Dynamic configuration/cache paths remain outside payload identity.
func VerifyCorePayload(root string, index CorePayloadIndex) error {
	if err := index.Validate(); err != nil {
		return err
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() {
		return fmt.Errorf("installed core payload root is not a directory")
	}
	dir, err := openCorePayloadDirectoryFromRoot(root)
	if err != nil {
		return err
	}
	defer dir.Close()
	return verifyCorePayloadDescriptor(context.Background(), dir, index)
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
// artifact. Missing or damaged evidence never becomes an empty/legacy payload.
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

// IndexCachedCoreMember uses only the exact authenticated media/cache bytes.
// It does not silently download a replacement when fresh installation media is
// incomplete. The complete role envelope is checked before deriving file truth.
func IndexCachedCoreMember(member releasecache.CoreMember, channel, trustPath, cacheRoot string) (CorePayloadIndex, error) {
	if member.Role != "cp" && member.Role != "ui" {
		return CorePayloadIndex{}, fmt.Errorf("standalone core member required")
	}
	key, err := CoreMemberKey(member, channel, trustPath)
	if err != nil {
		return CorePayloadIndex{}, err
	}
	if err := releasecache.VerifyCoreMember(member, key, func(blob releasecache.CoreBlob) (io.ReadCloser, error) {
		f, _, err := releasecache.Open(cacheRoot, blob.URL)
		return f, err
	}); err != nil {
		return CorePayloadIndex{}, err
	}
	f, _, err := releasecache.Open(cacheRoot, member.Artifact.URL)
	if err != nil {
		return CorePayloadIndex{}, err
	}
	defer f.Close()
	return IndexCorePayload(f.Name(), member.Artifact.SHA256)
}

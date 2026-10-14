package systemupdate

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"syscall"

	"github.com/youeye-platform/YouEye/releasecache"
)

// CoreArtifactCache is a protected content-addressed stage for a complete
// selection. Original names and source URLs remain in the signed manifest;
// deduplication changes neither provenance nor role signing authority.
type CoreArtifactCache struct {
	Root           string
	TrustKeyPath   string
	Client         *http.Client
	AvailableBytes func(string) (uint64, error)
}

func (c CoreArtifactCache) Path(blob releasecache.CoreBlob) (string, error) {
	if !filepath.IsAbs(c.Root) || !validSHA256(blob.SHA256) || blob.SizeBytes <= 0 {
		return "", fmt.Errorf("invalid core cache identity")
	}
	return filepath.Join(c.Root, "blobs", blob.SHA256), nil
}

func (c CoreArtifactCache) cached(blob releasecache.CoreBlob) (bool, error) {
	path, err := c.Path(blob)
	if err != nil {
		return false, err
	}
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode().Perm()&0022 != 0 || int(st.Uid) != os.Geteuid() {
		return false, fmt.Errorf("unsafe core cache blob")
	}
	if err := verifyFile(path, blob.SizeBytes, blob.SHA256); err != nil {
		return false, err
	}
	return true, nil
}

func coreMemberBlobs(m releasecache.CoreMember) []releasecache.CoreBlob {
	out := []releasecache.CoreBlob{m.Artifact, m.Checksums, m.Signature, m.Provenance, m.SBOM}
	if m.DocumentSignature != nil {
		out = append(out, *m.DocumentSignature)
	}
	if m.ReleaseLock != nil {
		out = append(out, *m.ReleaseLock)
	}
	return out
}

func (c CoreArtifactCache) Stage(ctx context.Context, selection CoreHostSelection) (releasecache.CoreRelease, string, error) {
	return c.stage(ctx, selection, nil)
}

// StageUpdate downloads only changed standalone services and required host
// documents. Native A/B staging owns host payload downloads; Installer/media
// artifacts are not needed for updating an already installed appliance.
func (c CoreArtifactCache) StageUpdate(ctx context.Context, selection CoreHostSelection, previous releasecache.CoreRelease) (releasecache.CoreRelease, string, error) {
	target, _, err := VerifyCoreSelection(selection.Raw, selection.Signature, c.TrustKeyPath)
	if err != nil {
		return target, "", err
	}
	selected := map[string]bool{}
	for _, member := range target.Members {
		if member.Role != "cp" && member.Role != "ui" && member.Role != "appliance" && member.Role != "system-update" {
			continue
		}
		old, err := coreServiceMember(previous, member.Role)
		if err != nil {
			return target, "", err
		}
		if !reflect.DeepEqual(old, member) {
			selected[member.Role] = true
		}
	}
	return c.stage(ctx, selection, selected)
}

func (c CoreArtifactCache) stage(ctx context.Context, selection CoreHostSelection, roles map[string]bool) (releasecache.CoreRelease, string, error) {
	r, digest, err := VerifyCoreSelection(selection.Raw, selection.Signature, c.TrustKeyPath)
	if err != nil {
		return r, "", err
	}
	for _, member := range r.Members {
		if err := CheckCoreMemberAuthority(member, r.Channel, c.TrustKeyPath); err != nil {
			return r, "", err
		}
	}
	if roles != nil && len(roles) == 0 {
		return r, digest, nil
	}
	if !filepath.IsAbs(c.Root) {
		return r, "", fmt.Errorf("protected core cache root required")
	}
	if err := os.MkdirAll(filepath.Join(c.Root, "blobs"), 0700); err != nil {
		return r, "", err
	}
	lock, err := os.OpenFile(filepath.Join(c.Root, "lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return r, "", err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return r, "", fmt.Errorf("core cache stage is already running: %w", err)
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	unique := map[string]releasecache.CoreBlob{}
	missing := []releasecache.CoreBlob{}
	required := uint64(updateHeadroomBytes)
	for _, m := range r.Members {
		if roles != nil && !roles[m.Role] {
			continue
		}
		// Resolve every current authority before downloading any payload.
		if _, err := CoreMemberKey(m, r.Channel, c.TrustKeyPath); err != nil {
			return r, "", err
		}
		for _, b := range coreMemberBlobs(m) {
			if old, ok := unique[b.SHA256]; ok {
				if old.SizeBytes != b.SizeBytes {
					return r, "", fmt.Errorf("same core blob has conflicting size")
				}
				continue
			}
			unique[b.SHA256] = b
			present, err := c.cached(b)
			if err != nil {
				return r, "", fmt.Errorf("core cache %s: %w", b.Name, err)
			}
			if !present {
				if uint64(b.SizeBytes) > ^uint64(0)-required {
					return r, "", fmt.Errorf("core cache size overflow")
				}
				required += uint64(b.SizeBytes)
				missing = append(missing, b)
			}
		}
	}
	available := c.AvailableBytes
	if available == nil {
		available = filesystemAvailableBytes
	}
	free, err := available(c.Root)
	if err != nil {
		return r, "", err
	}
	if free < required {
		return r, "", fmt.Errorf("complete core staging requires %d available bytes; found %d", required, free)
	}
	download := New(Config{HTTPClient: c.Client})
	for _, b := range missing {
		path, _ := c.Path(b)
		if err := download.downloadSource(ctx, b.URL, path+".part", path, b.SizeBytes, b.SHA256); err != nil {
			return r, "", fmt.Errorf("stage %s: %w", b.Name, err)
		}
	}
	for _, m := range r.Members {
		if roles != nil && !roles[m.Role] {
			continue
		}
		key, err := CoreMemberKey(m, r.Channel, c.TrustKeyPath)
		if err != nil {
			return r, "", err
		}
		if err := releasecache.VerifyCoreMember(m, key, func(blob releasecache.CoreBlob) (io.ReadCloser, error) {
			path, err := c.Path(blob)
			if err != nil {
				return nil, err
			}
			return os.Open(path)
		}); err != nil {
			return r, "", fmt.Errorf("verify core role %s: %w", m.Role, err)
		}
	}
	return r, digest, nil
}

// IndexMember rechecks current scoped authority and the complete role envelope
// before returning file truth for a cached standalone service member.
func (c CoreArtifactCache) IndexMember(member releasecache.CoreMember, channel string) (CorePayloadIndex, error) {
	if member.Role != "cp" && member.Role != "ui" {
		return CorePayloadIndex{}, fmt.Errorf("standalone core member required")
	}
	key, err := CoreMemberKey(member, channel, c.TrustKeyPath)
	if err != nil {
		return CorePayloadIndex{}, err
	}
	if err = releasecache.VerifyCoreMember(member, key, func(blob releasecache.CoreBlob) (io.ReadCloser, error) { return c.open(blob) }); err != nil {
		return CorePayloadIndex{}, err
	}
	file, err := c.open(member.Artifact)
	if err != nil {
		return CorePayloadIndex{}, err
	}
	defer file.Close()
	// The private cache is immutable. Keep this verified descriptor open while
	// indexing; /proc/self/fd binds the index to the same inode, not a new path.
	return IndexCorePayload(fmt.Sprintf("/proc/self/fd/%d", file.Fd()), member.Artifact.SHA256)
}

func (c CoreArtifactCache) open(blob releasecache.CoreBlob) (*os.File, error) {
	path, err := c.Path(blob)
	if err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode().Perm()&0022 != 0 || int(stat.Uid) != os.Geteuid() || info.Size() != blob.SizeBytes {
		file.Close()
		return nil, fmt.Errorf("unsafe core cache blob")
	}
	return file, nil
}

// Identical retained membership uses the original authenticated file index.
// Callers still verify actual current static files before skipping a payload.
func (c CoreArtifactCache) IndexSelected(m CoreManager, j CoreJournal, role string) (CorePayloadIndex, error) {
	member, err := coreServiceMember(j.Target, role)
	if err != nil {
		return CorePayloadIndex{}, err
	}
	previous, err := coreServiceMember(j.Previous.Release, role)
	if err != nil {
		return CorePayloadIndex{}, err
	}
	if err = CheckCoreMemberAuthority(member, j.Target.Channel, c.TrustKeyPath); err != nil {
		return CorePayloadIndex{}, err
	}
	if reflect.DeepEqual(member, previous) {
		return m.LoadPayloadIndex(member.Artifact.SHA256)
	}
	return c.IndexMember(member, j.Target.Channel)
}

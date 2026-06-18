package incus

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	SystemBaseImageSource        = "images:debian/12"
	SystemBaseImageAlias         = "youeye-debian-12"
	imageMetadataDir             = "/var/lib/youeye/images"
	officialSimpleStreamsIndex   = "https://images.linuxcontainers.org/streams/v1/images.json"
	debian12SimpleStreamsProduct = "debian:bookworm:amd64:default"
)

type imageInfo struct {
	Fingerprint  string            `json:"fingerprint"`
	Architecture string            `json:"architecture"`
	Type         string            `json:"type"`
	Properties   map[string]string `json:"properties"`
	Aliases      []struct {
		Name string `json:"name"`
	} `json:"aliases"`
}

type storedImageMetadata struct {
	Alias        string            `json:"alias"`
	Source       string            `json:"source"`
	Fingerprint  string            `json:"fingerprint"`
	Architecture string            `json:"architecture"`
	Type         string            `json:"type"`
	Properties   map[string]string `json:"properties"`
	VerifiedAt   string            `json:"verified_at"`
}

type simpleStreamsIndex struct {
	Products map[string]simpleStreamsProduct `json:"products"`
}

type simpleStreamsProduct struct {
	Arch         string                          `json:"arch"`
	OS           string                          `json:"os"`
	Release      string                          `json:"release"`
	ReleaseTitle string                          `json:"release_title"`
	Variant      string                          `json:"variant"`
	Versions     map[string]simpleStreamsVersion `json:"versions"`
}

type simpleStreamsVersion struct {
	Items map[string]simpleStreamsItem `json:"items"`
}

type simpleStreamsItem struct {
	FType                  string `json:"ftype"`
	SHA256                 string `json:"sha256"`
	Size                   int64  `json:"size"`
	Path                   string `json:"path"`
	CombinedSquashfsSHA256 string `json:"combined_squashfs_sha256"`
}

type verifiedBaseImage struct {
	Product          string
	Version          string
	MetadataPath     string
	MetadataSHA256   string
	RootfsPath       string
	RootfsSHA256     string
	CombinedSHA256   string
	DownloadBaseURL  string
	MetadataFilePath string
	RootfsFilePath   string
}

// EnsureSystemBaseImage makes the supported Debian 12 base image available as a
// local Incus alias. System containers must be created from this local alias so
// repeated deploy attempts do not depend on a regional image mirror.
func EnsureSystemBaseImage() error {
	fmt.Println("Ensuring YouEye base image is available locally...")

	info, err := localImageInfo(SystemBaseImageAlias)
	if err == nil {
		if err := validateDebian12Image(info); err != nil {
			return fmt.Errorf("local image %s failed validation: %w", SystemBaseImageAlias, err)
		}
		if err := writeImageMetadata(info); err != nil {
			return err
		}
		fmt.Printf("✓ Base image %s already available (%s)\n", SystemBaseImageAlias, shortFingerprint(info.Fingerprint))
		return nil
	}

	fmt.Printf("Base image %s not found locally; copying %s...\n", SystemBaseImageAlias, SystemBaseImageSource)
	if err := copyBaseImageWithRetry(SystemBaseImageSource, SystemBaseImageAlias, 3); err != nil {
		fmt.Printf("Official Incus image copy failed; trying verified public mirror fallback...\n")
		if fallbackErr := importVerifiedBaseImageFromMirrors(SystemBaseImageAlias); fallbackErr != nil {
			return fmt.Errorf("failed to copy base image %s into local Incus store: %w; verified mirror fallback also failed: %w", SystemBaseImageSource, err, fallbackErr)
		}
	}

	info, err = localImageInfo(SystemBaseImageAlias)
	if err != nil {
		return fmt.Errorf("base image copy completed but local alias %s is unavailable: %w", SystemBaseImageAlias, err)
	}
	if err := validateDebian12Image(info); err != nil {
		return fmt.Errorf("copied base image %s failed validation: %w", SystemBaseImageAlias, err)
	}
	if err := writeImageMetadata(info); err != nil {
		return err
	}

	fmt.Printf("✓ Base image %s ready (%s)\n", SystemBaseImageAlias, shortFingerprint(info.Fingerprint))
	return nil
}

func importVerifiedBaseImageFromMirrors(alias string) error {
	specs, err := debian12ImageSpecs()
	if err != nil {
		return err
	}

	tmpDir, err := os.MkdirTemp("", "youeye-base-image-*")
	if err != nil {
		return fmt.Errorf("failed to create temporary image directory: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	var lastErr error
	for _, spec := range specs {
		for _, baseURL := range verifiedImageMirrorBaseURLs() {
			candidate := spec
			candidate.DownloadBaseURL = baseURL
			candidate.MetadataFilePath = filepath.Join(tmpDir, "incus.tar.xz")
			candidate.RootfsFilePath = filepath.Join(tmpDir, "rootfs.squashfs")

			if err := downloadVerifiedImage(candidate); err != nil {
				lastErr = fmt.Errorf("%s %s: %w", baseURL, candidate.Version, err)
				continue
			}
			if err := importVerifiedImage(alias, candidate); err != nil {
				lastErr = fmt.Errorf("%s %s: %w", baseURL, candidate.Version, err)
				continue
			}
			fmt.Printf("✓ Imported verified base image %s from %s (%s)\n", candidate.Version, baseURL, shortFingerprint(candidate.CombinedSHA256))
			return nil
		}
	}

	if lastErr == nil {
		lastErr = fmt.Errorf("no verified image mirrors configured")
	}
	return lastErr
}

func latestDebian12ImageSpec() (verifiedBaseImage, error) {
	specs, err := debian12ImageSpecs()
	if err != nil {
		return verifiedBaseImage{}, err
	}
	return specs[0], nil
}

func debian12ImageSpecs() ([]verifiedBaseImage, error) {
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Get(officialSimpleStreamsIndex)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch official image metadata: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("official image metadata returned HTTP %d", resp.StatusCode)
	}

	var index simpleStreamsIndex
	if err := json.NewDecoder(resp.Body).Decode(&index); err != nil {
		return nil, fmt.Errorf("failed to decode official image metadata: %w", err)
	}
	product, ok := index.Products[debian12SimpleStreamsProduct]
	if !ok {
		return nil, fmt.Errorf("official image metadata does not contain %s", debian12SimpleStreamsProduct)
	}
	return selectVerifiedBaseImages(product)
}

func selectLatestVerifiedBaseImage(product simpleStreamsProduct) (verifiedBaseImage, error) {
	specs, err := selectVerifiedBaseImages(product)
	if err != nil {
		return verifiedBaseImage{}, err
	}
	return specs[0], nil
}

func selectVerifiedBaseImages(product simpleStreamsProduct) ([]verifiedBaseImage, error) {
	if product.Arch != "amd64" || !strings.EqualFold(product.OS, "debian") || product.Release != "bookworm" || product.Variant != "default" {
		return nil, fmt.Errorf("unexpected image product metadata: os=%q release=%q arch=%q variant=%q", product.OS, product.Release, product.Arch, product.Variant)
	}
	if len(product.Versions) == 0 {
		return nil, fmt.Errorf("official image metadata has no Debian 12 versions")
	}

	versions := make([]string, 0, len(product.Versions))
	for version := range product.Versions {
		versions = append(versions, version)
	}
	sort.Strings(versions)

	specs := make([]verifiedBaseImage, 0, len(versions))
	for i := len(versions) - 1; i >= 0; i-- {
		version := versions[i]
		items := product.Versions[version].Items
		metadata := items["incus.tar.xz"]
		rootfs := items["root.squashfs"]
		if metadata.Path == "" || metadata.SHA256 == "" || metadata.CombinedSquashfsSHA256 == "" || rootfs.Path == "" || rootfs.SHA256 == "" {
			continue
		}
		specs = append(specs, verifiedBaseImage{
			Product:        debian12SimpleStreamsProduct,
			Version:        version,
			MetadataPath:   metadata.Path,
			MetadataSHA256: metadata.SHA256,
			RootfsPath:     rootfs.Path,
			RootfsSHA256:   rootfs.SHA256,
			CombinedSHA256: metadata.CombinedSquashfsSHA256,
		})
	}

	if len(specs) == 0 {
		return nil, fmt.Errorf("official image metadata has no complete Incus squashfs container image")
	}
	return specs, nil
}

func verifiedImageMirrorBaseURLs() []string {
	return []string{
		"https://images.linuxcontainers.org",
		"https://fra1lxdmirror01.do.letsbuildthe.cloud",
	}
}

func downloadVerifiedImage(image verifiedBaseImage) error {
	if err := downloadVerifiedFile(imageURL(image.DownloadBaseURL, image.MetadataPath), image.MetadataFilePath, image.MetadataSHA256); err != nil {
		return err
	}
	if err := downloadVerifiedFile(imageURL(image.DownloadBaseURL, image.RootfsPath), image.RootfsFilePath, image.RootfsSHA256); err != nil {
		return err
	}
	combined, err := combinedFileSHA256(image.MetadataFilePath, image.RootfsFilePath)
	if err != nil {
		return err
	}
	if combined != image.CombinedSHA256 {
		return fmt.Errorf("combined image fingerprint is %s, want %s", combined, image.CombinedSHA256)
	}
	return nil
}

func downloadVerifiedFile(url, destination, expectedSHA256 string) error {
	client := &http.Client{Timeout: 3 * time.Minute}
	resp, err := client.Get(url)
	if err != nil {
		return fmt.Errorf("failed to download %s: %w", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("download %s returned HTTP %d", url, resp.StatusCode)
	}

	tmpPath := destination + ".tmp"
	out, err := os.Create(tmpPath)
	if err != nil {
		return fmt.Errorf("failed to create %s: %w", tmpPath, err)
	}
	hasher := sha256.New()
	if _, err := io.Copy(io.MultiWriter(out, hasher), resp.Body); err != nil {
		out.Close()
		os.Remove(tmpPath)
		return fmt.Errorf("failed to write %s: %w", destination, err)
	}
	if err := out.Close(); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("failed to close %s: %w", destination, err)
	}

	actualSHA256 := fmt.Sprintf("%x", hasher.Sum(nil))
	if actualSHA256 != expectedSHA256 {
		os.Remove(tmpPath)
		return fmt.Errorf("downloaded %s sha256 is %s, want %s", url, actualSHA256, expectedSHA256)
	}
	if err := os.Rename(tmpPath, destination); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("failed to move verified download into place: %w", err)
	}
	return nil
}

func combinedFileSHA256(paths ...string) (string, error) {
	hasher := sha256.New()
	for _, path := range paths {
		file, err := os.Open(path)
		if err != nil {
			return "", fmt.Errorf("failed to open %s: %w", path, err)
		}
		if _, err := io.Copy(hasher, file); err != nil {
			file.Close()
			return "", fmt.Errorf("failed to hash %s: %w", path, err)
		}
		if err := file.Close(); err != nil {
			return "", fmt.Errorf("failed to close %s: %w", path, err)
		}
	}
	return fmt.Sprintf("%x", hasher.Sum(nil)), nil
}

func importVerifiedImage(alias string, image verifiedBaseImage) error {
	out, err := exec.Command("incus", "image", "import", image.MetadataFilePath, image.RootfsFilePath, "--alias", alias).CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to import verified image: %w: %s", err, strings.TrimSpace(string(out)))
	}
	info, err := localImageInfo(alias)
	if err != nil {
		return fmt.Errorf("imported image is not available as local:%s: %w", alias, err)
	}
	if info.Fingerprint != image.CombinedSHA256 {
		return fmt.Errorf("imported image fingerprint is %s, want %s", info.Fingerprint, image.CombinedSHA256)
	}
	return nil
}

func imageURL(baseURL, imagePath string) string {
	return strings.TrimRight(baseURL, "/") + "/" + strings.TrimLeft(imagePath, "/")
}

func copyBaseImageWithRetry(source, alias string, attempts int) error {
	var lastErr error
	for i := 1; i <= attempts; i++ {
		args := []string{"image", "copy", source, "local:", "--alias", alias, "--copy-aliases=false"}
		out, err := exec.Command("incus", args...).CombinedOutput()
		if err == nil {
			return nil
		}
		lastErr = fmt.Errorf("%v: %s", err, strings.TrimSpace(string(out)))
		if i < attempts {
			time.Sleep(time.Duration(i) * 2 * time.Second)
		}
	}
	return lastErr
}

func localImageInfo(alias string) (*imageInfo, error) {
	out, err := exec.Command("incus", "image", "list", alias, "--format", "json").Output()
	if err != nil {
		return nil, err
	}
	return parseLocalImageList(alias, out)
}

func parseLocalImageList(alias string, out []byte) (*imageInfo, error) {
	var images []imageInfo
	if err := json.Unmarshal(out, &images); err != nil {
		return nil, err
	}
	if len(images) == 0 {
		return nil, fmt.Errorf("local image alias %s was not found", alias)
	}
	if len(images) > 1 {
		return nil, fmt.Errorf("local image alias %s matched %d images", alias, len(images))
	}
	return &images[0], nil
}

func validateDebian12Image(info *imageInfo) error {
	if info == nil {
		return fmt.Errorf("image info is empty")
	}
	if info.Fingerprint == "" {
		return fmt.Errorf("fingerprint is empty")
	}
	if info.Type != "container" {
		return fmt.Errorf("type is %q, want container", info.Type)
	}
	if info.Architecture != "x86_64" && info.Properties["architecture"] != "amd64" {
		return fmt.Errorf("architecture is %q/%q, want amd64", info.Architecture, info.Properties["architecture"])
	}
	if !strings.EqualFold(info.Properties["os"], "debian") {
		return fmt.Errorf("os is %q, want Debian", info.Properties["os"])
	}
	release := strings.ToLower(info.Properties["release"])
	if release != "bookworm" && release != "12" {
		return fmt.Errorf("release is %q, want bookworm/12", info.Properties["release"])
	}
	return nil
}

func writeImageMetadata(info *imageInfo) error {
	if err := os.MkdirAll(imageMetadataDir, 0700); err != nil {
		return fmt.Errorf("failed to create image metadata directory: %w", err)
	}
	metadata := storedImageMetadata{
		Alias:        SystemBaseImageAlias,
		Source:       SystemBaseImageSource,
		Fingerprint:  info.Fingerprint,
		Architecture: info.Architecture,
		Type:         info.Type,
		Properties:   info.Properties,
		VerifiedAt:   time.Now().UTC().Format(time.RFC3339),
	}
	data, err := json.MarshalIndent(metadata, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to encode image metadata: %w", err)
	}
	path := filepath.Join(imageMetadataDir, "debian-12.json")
	if err := os.WriteFile(path, data, 0600); err != nil {
		return fmt.Errorf("failed to write image metadata: %w", err)
	}
	return nil
}

func shortFingerprint(fingerprint string) string {
	if len(fingerprint) <= 12 {
		return fingerprint
	}
	return fingerprint[:12]
}

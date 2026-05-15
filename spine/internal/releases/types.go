package releases

// Release represents a software release.
type Release struct {
	TagName string  `json:"tag_name"`
	Version string  // Parsed version without 'v' prefix
	Assets  []Asset `json:"assets"`
}

// Asset represents a release asset (downloadable file).
type Asset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
	Size               int64  `json:"size"`
}

// FindAsset returns the first asset matching the given name, or nil.
func (r *Release) FindAsset(name string) *Asset {
	for i := range r.Assets {
		if r.Assets[i].Name == name {
			return &r.Assets[i]
		}
	}
	return nil
}

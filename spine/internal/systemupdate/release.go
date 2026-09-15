package systemupdate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/youeye-platform/YouEye/appliance/ordering"
)

const (
	DefaultReleaseProvider = "github"
	DefaultReleasesAPI     = "https://api.github.com/repos/YouEye-Platform/YouEye/releases"
	releaseGitHubPageSize  = 100
	releaseForgejoPageSize = 50
	releaseMaxPages        = 200
)

type ReleaseSelection struct {
	Provider       string
	Channel        string
	Branch         string
	ExactTag       string
	ManifestSHA256 string
	ReleasesAPI    string
}

type ReleaseMetadata struct {
	Provider     string `json:"provider"`
	Channel      string `json:"channel"`
	Tag          string `json:"tag"`
	ReleaseNotes string `json:"release_notes,omitempty"`
	ManifestURL  string `json:"manifest_url"`
	SignatureURL string `json:"signature_url"`
}

type releaseAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
}

type release struct {
	TagName     string         `json:"tag_name"`
	Body        string         `json:"body"`
	Draft       bool           `json:"draft"`
	Prerelease  bool           `json:"prerelease"`
	PublishedAt time.Time      `json:"published_at"`
	Assets      []releaseAsset `json:"assets"`
}

func ReleaseHTTPClient() *http.Client {
	return &http.Client{
		Timeout: 30 * time.Second,
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return errors.New("too many release API redirects")
			}
			if err := requireHTTPS(request.URL.String()); err != nil {
				return err
			}
			if len(via) > 0 && !strings.EqualFold(request.URL.Host, via[0].URL.Host) {
				return errors.New("release API redirected across origins")
			}
			return nil
		},
	}
}

func ResolveRelease(ctx context.Context, client *http.Client, selection ReleaseSelection) (SourceOptions, ReleaseMetadata, error) {
	options, metadata, err := ResolveReleaseCandidates(ctx, client, selection)
	if err != nil {
		return SourceOptions{}, ReleaseMetadata{}, err
	}
	return options[0], metadata[0], nil
}

// ResolveReleaseCandidates returns safe release-scoped signed-manifest
// sources in newest-publication order. Exact mode always returns one. Track
// convergence may inspect later candidates only when a verified target says a
// signed bridge is required; signature or digest failures never fall through.
func ResolveReleaseCandidates(ctx context.Context, client *http.Client, selection ReleaseSelection) ([]SourceOptions, []ReleaseMetadata, error) {
	channel := strings.ToLower(strings.TrimSpace(selection.Channel))
	if channel == "" {
		channel = "stable"
	}
	if channel == "dev" {
		channel = "development"
	}
	if channel != "stable" && channel != "development" && channel != "branch" && channel != "exact" {
		return nil, nil, fmt.Errorf("unsupported appliance channel %q", channel)
	}
	branch := strings.TrimSpace(selection.Branch)
	if channel == "exact" {
		if !validExactReleaseTag(selection.ExactTag) {
			return nil, nil, errors.New("exact selection requires a valid appliance release tag")
		}
		digest := strings.ToLower(strings.TrimSpace(selection.ManifestSHA256))
		if len(digest) != 64 || !isLowerHex(digest) {
			return nil, nil, errors.New("exact selection requires a 64-character lowercase manifest SHA-256")
		}
		if branch != "" {
			return nil, nil, errors.New("exact selection cannot include a branch")
		}
	} else if strings.TrimSpace(selection.ExactTag) != "" || strings.TrimSpace(selection.ManifestSHA256) != "" {
		return nil, nil, errors.New("tracking selections cannot include an exact tag or digest")
	}
	if channel == "branch" {
		if !validReleaseBranch(branch) {
			return nil, nil, errors.New("branch selection requires a safe signed release branch")
		}
	} else if branch != "" {
		return nil, nil, errors.New("only the branch track can include a branch")
	}

	provider, apiURL, err := normalizeReleaseSource(selection.Provider, selection.ReleasesAPI)
	if err != nil {
		return nil, nil, err
	}
	if client == nil {
		client = ReleaseHTTPClient()
	}
	releases, err := fetchReleases(ctx, client, provider, apiURL)
	if err != nil {
		return nil, nil, err
	}
	selected, err := selectReleaseCandidates(releases, channel, strings.TrimSpace(selection.ExactTag), branch)
	if err != nil {
		return nil, nil, err
	}
	options := make([]SourceOptions, 0, len(selected))
	metadata := make([]ReleaseMetadata, 0, len(selected))
	for _, candidate := range selected {
		manifestURL, err := releaseAssetURL(provider, apiURL, candidate, "system-update-manifest.json")
		if err != nil {
			return nil, nil, err
		}
		signatureURL, err := releaseAssetURL(provider, apiURL, candidate, "system-update-manifest.json.sig")
		if err != nil {
			return nil, nil, err
		}
		meta := ReleaseMetadata{
			Provider: provider, Channel: channel, Tag: candidate.TagName, ReleaseNotes: strings.TrimSpace(candidate.Body),
			ManifestURL: manifestURL, SignatureURL: signatureURL,
		}
		expectedBranch := ""
		switch channel {
		case "stable":
			expectedBranch = "main"
		case "development":
			expectedBranch = "dev"
		case "branch":
			expectedBranch = branch
		}
		options = append(options, SourceOptions{
			ManifestSource: manifestURL, SignatureSource: signatureURL,
			ExpectedManifestSHA256: strings.ToLower(strings.TrimSpace(selection.ManifestSHA256)),
			Channel:                channel, ReleaseTag: candidate.TagName, ReleaseNotes: meta.ReleaseNotes,
			ExpectedReleaseBranch: expectedBranch,
		})
		metadata = append(metadata, meta)
	}
	return options, metadata, nil
}

func normalizeReleaseSource(provider, raw string) (string, *url.URL, error) {
	provider = strings.ToLower(strings.TrimSpace(provider))
	if provider == "" {
		provider = DefaultReleaseProvider
	}
	if provider != "github" && provider != "forgejo" && provider != "custom" {
		return "", nil, errors.New("release provider must be github, forgejo, or custom")
	}
	raw = strings.TrimSpace(raw)
	if raw == "" && provider == DefaultReleaseProvider {
		raw = DefaultReleasesAPI
	}
	if raw == "" {
		return "", nil, fmt.Errorf("%s release provider requires an explicit HTTPS releases API", provider)
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" {
		return "", nil, errors.New("appliance releases API must be an HTTPS URL without credentials or a fragment")
	}
	for key := range parsed.Query() {
		if key != "limit" && key != "per_page" && key != "page" {
			return "", nil, fmt.Errorf("appliance releases API contains unsupported query parameter %q", key)
		}
	}
	if provider == DefaultReleaseProvider {
		parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
		if !strings.EqualFold(parsed.Hostname(), "api.github.com") || len(parts) != 4 || parts[0] != "repos" || parts[3] != "releases" {
			return "", nil, errors.New("GitHub release provider requires an api.github.com repository releases URL")
		}
	}
	return provider, parsed, nil
}

func fetchReleases(ctx context.Context, client *http.Client, provider string, apiURL *url.URL) ([]release, error) {
	pageSize, pageSizeKey := releaseForgejoPageSize, "limit"
	if provider == DefaultReleaseProvider {
		pageSize, pageSizeKey = releaseGitHubPageSize, "per_page"
	}
	var releases []release
	seenTags := make(map[string]struct{})
	for pageNumber := 1; pageNumber <= releaseMaxPages; pageNumber++ {
		pageURL := *apiURL
		query := pageURL.Query()
		query.Del("limit")
		query.Del("per_page")
		query.Del("page")
		query.Set(pageSizeKey, fmt.Sprint(pageSize))
		query.Set("page", fmt.Sprint(pageNumber))
		pageURL.RawQuery = query.Encode()
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, pageURL.String(), nil)
		if err != nil {
			return nil, fmt.Errorf("create appliance releases request: %w", err)
		}
		request.Header.Set("Accept", "application/json")
		request.Header.Set("User-Agent", "youeye-spine/system-update")
		if provider == DefaultReleaseProvider {
			request.Header.Set("Accept", "application/vnd.github+json")
			request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
		}
		response, err := client.Do(request)
		if err != nil {
			return nil, fmt.Errorf("query appliance releases page %d: %w", pageNumber, err)
		}
		if response.StatusCode != http.StatusOK {
			response.Body.Close()
			return nil, fmt.Errorf("appliance releases API page %d returned %s", pageNumber, response.Status)
		}
		var releasePage []release
		decodeErr := json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(&releasePage)
		closeErr := response.Body.Close()
		if decodeErr != nil {
			return nil, fmt.Errorf("decode appliance releases page %d: %w", pageNumber, decodeErr)
		}
		if closeErr != nil {
			return nil, fmt.Errorf("close appliance releases page %d: %w", pageNumber, closeErr)
		}
		if len(releasePage) == 0 {
			return releases, nil
		}
		for _, candidate := range releasePage {
			if _, exists := seenTags[candidate.TagName]; exists {
				return nil, fmt.Errorf("appliance releases API returned duplicate tag %q", candidate.TagName)
			}
			seenTags[candidate.TagName] = struct{}{}
			releases = append(releases, candidate)
		}
		if pageNumber == releaseMaxPages {
			return nil, fmt.Errorf("appliance release discovery exceeded %d pages; select an exact tag", releaseMaxPages)
		}
	}
	return nil, errors.New("appliance release discovery did not terminate")
}

func selectRelease(releases []release, channel, exactTag string) (release, error) {
	selected, err := selectReleaseCandidates(releases, channel, exactTag, "")
	if err != nil {
		return release{}, err
	}
	return selected[0], nil
}

func selectReleaseCandidates(releases []release, channel, exactTag, branch string) ([]release, error) {
	if channel == "exact" {
		for _, candidate := range releases {
			if candidate.TagName == exactTag && validExactRelease(candidate) {
				return []release{candidate}, nil
			}
		}
		return nil, fmt.Errorf("exact appliance release %q was not found", exactTag)
	}
	type candidate struct {
		release release
		version ordering.Version
	}
	prefix := "appliance-v"
	if channel == "development" {
		prefix = "appliance-dev-v"
	} else if channel == "branch" {
		prefix = "appliance-" + branch + "-v"
	}
	var candidates []candidate
	for _, item := range releases {
		if item.Draft || item.PublishedAt.IsZero() || !strings.HasPrefix(item.TagName, prefix) {
			continue
		}
		version, err := ordering.ParseVersion(strings.TrimPrefix(item.TagName, prefix))
		if err != nil || (channel == "stable" && (len(version.Pre) != 0 || item.Prerelease)) {
			continue
		}
		candidates = append(candidates, candidate{release: item, version: version})
	}
	if len(candidates) == 0 {
		return nil, fmt.Errorf("no %s appliance release was found", channel)
	}
	sort.Slice(candidates, func(i, j int) bool {
		if !candidates[i].release.PublishedAt.Equal(candidates[j].release.PublishedAt) {
			return candidates[i].release.PublishedAt.After(candidates[j].release.PublishedAt)
		}
		return ordering.CompareVersion(candidates[i].version, candidates[j].version) > 0
	})
	selected := make([]release, len(candidates))
	for index := range candidates {
		selected[index] = candidates[index].release
	}
	return selected, nil
}

func validExactRelease(candidate release) bool {
	if candidate.Draft || candidate.PublishedAt.IsZero() {
		return false
	}
	if version, ok := parseReleaseTag(candidate.TagName, "appliance-v"); ok {
		return len(version.Pre) == 0 && !candidate.Prerelease
	}
	if _, ok := parseReleaseTag(candidate.TagName, "appliance-dev-v"); ok {
		return true
	}
	marker := strings.LastIndex(candidate.TagName, "-v")
	if !strings.HasPrefix(candidate.TagName, "appliance-") || marker <= len("appliance-") {
		return false
	}
	branch := candidate.TagName[len("appliance-"):marker]
	_, ok := parseReleaseTag(candidate.TagName, "appliance-"+branch+"-v")
	return ok && validReleaseBranch(branch)
}

func parseReleaseTag(tag, prefix string) (ordering.Version, bool) {
	if !strings.HasPrefix(tag, prefix) {
		return ordering.Version{}, false
	}
	version, err := ordering.ParseVersion(strings.TrimPrefix(tag, prefix))
	return version, err == nil
}

func validExactReleaseTag(tag string) bool {
	return validExactRelease(release{TagName: tag, PublishedAt: time.Unix(1, 0)})
}

func validReleaseBranch(branch string) bool {
	if branch == "" || len(branch) > 96 || strings.ContainsAny(branch, "\\%\x00") {
		return false
	}
	for _, component := range strings.Split(branch, "/") {
		if component == "" || component == "." || component == ".." || strings.HasPrefix(component, ".") || strings.HasSuffix(component, ".") || strings.HasSuffix(component, ".lock") {
			return false
		}
		for _, char := range component {
			if (char < 'a' || char > 'z') && (char < '0' || char > '9') && !strings.ContainsRune("._-", char) {
				return false
			}
		}
	}
	return true
}

func releaseAssetURL(provider string, apiURL *url.URL, selected release, name string) (string, error) {
	var found string
	for _, asset := range selected.Assets {
		if asset.Name != name {
			continue
		}
		if found != "" {
			return "", fmt.Errorf("appliance release %s has duplicate %s", selected.TagName, name)
		}
		if err := validateReleaseAssetURL(provider, apiURL, selected.TagName, name, asset.BrowserDownloadURL); err != nil {
			return "", fmt.Errorf("appliance release %s %s: %w", selected.TagName, name, err)
		}
		found = asset.BrowserDownloadURL
	}
	if found == "" {
		return "", fmt.Errorf("appliance release %s is missing %s", selected.TagName, name)
	}
	return found, nil
}

func validateReleaseAssetURL(provider string, apiURL *url.URL, tag, name, raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return errors.New("download URL must use HTTPS without credentials, query, or fragment")
	}
	escapedPath := parsed.EscapedPath()
	lowerPath := strings.ToLower(escapedPath)
	escapedName := path.Base(escapedPath)
	if strings.Contains(strings.ToLower(escapedName), "%2f") || strings.Contains(lowerPath, "%5c") || strings.Contains(escapedPath, "//") {
		return errors.New("download URL contains an unsafe encoded or nested path")
	}
	decodedName, err := url.PathUnescape(escapedName)
	if err != nil || decodedName != name || path.Base(decodedName) != decodedName || decodedName == "." || decodedName == ".." {
		return fmt.Errorf("download URL asset identity does not match %q", name)
	}
	decodedPath, err := url.PathUnescape(escapedPath)
	if err != nil || !strings.HasSuffix(decodedPath, "/releases/download/"+tag+"/"+name) {
		return errors.New("download URL is not scoped to the selected release")
	}
	if provider == DefaultReleaseProvider {
		parts := strings.Split(strings.Trim(apiURL.Path, "/"), "/")
		if !strings.EqualFold(parsed.Hostname(), "github.com") || len(parts) != 4 || !strings.HasPrefix(decodedPath, "/"+parts[1]+"/"+parts[2]+"/") {
			return errors.New("GitHub asset URL does not match the configured repository")
		}
	} else if !strings.EqualFold(parsed.Host, apiURL.Host) {
		return errors.New("asset origin does not match the configured release API")
	}
	return nil
}

func requireHTTPS(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil {
		return errors.New("URL must use HTTPS with no embedded credentials")
	}
	return nil
}

func isLowerHex(value string) bool {
	for _, char := range value {
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') {
			return false
		}
	}
	return true
}

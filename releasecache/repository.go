package releasecache

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

// OfficialRepository is the public YouEye repository. It is the only
// repository built into product defaults; any other one (for example a private
// development forge) is reached only because it was given at install time.
const OfficialRepository = "https://github.com/YouEye-Platform/YouEye"

// OfficialIndexHost serves copies of the official public channel indexes.
const OfficialIndexHost = "https://releases.youeye.me"

var repositoryPart = regexp.MustCompile(`^[A-Za-z0-9_-][A-Za-z0-9._-]*$`)

// CanonicalRepository returns https://host/owner/repository for a repository
// URL, or an error. It accepts a trailing slash or ".git".
func CanonicalRepository(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.RawPath != "" {
		return "", fmt.Errorf("repository must be an HTTPS URL without credentials, query or fragment")
	}
	parts := strings.Split(strings.TrimSuffix(strings.TrimSuffix(u.Path, "/"), ".git"), "/")
	if len(parts) != 3 || parts[0] != "" || !repositoryPart.MatchString(parts[1]) || !repositoryPart.MatchString(parts[2]) || strings.HasSuffix(parts[1], ".") || strings.HasSuffix(parts[2], ".") {
		return "", fmt.Errorf("repository URL must identify an owner and repository")
	}
	return "https://" + strings.ToLower(u.Host) + "/" + parts[1] + "/" + parts[2], nil
}

// Package updatetrust stores explicit owner grants independently of System slots.
// A downloaded key is evidence, never an enrollment request.
package updatetrust

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"github.com/youeye-platform/YouEye/releasecache"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

const Path = "/var/lib/youeye-state/update-trust.json"
const Schema = "youeye.owner-update-trust.v1"

type Grant struct {
	Publisher  string `json:"publisher"`
	Repository string `json:"repository"`
	Branch     string `json:"branch"`
	Scope      string `json:"scope"`
	PublicKey  string `json:"public_key"`
	Revoked    bool   `json:"revoked"`
}
type Policy struct {
	Schema string  `json:"schema"`
	Grants []Grant `json:"grants"`
}

func Repository(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.RawPath != "" {
		return "", errors.New("trust repository must be an exact HTTPS owner/repository URL")
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(parts) != 2 {
		return "", errors.New("trust repository must name one owner and repository")
	}
	for _, p := range parts {
		if p == "" || p == "." || p == ".." || strings.ContainsAny(p, "\\ %\t\r\n") {
			return "", errors.New("invalid trust repository path")
		}
	}
	u.Host = strings.ToLower(u.Host)
	u.Path = "/" + strings.Join(parts, "/")
	return u.String(), nil
}
func Key(raw string) (ed25519.PublicKey, error) {
	block, rest := pem.Decode([]byte(raw))
	if block == nil || block.Type != "PUBLIC KEY" || len(bytes.TrimSpace(rest)) != 0 {
		return nil, errors.New("expected one Ed25519 public key")
	}
	value, err := x509.ParsePKIXPublicKey(block.Bytes)
	key, ok := value.(ed25519.PublicKey)
	if err != nil || !ok {
		return nil, errors.New("expected an Ed25519 public key")
	}
	return key, nil
}
func Fingerprint(raw string) (string, error) {
	key, err := Key(raw)
	if err != nil {
		return "", err
	}
	der, err := x509.MarshalPKIXPublicKey(key)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(der)
	return hex.EncodeToString(digest[:]), nil
}
func (p Policy) Validate() error {
	if p.Schema != Schema || len(p.Grants) > 128 {
		return errors.New("invalid owner trust policy")
	}
	seen := map[string]bool{}
	for _, g := range p.Grants {
		repo, err := Repository(g.Repository)
		if err != nil || repo != g.Repository {
			return errors.New("trust repository must be canonical")
		}
		if !releasecache.ValidCoreBranch(g.Branch) {
			return errors.New("invalid trust branch")
		}
		if g.Scope != "appliance" && g.Scope != "spine" && g.Scope != "cp" && g.Scope != "ui" && g.Scope != "app" {
			return errors.New("invalid trust scope")
		}
		if strings.TrimSpace(g.Publisher) == "" || len(g.Publisher) > 100 {
			return errors.New("publisher label is required")
		}
		if _, err := Key(g.PublicKey); err != nil {
			return err
		}
		id := g.Repository + "\n" + g.Branch + "\n" + g.Scope
		if seen[id] {
			return errors.New("duplicate source/channel/scope grant")
		}
		seen[id] = true
	}
	return nil
}
func Load(path string) (Policy, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return Policy{Schema: Schema, Grants: []Grant{}}, nil
	}
	if err != nil {
		return Policy{}, err
	}
	if len(raw) > 1<<20 {
		return Policy{}, errors.New("owner trust policy too large")
	}
	var p Policy
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err = d.Decode(&p); err != nil {
		return p, err
	}
	var extra any
	if err = d.Decode(&extra); err != io.EOF {
		return p, errors.New("trailing owner trust policy data")
	}
	return p, p.Validate()
}
func (p Policy) Lookup(repository, branch, scope string) (*Grant, error) {
	for _, g := range p.Grants {
		if g.Repository == repository && g.Branch == branch && g.Scope == scope {
			if g.Revoked {
				return nil, errors.New("publisher trust revoked for this source and scope")
			}
			return &g, nil
		}
	}
	return nil, nil
}
func Lookup(repository, branch, scope string) (*Grant, error) {
	p, err := Load(Path)
	if err != nil {
		return nil, err
	}
	return p.Lookup(repository, branch, scope)
}
func Save(path string, p Policy) error {
	if err := p.Validate(); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".update-trust-")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(append(raw, '\n'))
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = os.Rename(f.Name(), path); err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

// ReleaseIdentity refuses ambiguous URL forms before matching a scoped grant.
func ReleaseIdentity(raw string) (repository, branch, scope string, err error) {
	u, e := url.Parse(raw)
	if e != nil {
		return "", "", "", e
	}
	parts := strings.Split(strings.TrimPrefix(u.EscapedPath(), "/"), "/")
	if len(parts) != 6 || parts[2] != "releases" || parts[3] != "download" {
		return "", "", "", fmt.Errorf("not an exact release asset URL")
	}
	base := *u
	base.Path = "/" + parts[0] + "/" + parts[1]
	base.RawPath = ""
	repository, err = Repository(base.String())
	if err != nil {
		return
	}
	tag, decodeErr := url.PathUnescape(parts[4])
	if decodeErr != nil {
		err = decodeErr
		return
	}
	branch = "main"
	scope = "app"
	for _, s := range []string{"appliance", "spine", "cp", "ui"} {
		if strings.HasPrefix(tag, s+"-") {
			scope = s
			tag = strings.TrimPrefix(tag, s+"-")
			break
		}
	}
	if marker := strings.LastIndex(tag, "-v"); marker >= 0 {
		branch, tag = tag[:marker], tag[marker+1:]
	}
	versionValue := strings.TrimPrefix(tag, "v")
	if !strings.HasPrefix(tag, "v") || !releasecache.ValidCoreBranch(branch) {
		err = errors.New("unsupported release branch or tag")
		return
	}
	if !releasecache.ValidCoreVersion(versionValue) {
		for _, part := range strings.Split(versionValue, ".") {
			if part == "" {
				err = errors.New("unsupported release version")
				return
			}
			for _, ch := range part {
				if ch < '0' || ch > '9' {
					err = errors.New("unsupported release version")
					return
				}
			}
		}
	}

	return
}

// LookupRelease fails closed for an enrolled repository even when the caller
// supplies an ambiguous tag/URL. Unrelated legacy sources keep their policy.
func LookupRelease(raw string, scopeOverride string) (*Grant, error) {
	p, err := Load(Path)
	if err != nil {
		return nil, err
	}
	if len(p.Grants) == 0 {
		return nil, nil
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	parts := strings.Split(strings.TrimPrefix(u.Path, "/"), "/")
	if len(parts) < 2 {
		return nil, nil
	}
	repo := u.Scheme + "://" + strings.ToLower(u.Host) + "/" + parts[0] + "/" + parts[1]
	enrolled := false
	for _, g := range p.Grants {
		if g.Repository == repo {
			enrolled = true
		}
	}
	if !enrolled {
		return nil, nil
	}
	repository, branch, scope, err := ReleaseIdentity(raw)
	if err != nil {
		return nil, err
	}
	if scopeOverride != "" {
		scope = scopeOverride
	}
	return p.Lookup(repository, branch, scope)
}

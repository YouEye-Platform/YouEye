// Package boxca keeps the box's own certificate authority: one ECDSA P-256
// root made at first boot and kept on State. The Preparing page's leaf is
// signed by it, and Caddy is given the same root before it first starts, so an
// owner who trusts it (GET /api/setup/ca-cert) sees no warning on either.
package boxca

import (
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const (
	// DefaultDir is the root's place on State.
	DefaultDir = "/var/lib/youeye-state/tls"
	// RootLifetime: Caddy can't rotate a pre-placed root, so it lasts long
	// (rotation is a Backlog item before the Release).
	RootLifetime = 10 * 365 * 24 * time.Hour
	// LeafLifetime is the Preparing page's certificate (made in memory at
	// every start of the page server).
	LeafLifetime = 7 * 24 * time.Hour
	// CaddyAuthorityDir is where Caddy's "local" CA keeps its root, relative
	// to Caddy's data directory.
	CaddyAuthorityDir = "caddy/pki/authorities/local"
)

// Root is the box CA.
type Root struct {
	Cert    *x509.Certificate
	Key     crypto.Signer
	CertPEM []byte
	KeyPEM  []byte
}

// Ensure loads the root from dir, or makes and stores a new one when there is
// none (or the stored one can't be used).
func Ensure(dir string, now time.Time) (*Root, error) {
	if root, err := Load(dir); err == nil && now.Before(root.Cert.NotAfter) {
		return root, nil
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	if err := os.Chmod(dir, 0700); err != nil {
		return nil, err
	}
	// The page server and `youeye deploy` can both get here at first boot:
	// one lock, and a second look under it, so both use the same root.
	lock, err := os.OpenFile(filepath.Join(dir, ".lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return nil, err
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	if root, err := Load(dir); err == nil && now.Before(root.Cert.NotAfter) {
		return root, nil
	}
	root, err := generate(now)
	if err != nil {
		return nil, err
	}
	// Key first: a crash between the two leaves an unusable pair, which the
	// next Ensure replaces.
	if err := writeAtomic(filepath.Join(dir, "root.key"), root.KeyPEM, 0600); err != nil {
		return nil, err
	}
	if err := writeAtomic(filepath.Join(dir, "root.crt"), root.CertPEM, 0600); err != nil {
		return nil, err
	}
	return root, nil
}

// Load reads and checks the stored root.
func Load(dir string) (*Root, error) {
	certPEM, err := os.ReadFile(filepath.Join(dir, "root.crt"))
	if err != nil {
		return nil, err
	}
	keyPEM, err := os.ReadFile(filepath.Join(dir, "root.key"))
	if err != nil {
		return nil, err
	}
	return parse(certPEM, keyPEM)
}

func parse(certPEM, keyPEM []byte) (*Root, error) {
	certBlock, _ := pem.Decode(certPEM)
	keyBlock, _ := pem.Decode(keyPEM)
	if certBlock == nil || certBlock.Type != "CERTIFICATE" || keyBlock == nil {
		return nil, errors.New("box CA files are not PEM")
	}
	cert, err := x509.ParseCertificate(certBlock.Bytes)
	if err != nil {
		return nil, err
	}
	var key crypto.Signer
	switch keyBlock.Type {
	case "EC PRIVATE KEY":
		key, err = x509.ParseECPrivateKey(keyBlock.Bytes)
	case "PRIVATE KEY":
		var parsed any
		parsed, err = x509.ParsePKCS8PrivateKey(keyBlock.Bytes)
		if err == nil {
			var ok bool
			if key, ok = parsed.(crypto.Signer); !ok {
				err = errors.New("box CA key is not a signer")
			}
		}
	default:
		err = fmt.Errorf("box CA key has PEM type %q", keyBlock.Type)
	}
	if err != nil {
		return nil, err
	}
	if !cert.IsCA || !publicKeysEqual(cert.PublicKey, key.Public()) {
		return nil, errors.New("box CA certificate and key don't match")
	}
	return &Root{Cert: cert, Key: key, CertPEM: certPEM, KeyPEM: keyPEM}, nil
}

func publicKeysEqual(a, b crypto.PublicKey) bool {
	type equaler interface{ Equal(crypto.PublicKey) bool }
	if e, ok := a.(equaler); ok {
		return e.Equal(b)
	}
	return false
}

func generate(now time.Time) (*Root, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	serial, err := serialNumber()
	if err != nil {
		return nil, err
	}
	keyID, err := subjectKeyID(&key.PublicKey)
	if err != nil {
		return nil, err
	}
	template := &x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			Organization: []string{"YouEye"},
			CommonName:   fmt.Sprintf("YouEye Box CA %s", now.UTC().Format("2006-01-02")),
		},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(RootLifetime),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  true,
		// Caddy signs its own intermediate under this root.
		MaxPathLen:   1,
		SubjectKeyId: keyID,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, err
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	return parse(certPEM, keyPEM)
}

// Fingerprint is the certificate's SHA-256 as colon-separated upper-case hex,
// the form browsers and OS certificate dialogs show.
func Fingerprint(cert *x509.Certificate) string {
	sum := sha256.Sum256(cert.Raw)
	parts := make([]string, len(sum))
	for i, b := range sum {
		parts[i] = fmt.Sprintf("%02X", b)
	}
	return strings.Join(parts, ":")
}

// Leaf makes a server certificate for hosts (IP literals or DNS names),
// signed by the root.
func (r *Root) Leaf(hosts []string, now time.Time) (tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	serial, err := serialNumber()
	if err != nil {
		return tls.Certificate{}, err
	}
	template := &x509.Certificate{
		SerialNumber:   serial,
		Subject:        pkix.Name{Organization: []string{"YouEye"}, CommonName: "YouEye setup"},
		NotBefore:      now.Add(-time.Hour),
		NotAfter:       now.Add(LeafLifetime),
		KeyUsage:       x509.KeyUsageDigitalSignature,
		ExtKeyUsage:    []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		AuthorityKeyId: r.Cert.SubjectKeyId,
	}
	for _, host := range hosts {
		if ip := net.ParseIP(host); ip != nil {
			template.IPAddresses = append(template.IPAddresses, ip)
		} else if host != "" {
			template.DNSNames = append(template.DNSNames, host)
		}
	}
	if len(template.IPAddresses) == 0 && len(template.DNSNames) == 0 {
		return tls.Certificate{}, errors.New("leaf certificate needs at least one host")
	}
	der, err := x509.CreateCertificate(rand.Reader, template, r.Cert, &key.PublicKey, r.Key)
	if err != nil {
		return tls.Certificate{}, err
	}
	leaf, err := x509.ParseCertificate(der)
	if err != nil {
		return tls.Certificate{}, err
	}
	return tls.Certificate{Certificate: [][]byte{der, r.Cert.Raw}, PrivateKey: key, Leaf: leaf}, nil
}

// PlaceForCaddy gives Caddy's local CA this root when Caddy has none yet
// (Caddy then makes and renews its own intermediate under it). An existing
// Caddy root is left alone: Caddy already signed certificates with it.
func PlaceForCaddy(stateDir, caddyDataDir string, now time.Time) (bool, error) {
	target := filepath.Join(caddyDataDir, CaddyAuthorityDir)
	if _, err := os.Lstat(filepath.Join(target, "root.crt")); err == nil {
		return false, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	root, err := Ensure(stateDir, now)
	if err != nil {
		return false, err
	}
	if err := os.MkdirAll(target, 0700); err != nil {
		return false, err
	}
	if err := writeAtomic(filepath.Join(target, "root.key"), root.KeyPEM, 0600); err != nil {
		return false, err
	}
	if err := writeAtomic(filepath.Join(target, "root.crt"), root.CertPEM, 0644); err != nil {
		return false, err
	}
	return true, nil
}

func serialNumber() (*big.Int, error) {
	return rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 127))
}

func subjectKeyID(public *ecdsa.PublicKey) ([]byte, error) {
	der, err := x509.MarshalPKIXPublicKey(public)
	if err != nil {
		return nil, err
	}
	sum := sha1.Sum(der)
	return sum[:], nil
}

func writeAtomic(path string, data []byte, mode os.FileMode) error {
	if current, err := os.ReadFile(path); err == nil && bytes.Equal(current, data) {
		return os.Chmod(path, mode)
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}

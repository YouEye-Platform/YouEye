package systemupdate

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"time"
)

type CopyIncusAuthority struct {
	ServerFingerprint string `json:"server_fingerprint"`
	ClientFingerprint string `json:"client_fingerprint"`
}
type copyIncusJournal struct {
	Schema                string             `json:"schema"`
	Request               CoreCopyRequest    `json:"request"`
	Source                CopyIncusAuthority `json:"source"`
	SourceClientKeySHA256 string             `json:"source_client_key_sha256"`
	ServerCertificate     string             `json:"server_certificate"`
	ServerKey             string             `json:"server_key"`
	ClientCertificate     string             `json:"client_certificate"`
	ClientKey             string             `json:"client_key"`
	Prepared              bool               `json:"prepared"`
}

func copyCertificateFingerprint(raw []byte) (string, error) {
	block, rest := pem.Decode(raw)
	if block == nil || block.Type != "CERTIFICATE" || len(rest) != 0 {
		return "", fmt.Errorf("exact native Incus certificate required")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return "", fmt.Errorf("native Incus certificate invalid")
	}
	return copyAuthorityDigest(cert.Raw), nil
}
func inspectCopyIncusServer(ctx context.Context, p NativeCoreCheckpoint) (string, error) {
	raw, err := p.capture(ctx, "incus", "info", "--format=json")
	if err != nil {
		return "", err
	}
	var info struct {
		Config      map[string]string `json:"config"`
		Environment struct {
			Clustered   *bool  `json:"server_clustered"`
			Certificate string `json:"server_certificate"`
		} `json:"environment"`
	}
	if json.Unmarshal(raw, &info) != nil || info.Environment.Clustered == nil || *info.Environment.Clustered || info.Config["oidc.issuer"] != "" || info.Config["core.trust_ca_certificates"] == "true" {
		return "", fmt.Errorf("clustered or externally authenticated Incus requires a copy adapter")
	}
	return copyCertificateFingerprint([]byte(info.Environment.Certificate))
}
func inspectCopyIncusTrust(ctx context.Context, p NativeCoreCheckpoint, allowed ...string) (map[string]bool, error) {
	raw, err := p.capture(ctx, "incus", "config", "trust", "list", "--format=json")
	if err != nil {
		return nil, err
	}
	var records []struct {
		Fingerprint string `json:"fingerprint"`
		Type        string `json:"type"`
		Restricted  bool   `json:"restricted"`
	}
	if json.Unmarshal(raw, &records) != nil || len(records) < 1 || len(records) > 2 {
		return nil, fmt.Errorf("unsupported Incus client trust inventory")
	}
	seen := map[string]bool{}
	for _, r := range records {
		found := false
		for _, fingerprint := range allowed {
			if r.Fingerprint == fingerprint {
				found = true
			}
		}
		if !found || seen[r.Fingerprint] || r.Type != "client" || r.Restricted {
			return nil, fmt.Errorf("foreign Incus authority requires a copy adapter")
		}
		seen[r.Fingerprint] = true
	}
	return seen, nil
}
func (p NativeCoreCheckpoint) InspectCopyIncusAuthority(ctx context.Context) (CopyIncusAuthority, error) {
	var result CopyIncusAuthority
	server, err := inspectCopyIncusServer(ctx, p)
	if err != nil {
		return result, err
	}
	raw, err := ReadCoreState(filepath.Join(p.DataRoot, "incus-client/cp.crt"), 16384)
	if err != nil {
		return result, fmt.Errorf("local Incus client certificate unavailable")
	}
	client, err := copyCertificateFingerprint(raw)
	if err != nil {
		return result, err
	}
	key, err := ReadCoreState(filepath.Join(p.DataRoot, "incus-client/cp.key"), 16384)
	if err != nil {
		return result, fmt.Errorf("local Incus client authority unavailable")
	}
	if _, err = tls.X509KeyPair(raw, key); err != nil {
		return result, fmt.Errorf("local Incus client authority is inconsistent")
	}
	for _, file := range []struct {
		path     string
		expected []byte
	}{{"/etc/youeye/incus-client.crt", raw}, {"/etc/youeye/incus-client.key", key}} {
		observed, e := p.capture(ctx, "incus", "file", "pull", "youeye-control"+file.path, "-")
		if e != nil || string(observed) != string(file.expected) {
			return result, fmt.Errorf("Control Panel Incus client authority differs from host")
		}
	}
	if _, err = inspectCopyIncusTrust(ctx, p, client); err != nil {
		return result, err
	}
	if _, err = p.capture(ctx, "incus", "admin", "update-certificate", "--help"); err != nil {
		return result, fmt.Errorf("native Incus server certificate replacement unavailable")
	}
	return CopyIncusAuthority{ServerFingerprint: server, ClientFingerprint: client}, nil
}

// PrepareIndependentCopyIncus replaces only the destination's local daemon and
// CP client authority through the supported Incus trust/certificate commands.
// Unknown trusts or external identity configuration reject source preflight.
func (m CoreManager) PrepareIndependentCopyIncus(ctx context.Context, request CoreCopyRequest, b CoreLifecycleBarrier, p NativeCoreCheckpoint, observeHardware func() (string, error)) error {
	if request.Validate() != nil || observeHardware == nil {
		return fmt.Errorf("exact copy Incus context required")
	}
	hardware, err := observeHardware()
	if err != nil || hardware != request.DestinationHardware {
		return fmt.Errorf("copy Incus hardware differs")
	}
	unlock, err := m.lockCoreRaw()
	if err != nil {
		return err
	}
	defer unlock()
	copy, err := m.readCopy()
	if err != nil || copy.Request != request || copy.Phase != "verifying" {
		return fmt.Errorf("native copy admission required")
	}
	reservation, err := b.ReadCopy()
	if err != nil || reservation.Role != "destination" || reservation.Request != request {
		return fmt.Errorf("destination copy lifecycle required")
	}
	source, err := m.ReadCopySource(request)
	if err != nil || !source.Quiesced {
		return fmt.Errorf("quiesced copied inventory required")
	}
	if err = verifyCopyStoppedRuntime(ctx, p, source); err != nil {
		return err
	}
	journalPath := filepath.Join(m.Root, "copy-incus-authority.json")
	var j copyIncusJournal
	raw, err := ReadCoreState(journalPath, 65536)
	if err == nil {
		if json.Unmarshal(raw, &j) != nil || j.Schema != "youeye.copy-incus-authority.v1" || j.Request.Validate() != nil {
			return fmt.Errorf("invalid copy Incus journal")
		}
		if j.Request != request {
			var previous CoreCopyJournal
			prior, e := ReadCoreState(filepath.Join(m.Root, "copy-history", j.Request.RequestID+".json"), 4<<20)
			if e != nil || json.Unmarshal(prior, &previous) != nil || previous.Request != j.Request || previous.Phase != "committed" || j.Request.DestinationHardware != request.SourceHardware || !j.Prepared {
				return fmt.Errorf("another copy owns Incus authority")
			}
			err = os.ErrNotExist
		}
	}
	if errors.Is(err, os.ErrNotExist) {
		current, e := p.InspectCopyIncusAuthority(ctx)
		if e != nil || current != source.Resources.IncusAuthority {
			return fmt.Errorf("copy Incus authority differs from source")
		}
		serverCert, serverKey, e := newCopyTLSCertificate("youeye-copy-incus", false)
		if e != nil {
			return e
		}
		clientCert, clientKey, e := newCopyTLSCertificate("youeye-control-cp", true)
		if e != nil {
			return e
		}
		sourceKey, e := ReadCoreState(filepath.Join(p.DataRoot, "incus-client/cp.key"), 16384)
		if e != nil {
			return fmt.Errorf("source client authority unavailable")
		}
		j = copyIncusJournal{Schema: "youeye.copy-incus-authority.v1", Request: request, Source: current, SourceClientKeySHA256: copyAuthorityDigest(sourceKey), ServerCertificate: serverCert, ServerKey: serverKey, ClientCertificate: clientCert, ClientKey: clientKey}
		raw, e = json.Marshal(j)
		if e != nil {
			return e
		}
		if e = atomicWrite(journalPath, raw, 0600); e != nil {
			return e
		}
	} else if err != nil {
		return err
	}
	if j.Source != source.Resources.IncusAuthority || !validSHA256(j.SourceClientKeySHA256) {
		return fmt.Errorf("copy Incus source binding changed")
	}
	server, e := copyCertificateFingerprint([]byte(j.ServerCertificate))
	if e != nil {
		return e
	}
	client, e := copyCertificateFingerprint([]byte(j.ClientCertificate))
	if e != nil {
		return e
	}
	if _, e = tls.X509KeyPair([]byte(j.ServerCertificate), []byte(j.ServerKey)); e != nil {
		return fmt.Errorf("invalid prepared server authority")
	}
	if _, e = tls.X509KeyPair([]byte(j.ClientCertificate), []byte(j.ClientKey)); e != nil {
		return fmt.Errorf("invalid prepared client authority")
	}
	if server == j.Source.ServerFingerprint || client == j.Source.ClientFingerprint {
		return fmt.Errorf("copy retained inherited Incus authority")
	}
	observed, e := inspectCopyIncusServer(ctx, p)
	if e != nil || (observed != j.Source.ServerFingerprint && observed != server) {
		return fmt.Errorf("Incus server identity changed outside copy")
	}
	trusted, e := inspectCopyIncusTrust(ctx, p, j.Source.ClientFingerprint, client)
	if e != nil {
		return e
	}
	stage, e := os.MkdirTemp(m.Root, "copy-incus-stage-")
	if e != nil {
		return e
	}
	defer os.RemoveAll(stage) // exact private regenerable stage owned by this locked phase
	for name, value := range map[string]string{"server.crt": j.ServerCertificate, "server.key": j.ServerKey, "client.crt": j.ClientCertificate, "client.key": j.ClientKey} {
		if e = atomicWrite(filepath.Join(stage, name), []byte(value), 0600); e != nil {
			return e
		}
	}
	if !trusted[client] {
		if _, e = p.capture(ctx, "incus", "config", "trust", "add-certificate", filepath.Join(stage, "client.crt")); e != nil {
			return fmt.Errorf("copy client trust requires reconciliation")
		}
	}
	if trusted[j.Source.ClientFingerprint] {
		if _, e = p.capture(ctx, "incus", "config", "trust", "remove", j.Source.ClientFingerprint); e != nil {
			return fmt.Errorf("inherited client trust removal requires reconciliation")
		}
	}
	if _, e = inspectCopyIncusTrust(ctx, p, client); e != nil {
		return e
	}
	if observed != server {
		if _, e = p.capture(ctx, "incus", "admin", "update-certificate", filepath.Join(stage, "server.crt"), filepath.Join(stage, "server.key")); e != nil {
			return fmt.Errorf("copy server certificate requires reconciliation")
		}
	}
	if observed, e = inspectCopyIncusServer(ctx, p); e != nil || observed != server {
		return fmt.Errorf("copy server identity did not converge")
	}
	for _, file := range []struct{ host, container, value string }{{"cp.crt", "/etc/youeye/incus-client.crt", j.ClientCertificate}, {"cp.key", "/etc/youeye/incus-client.key", j.ClientKey}} {
		host := filepath.Join(p.DataRoot, "incus-client", file.host)
		local, e := ReadCoreState(host, 16384)
		if e != nil {
			return fmt.Errorf("copy client authority unavailable")
		}
		remote, e := p.capture(ctx, "incus", "file", "pull", "youeye-control"+file.container, "-")
		if e != nil {
			return fmt.Errorf("copy Control Panel authority unavailable")
		}
		for _, value := range [][]byte{local, remote} {
			if string(value) == file.value {
				continue
			}
			if file.host == "cp.crt" {
				fingerprint, e := copyCertificateFingerprint(value)
				if e != nil || fingerprint != j.Source.ClientFingerprint {
					return fmt.Errorf("client certificate changed outside copy")
				}
			} else if copyAuthorityDigest(value) != j.SourceClientKeySHA256 {
				return fmt.Errorf("client private authority changed outside copy")
			}
		}
		if e = atomicWrite(host, []byte(file.value), 0600); e != nil {
			return e
		}
		if _, e = p.capture(ctx, "incus", "file", "push", "--uid=0", "--gid=0", "--mode=0600", host, "youeye-control"+file.container); e != nil {
			return fmt.Errorf("copy control Incus authority requires reconciliation")
		}
		read, e := p.capture(ctx, "incus", "file", "pull", "youeye-control"+file.container, "-")
		if e != nil || string(read) != file.value {
			return fmt.Errorf("copy control Incus authority did not read back")
		}
	}
	j.Prepared = true
	raw, err = json.Marshal(j)
	if err != nil {
		return err
	}
	return atomicWrite(journalPath, raw, 0600)
}

func newCopyTLSCertificate(name string, client bool) (string, string, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return "", "", err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return "", "", err
	}
	template := x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: name}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().AddDate(10, 0, 0), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, DNSNames: []string{"localhost", "incus"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")}}
	if client {
		template.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}
		template.DNSNames = nil
		template.IPAddresses = nil
	}
	der, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
	if err != nil {
		return "", "", err
	}
	private, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return "", "", err
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: private})), nil
}

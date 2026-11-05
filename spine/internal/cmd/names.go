package cmd

import (
	"bytes"
	"crypto"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"os"
	"os/exec"
	"reflect"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/youeye-platform/YouEye/spine/internal/output"
)

const namesImportPath = "/opt/youeye-control-data/youeye-names/import-bundle.json"
const namesImportDir = "/opt/youeye-control-data/youeye-names"
const maxNamesBundleBytes = 1024 * 1024

type namesIdentity struct {
	Schema        int    `json:"schema,omitempty"`
	PrivateKeyPEM string `json:"privateKeyPem"`
	PublicKeyRaw  string `json:"publicKeyRaw"`
	Fingerprint   string `json:"fingerprint"`
}

type namesTLS struct {
	KeyPEM  string `json:"keyPem"`
	CertPEM string `json:"certPem"`
}

type namesCertificate struct {
	Fingerprint string  `json:"fingerprint"`
	Provider    *string `json:"provider"`
	IssuedAt    string  `json:"issuedAt"`
	ExpiresAt   string  `json:"expiresAt"`
}

type namesConsent struct {
	TermsVersion                      *string `json:"termsVersion"`
	CertificateTransparencyAcceptedAt *string `json:"certificateTransparencyAcceptedAt"`
}

type namesService struct {
	ID              string `json:"id"`
	CanonicalOrigin string `json:"canonicalOrigin"`
	APIVersion      string `json:"apiVersion"`
	ManagedZone     string `json:"managedZone"`
}

type namesBundleV3 struct {
	SchemaVersion int              `json:"schemaVersion"`
	ExportedAt    string           `json:"exportedAt"`
	Service       namesService     `json:"service"`
	Name          string           `json:"name"`
	FQDN          string           `json:"fqdn"`
	Identity      namesIdentity    `json:"identity"`
	TLS           namesTLS         `json:"tls"`
	Certificate   namesCertificate `json:"certificate"`
	Consent       namesConsent     `json:"consent"`
}

type validatedNamesBundle struct {
	Name string
	FQDN string
}

var namesCmd = &cobra.Command{
	Use:   "names",
	Short: "Manage this server's YouEye Names address and recovery bundle",
}

var (
	namesExportOutput  string
	namesExportStdout  bool
	namesImportYes     bool
	namesImportReplace bool
)

var namesExportCmd = &cobra.Command{
	Use:   "export",
	Short: "Export the protected YouEye Names recovery bundle",
	Long: "Writes the install identity, TLS key, certificate, lease and lifecycle consent needed\n" +
		"to recover the same address. The bundle contains PRIVATE KEYS. File output is\n" +
		"created mode 0600 and never overwrites an existing path. Printing the credential\n" +
		"requires the explicit --stdout flag.",
	Args: cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		if namesExportOutput == "" && !namesExportStdout {
			return fmt.Errorf("choose --output <new-file> (recommended) or explicitly use --stdout")
		}
		if namesExportOutput != "" && namesExportStdout {
			return fmt.Errorf("--output and --stdout cannot be used together")
		}
		if !requireCP() {
			return nil
		}
		data, err := controlClient.Get("/api/tls/youeye-names/export")
		if err != nil {
			return fmt.Errorf("export failed: %w", err)
		}
		pretty, err := json.MarshalIndent(data, "", "  ")
		if err != nil {
			return fmt.Errorf("encoding export: %w", err)
		}
		bundle, err := validateNamesBundle(pretty)
		if err != nil {
			return fmt.Errorf("control panel returned an invalid recovery bundle: %w", err)
		}
		pretty = append(pretty, '\n')
		if namesExportStdout {
			_, err = cmd.OutOrStdout().Write(pretty)
			return err
		}
		if err := writeNewProtectedFile(namesExportOutput, pretty); err != nil {
			return fmt.Errorf("writing %s: %w", namesExportOutput, err)
		}
		output.Success(fmt.Sprintf("Exported YouEye Names recovery bundle for %q to %s (0600 — keep it private)", bundle.FQDN, namesExportOutput))
		return nil
	},
}

var namesImportCmd = &cobra.Command{
	Use:   "import <bundle.json>",
	Short: "Validate and use a saved YouEye Name",
	Long: "With setup complete, validates the complete credential and switches the running\n" +
		"platform to its broker-provided address. Before setup, it atomically stages the\n" +
		"validated bundle mode 0600. Source files must be regular, private files; symlinks\n" +
		"and group/world-readable credentials are rejected.",
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		raw, err := readProtectedBundleFile(args[0])
		if err != nil {
			return err
		}
		bundle, err := validateNamesBundle(raw)
		if err != nil {
			return fmt.Errorf("%s is not a valid YouEye Names recovery bundle: %w", args[0], err)
		}

		state := readPlatformYaml()
		if state.SetupCompleted {
			if !requireCP() {
				return nil
			}
			if state.Domain == bundle.FQDN && !namesImportYes {
				return fmt.Errorf("the server already uses %s; rerun with --yes to re-apply its saved identity and certificate", bundle.FQDN)
			}
			if state.Domain != bundle.FQDN && !confirmURLChange(bundle.FQDN, state.Domain, false, namesImportYes) {
				return nil
			}
			var payload map[string]interface{}
			if err := json.Unmarshal(raw, &payload); err != nil {
				return fmt.Errorf("parsing bundle: %w", err)
			}
			return streamURLChange("/api/tls/youeye-names/apply", payload)
		}

		if out, err := exec.Command("incus", "exec", "youeye-control", "--", "mkdir", "-p", namesImportDir).CombinedOutput(); err != nil {
			return fmt.Errorf("preparing protected bundle directory: %v (%s)", err, strings.TrimSpace(string(out)))
		}
		if out, err := exec.Command("incus", "exec", "youeye-control", "--", "chmod", "700", namesImportDir).CombinedOutput(); err != nil {
			return fmt.Errorf("protecting bundle directory: %v (%s)", err, strings.TrimSpace(string(out)))
		}
		if !namesImportReplace {
			if err := exec.Command("incus", "exec", "youeye-control", "--", "test", "!", "-e", namesImportPath).Run(); err != nil {
				return fmt.Errorf("a staged YouEye Names bundle already exists; use --replace only if you intend to replace it")
			}
		}
		temporary := fmt.Sprintf("%s/.import-bundle.%d.tmp", namesImportDir, os.Getpid())
		_ = exec.Command("incus", "exec", "youeye-control", "--", "rm", "-f", temporary).Run()
		write := exec.Command("incus", "exec", "youeye-control", "--", "tee", temporary)
		write.Stdin = bytes.NewReader(raw)
		if out, err := write.CombinedOutput(); err != nil {
			return fmt.Errorf("staging bundle: %v (%s)", err, strings.TrimSpace(string(out)))
		}
		cleanup := func() { _ = exec.Command("incus", "exec", "youeye-control", "--", "rm", "-f", temporary).Run() }
		if out, err := exec.Command("incus", "exec", "youeye-control", "--", "chmod", "600", temporary).CombinedOutput(); err != nil {
			cleanup()
			return fmt.Errorf("protecting staged bundle: %v (%s)", err, strings.TrimSpace(string(out)))
		}
		if out, err := exec.Command("incus", "exec", "youeye-control", "--", "mv", temporary, namesImportPath).CombinedOutput(); err != nil {
			cleanup()
			return fmt.Errorf("committing staged bundle: %v (%s)", err, strings.TrimSpace(string(out)))
		}

		output.Success(fmt.Sprintf("Staged YouEye Names recovery bundle for %q — setup will validate it again before use", bundle.FQDN))
		return nil
	},
}

func readProtectedBundleFile(filename string) ([]byte, error) {
	info, err := os.Lstat(filename)
	if err != nil {
		return nil, fmt.Errorf("reading bundle %s: %w", filename, err)
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("bundle %s must be a regular file, not a symlink or device", filename)
	}
	if info.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("bundle %s permissions are %04o; run chmod 600 %s first", filename, info.Mode().Perm(), filename)
	}
	if info.Size() <= 0 || info.Size() > maxNamesBundleBytes {
		return nil, fmt.Errorf("bundle %s size must be between 1 byte and %d bytes", filename, maxNamesBundleBytes)
	}
	return os.ReadFile(filename)
}

func writeNewProtectedFile(filename string, data []byte) (returnErr error) {
	file, err := os.OpenFile(filename, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if closeErr := file.Close(); returnErr == nil && closeErr != nil {
			returnErr = closeErr
		}
		if !committed {
			_ = os.Remove(filename)
		}
	}()
	if _, err := file.Write(data); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Chmod(0o600); err != nil {
		return err
	}
	committed = true
	return nil
}

func strictDecode(data []byte, value interface{}) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		if err == nil {
			return fmt.Errorf("unexpected trailing JSON value")
		}
		return err
	}
	return nil
}

func validateNamesBundle(data []byte) (validatedNamesBundle, error) {
	if len(data) == 0 || len(data) > maxNamesBundleBytes {
		return validatedNamesBundle{}, fmt.Errorf("bundle size is outside the accepted range")
	}
	var header struct {
		SchemaVersion int `json:"schemaVersion"`
	}
	if err := json.Unmarshal(data, &header); err != nil {
		return validatedNamesBundle{}, err
	}
	if header.SchemaVersion != 3 {
		return validatedNamesBundle{}, fmt.Errorf("unsupported schema version %d", header.SchemaVersion)
	}
	var bundle namesBundleV3
	if err := strictDecode(data, &bundle); err != nil {
		return validatedNamesBundle{}, err
	}
	if _, err := time.Parse(time.RFC3339, bundle.ExportedAt); err != nil {
		return validatedNamesBundle{}, fmt.Errorf("invalid exportedAt")
	}
	if bundle.Service.ID != "youeye-names-official" || bundle.Service.CanonicalOrigin != "https://names.youeye.me" || bundle.Service.APIVersion != "v1" || bundle.Service.ManagedZone != "ui.bingo" {
		return validatedNamesBundle{}, fmt.Errorf("unsupported YouEye Names service binding")
	}
	name := bundle.Name
	fqdn := strings.ToLower(strings.TrimSuffix(bundle.FQDN, "."))
	identity := bundle.Identity
	tls := bundle.TLS
	if strings.ToLower(strings.TrimSuffix(bundle.FQDN, ".")) != bundle.FQDN || fqdn != name+"."+bundle.Service.ManagedZone {
		return validatedNamesBundle{}, fmt.Errorf("fqdn does not belong to the bundle service and name")
	}
	if name == "" || len(name) > 63 || strings.Trim(name, "abcdefghijklmnopqrstuvwxyz0123456789-") != "" || strings.HasPrefix(name, "-") || strings.HasSuffix(name, "-") {
		return validatedNamesBundle{}, fmt.Errorf("invalid lease name")
	}
	if err := validateNamesIdentity(identity); err != nil {
		return validatedNamesBundle{}, err
	}
	certificate, err := validateNamesTLS(tls, fqdn)
	if err != nil {
		return validatedNamesBundle{}, err
	}
	if identity.Schema != 1 {
		return validatedNamesBundle{}, fmt.Errorf("install identity schema must be 1")
	}
	fingerprint := sha256.Sum256(certificate.Raw)
	if strings.ToLower(strings.ReplaceAll(bundle.Certificate.Fingerprint, ":", "")) != hex.EncodeToString(fingerprint[:]) {
		return validatedNamesBundle{}, fmt.Errorf("certificate fingerprint metadata mismatch")
	}
	issuedAt, issuedErr := time.Parse(time.RFC3339, bundle.Certificate.IssuedAt)
	expiresAt, expiresErr := time.Parse(time.RFC3339, bundle.Certificate.ExpiresAt)
	if issuedErr != nil || expiresErr != nil || !issuedAt.Equal(certificate.NotBefore) || !expiresAt.Equal(certificate.NotAfter) {
		return validatedNamesBundle{}, fmt.Errorf("certificate date metadata mismatch")
	}
	if bundle.Certificate.Provider != nil && *bundle.Certificate.Provider != "letsencrypt" && *bundle.Certificate.Provider != "google-public-ca" {
		return validatedNamesBundle{}, fmt.Errorf("unsupported certificate provider metadata")
	}
	if (bundle.Consent.TermsVersion == nil) != (bundle.Consent.CertificateTransparencyAcceptedAt == nil) {
		return validatedNamesBundle{}, fmt.Errorf("incomplete certificate consent metadata")
	}
	if bundle.Consent.TermsVersion != nil {
		if *bundle.Consent.TermsVersion == "" {
			return validatedNamesBundle{}, fmt.Errorf("empty certificate terms version")
		}
		if _, err := time.Parse(time.RFC3339, *bundle.Consent.CertificateTransparencyAcceptedAt); err != nil {
			return validatedNamesBundle{}, fmt.Errorf("invalid certificate consent date")
		}
	}
	return validatedNamesBundle{Name: name, FQDN: fqdn}, nil
}

func validateNamesIdentity(identity namesIdentity) error {
	block, rest := pem.Decode([]byte(identity.PrivateKeyPEM))
	if block == nil || len(bytes.TrimSpace(rest)) != 0 || block.Type != "PRIVATE KEY" {
		return fmt.Errorf("invalid install private key PEM")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return fmt.Errorf("invalid install private key: %w", err)
	}
	privateKey, ok := parsed.(ed25519.PrivateKey)
	if !ok {
		return fmt.Errorf("install identity is not Ed25519")
	}
	publicRaw, err := base64.RawURLEncoding.DecodeString(identity.PublicKeyRaw)
	if err != nil || len(publicRaw) != ed25519.PublicKeySize || base64.RawURLEncoding.EncodeToString(publicRaw) != identity.PublicKeyRaw {
		return fmt.Errorf("invalid install public key")
	}
	if !bytes.Equal(publicRaw, privateKey.Public().(ed25519.PublicKey)) {
		return fmt.Errorf("install public/private key mismatch")
	}
	digest := sha256.Sum256(publicRaw)
	if base64.RawURLEncoding.EncodeToString(digest[:]) != identity.Fingerprint {
		return fmt.Errorf("install fingerprint mismatch")
	}
	return nil
}

func validateNamesTLS(tls namesTLS, fqdn string) (*x509.Certificate, error) {
	block, _ := pem.Decode([]byte(tls.CertPEM))
	if block == nil || block.Type != "CERTIFICATE" {
		return nil, fmt.Errorf("invalid certificate PEM")
	}
	certificate, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("invalid certificate: %w", err)
	}
	privateKey, err := parseTLSPrivateKey(tls.KeyPEM)
	if err != nil {
		return nil, err
	}
	certPublic, err := x509.MarshalPKIXPublicKey(certificate.PublicKey)
	if err != nil {
		return nil, fmt.Errorf("encoding certificate public key: %w", err)
	}
	keyPublic, err := x509.MarshalPKIXPublicKey(privateKey)
	if err != nil || !reflect.DeepEqual(certPublic, keyPublic) {
		return nil, fmt.Errorf("certificate/private key mismatch")
	}
	if err := certificate.VerifyHostname(fqdn); err != nil {
		return nil, fmt.Errorf("certificate does not cover %s", fqdn)
	}
	wildcard := "*." + fqdn
	if len(certificate.DNSNames) != 2 || !sameStringSet(certificate.DNSNames, []string{fqdn, wildcard}) {
		return nil, fmt.Errorf("certificate SANs must be exactly %s and %s", fqdn, wildcard)
	}
	return certificate, nil
}

func parseTLSPrivateKey(value string) (interface{}, error) {
	block, rest := pem.Decode([]byte(value))
	if block == nil || len(bytes.TrimSpace(rest)) != 0 {
		return nil, fmt.Errorf("invalid TLS private key PEM")
	}
	if key, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		return publicKeyOf(key)
	}
	if key, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return key.Public(), nil
	}
	if key, err := x509.ParseECPrivateKey(block.Bytes); err == nil {
		return key.Public(), nil
	}
	return nil, fmt.Errorf("unsupported TLS private key")
}

func publicKeyOf(key interface{}) (interface{}, error) {
	if value, ok := key.(crypto.Signer); ok {
		return value.Public(), nil
	}
	return nil, fmt.Errorf("unsupported TLS private key")
}

func sameStringSet(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	values := make(map[string]bool, len(left))
	for _, value := range left {
		values[strings.ToLower(strings.TrimSuffix(value, "."))] = true
	}
	for _, value := range right {
		if !values[strings.ToLower(strings.TrimSuffix(value, "."))] {
			return false
		}
	}
	return len(values) == len(right)
}

func init() {
	namesExportCmd.Flags().StringVarP(&namesExportOutput, "output", "o", "", "write to a new mode-0600 file (recommended)")
	namesExportCmd.Flags().BoolVar(&namesExportStdout, "stdout", false, "explicitly print the private recovery credential to stdout")
	namesImportCmd.Flags().BoolVarP(&namesImportYes, "yes", "y", false, "skip the URL-change confirmation (live switch)")
	namesImportCmd.Flags().BoolVar(&namesImportReplace, "replace", false, "replace an existing pre-setup staged bundle")
	namesCmd.AddCommand(namesExportCmd)
	namesCmd.AddCommand(namesImportCmd)
}

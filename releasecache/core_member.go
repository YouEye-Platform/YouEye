package releasecache

import (
	"bufio"
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

// OpenCoreBlob opens exact frozen bytes from a protected download cache. It
// must not fetch latest, follow a changed release selection or infer authority
// from the key bundled with an artifact. Downloads are separately bounded by
// CoreBlob.SizeBytes; this verifier also rejects truncation and trailing bytes.
type OpenCoreBlob func(CoreBlob) (io.ReadCloser, error)

// VerifyCoreMember authenticates one authority-scoped role. The key must be
// resolved by the host's current role policy, independently of the assembly
// signer. Aliased publication filenames do not rewrite signed checksum names.
func VerifyCoreMember(member CoreMember, key ed25519.PublicKey, open OpenCoreBlob) error {
	if len(key) != ed25519.PublicKeySize || open == nil {
		return fmt.Errorf("trusted role key and exact cache reader required")
	}
	der, err := x509.MarshalPKIXPublicKey(key)
	if err != nil {
		return err
	}
	fingerprint := sha256.Sum256(der)
	if member.KeyID != hex.EncodeToString(fingerprint[:]) {
		return fmt.Errorf("role signing authority differs from selected key")
	}
	read := func(blob CoreBlob, limit int64) ([]byte, error) {
		if err := blob.validate(member.Source, member.Tag); err != nil {
			return nil, err
		}
		if limit > 0 && blob.SizeBytes > limit {
			return nil, fmt.Errorf("core metadata exceeds limit")
		}
		f, err := open(blob)
		if err != nil {
			return nil, err
		}
		defer f.Close()
		h := sha256.New()
		var out bytes.Buffer
		var writer io.Writer = h
		if limit > 0 {
			writer = io.MultiWriter(h, &out)
		}
		n, err := io.Copy(writer, io.LimitReader(f, blob.SizeBytes))
		if err != nil || n != blob.SizeBytes || hex.EncodeToString(h.Sum(nil)) != blob.SHA256 {
			return nil, fmt.Errorf("exact core blob %s failed digest/size verification", blob.Name)
		}
		var extra [1]byte
		if n, err := f.Read(extra[:]); n != 0 || err != io.EOF {
			return nil, fmt.Errorf("core blob has trailing bytes or unreadable end")
		}
		return out.Bytes(), nil
	}
	checksums, err := read(member.Checksums, 1<<20)
	if err != nil {
		return err
	}
	signature, err := read(member.Signature, ed25519.SignatureSize)
	if err != nil {
		return err
	}
	if !ed25519.Verify(key, checksums, signature) {
		return fmt.Errorf("role checksum signature rejected")
	}
	expected := map[string]string{}
	scanner := bufio.NewScanner(bytes.NewReader(checksums))
	for scanner.Scan() {
		parts := strings.SplitN(scanner.Text(), "  ", 2)
		if len(parts) != 2 || !installationHash.MatchString(parts[0]) || !coreAssetName.MatchString(parts[1]) || expected[parts[1]] != "" {
			return fmt.Errorf("malformed signed role checksums")
		}
		expected[parts[1]] = parts[0]
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	blobs := []CoreBlob{member.Artifact, member.Provenance, member.SBOM}
	if member.DocumentSignature != nil {
		blobs = append(blobs, *member.DocumentSignature)
	}
	for _, blob := range blobs {
		if expected[blob.Name] != blob.SHA256 {
			return fmt.Errorf("%s is not bound by the role's signed checksums", blob.Name)
		}
		if _, err := read(blob, 0); err != nil {
			return err
		}
	}
	if member.DocumentSignature != nil {
		document, err := read(member.Artifact, 1<<20)
		if err != nil {
			return err
		}
		sig, err := read(*member.DocumentSignature, ed25519.SignatureSize)
		if err != nil {
			return err
		}
		if !ed25519.Verify(key, document, sig) {
			return fmt.Errorf("host manifest document signature rejected")
		}
	}
	if member.ReleaseLock != nil {
		if _, err := read(*member.ReleaseLock, 1<<20); err != nil {
			return err
		}
		provenance, err := read(member.Provenance, 1<<20)
		if err != nil {
			return err
		}
		var binding struct {
			Lock string `json:"resolved_lock_sha256"`
		}
		if json.Unmarshal(provenance, &binding) != nil || binding.Lock != member.ReleaseLock.SHA256 {
			return fmt.Errorf("resolved release lock is not bound by signed provenance")
		}
	}
	return nil
}

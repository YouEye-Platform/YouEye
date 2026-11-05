package releasecache

// Core metadata v2 separates authenticated content identity from delivery. The
// exact independently signed v1 document remains the execution compatibility
// representation during this rollout; its bytes and transaction digest do not
// change. A separately signed pair binds both representations without a cycle.

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"path"
	"reflect"
	"strings"
)

const CoreMetadataV2Schema = "youeye.core-metadata.v2"
const CoreMetadataPairSchema = "youeye.core-metadata-pair.v1"
const CoreMetadataCapability = "paired-v2"
const CoreMetadataMaxBytes = 1 << 20
const coreMetadataOfficialRepository = "https://github.com/YouEye-Platform/YouEye"

var CoreMetadataAssetNames = []string{"core-release-v2.json", "core-release-v2.json.sig", "core-compatibility.json", "core-compatibility.json.sig"}

type CoreSourceIdentity struct {
	ID         string `json:"id"`
	Authority  string `json:"authority"`
	Repository string `json:"repository"`
}
type CoreContentIdentity struct {
	Name      string `json:"name"`
	SHA256    string `json:"sha256"`
	SizeBytes int64  `json:"size_bytes"`
}
type CoreBuildOrigin struct {
	Version      string `json:"version"`
	Tag          string `json:"tag"`
	SourceCommit string `json:"source_commit"`
	InputSHA256  string `json:"input_sha256"`
	// The unchanged original signed provenance is the authority for any original
	// private-source/public-tree projection attestation. This is not a claim that
	// an original commit was present in a different publisher's Git repository.
	ProvenanceSHA256 string `json:"provenance_sha256"`
}
type CoreMetadataMember struct {
	Role              string               `json:"role"`
	Publisher         CoreSourceIdentity   `json:"publisher"`
	Branch            string               `json:"branch"`
	BuildOrigin       CoreBuildOrigin      `json:"build_origin"`
	KeyID             string               `json:"key_id"`
	DependsOn         []string             `json:"depends_on"`
	Artifact          CoreContentIdentity  `json:"artifact"`
	Checksums         CoreContentIdentity  `json:"checksums"`
	Signature         CoreContentIdentity  `json:"signature"`
	DocumentSignature *CoreContentIdentity `json:"document_signature,omitempty"`
	ReleaseLock       *CoreContentIdentity `json:"release_lock,omitempty"`
	Provenance        CoreContentIdentity  `json:"provenance"`
	SBOM              CoreContentIdentity  `json:"sbom"`
}
type CoreMetadataV2 struct {
	Schema                          string               `json:"schema"`
	Version                         string               `json:"version"`
	Tag                             string               `json:"tag"`
	Publisher                       CoreSourceIdentity   `json:"publisher"`
	Branch                          string               `json:"branch"`
	SourceCommit                    string               `json:"source_commit"`
	Channel                         string               `json:"channel"`
	Sequence                        uint64               `json:"sequence"`
	PreviousExecutionManifestSHA256 string               `json:"previous_execution_manifest_sha256,omitempty"`
	MinimumMetadataReader           int                  `json:"minimum_metadata_reader"`
	MinimumExecutionReader          int                  `json:"minimum_execution_reader"`
	ExecutionSchema                 string               `json:"execution_schema"`
	SignerSHA256                    string               `json:"signer_sha256"`
	RequiredCapabilities            []string             `json:"required_capabilities"`
	Compatibility                   CoreCompatibility    `json:"compatibility"`
	Members                         []CoreMetadataMember `json:"members"`
}
type CoreMetadataPair struct {
	Schema                   string `json:"schema"`
	SourceID                 string `json:"source_id"`
	Branch                   string `json:"branch"`
	Sequence                 uint64 `json:"sequence"`
	ExecutionManifestSHA256  string `json:"execution_manifest_sha256"`
	CanonicalManifestSHA256  string `json:"canonical_manifest_sha256"`
	NormalizedIdentitySHA256 string `json:"normalized_identity_sha256"`
	SignerSHA256             string `json:"signer_sha256"`
}

// CoreSourceBinding belongs only in protected local State/configuration. URLs
// never appear in the published v2 document or pair. Each use must independently
// resolve current overrides/revocations for the original URL, branch and scope.
type CoreSourceBinding struct {
	Identity       CoreSourceIdentity `json:"identity"`
	OriginalSource string             `json:"original_source"`
	Branch         string             `json:"branch"`
	Role           string             `json:"role"`
	KeyID          string             `json:"key_id"`
}
type CoreMetadataDocuments struct {
	Canonical          []byte `json:"canonical"`
	CanonicalSignature []byte `json:"canonical_signature"`
	Pair               []byte `json:"pair"`
	PairSignature      []byte `json:"pair_signature"`
}

// This proof is local protected state, not a published identity document. Its
// signed original metadata permits offline continuation and safe URL→ID mapping
// after every current-policy check. All []byte JSON fields use base64 encoding.
type CoreMetadataProof struct {
	Schema                  string                `json:"schema"`
	ExecutionManifestSHA256 string                `json:"execution_manifest_sha256"`
	Advertised              bool                  `json:"advertised"`
	SpineChecksums          []byte                `json:"spine_checksums"`
	SpineSignature          []byte                `json:"spine_signature"`
	SpineProvenance         []byte                `json:"spine_provenance"`
	Documents               CoreMetadataDocuments `json:"documents"`
	Bindings                []CoreSourceBinding   `json:"bindings"`
}
type CoreMetadataFacts struct {
	CanonicalManifestSHA256  string              `json:"canonical_manifest_sha256,omitempty"`
	ExecutionManifestSHA256  string              `json:"execution_manifest_sha256"`
	NormalizedIdentitySHA256 string              `json:"normalized_identity_sha256,omitempty"`
	Schema                   string              `json:"schema"`
	Bindings                 []CoreSourceBinding `json:"bindings,omitempty"`
}

func CoreSourceID(source string) (string, error) {
	if _, err := coreSource(source); err != nil {
		return "", err
	}
	h := sha256.Sum256([]byte(source))
	return hex.EncodeToString(h[:]), nil
}
func coreIdentity(source, branch, channel string) (CoreSourceIdentity, error) {
	id, err := CoreSourceID(source)
	if err != nil {
		return CoreSourceIdentity{}, err
	}
	u, _ := url.Parse(source)
	authority := "development"
	if strings.EqualFold(u.Hostname(), "github.com") {
		authority = "owner"
		if source == coreMetadataOfficialRepository {
			if branch == "main" && channel == "stable" {
				authority = "official-stable"
			} else if branch == "beta" && channel == "beta" {
				authority = "official-beta"
			} else {
				return CoreSourceIdentity{}, fmt.Errorf("unsupported official metadata authority")
			}
		}
	}
	return CoreSourceIdentity{ID: id, Authority: authority, Repository: path.Base(u.Path)}, nil
}

func CoreMetadataPublicFacts(f CoreMetadataFacts) CoreMetadataFacts { f.Bindings = nil; return f }

func VerifyCoreMetadataProof(execution, executionSig []byte, proof CoreMetadataProof, assemblyKey ed25519.PublicKey, roleKey func(CoreMember) (ed25519.PublicKey, error)) (CoreMetadataFacts, error) {
	var facts CoreMetadataFacts
	r, digest, err := VerifyCoreRelease(execution, executionSig, assemblyKey)
	if err != nil {
		return facts, err
	}
	if proof.Schema != "youeye.core-metadata-proof.v1" || proof.ExecutionManifestSHA256 != digest || roleKey == nil {
		return facts, fmt.Errorf("metadata proof differs from exact execution selection")
	}
	var spine CoreMember
	for _, m := range r.Members {
		k, err := roleKey(m)
		if err != nil {
			return facts, err
		}
		der, err := x509.MarshalPKIXPublicKey(k)
		if err != nil || metadataHash(der) != m.KeyID {
			return facts, fmt.Errorf("metadata proof current role authority differs")
		}
		if m.Role == "spine" {
			spine = m
		}
	}
	k, err := roleKey(spine)
	if err != nil {
		return facts, err
	}
	required, err := VerifyCoreSpineMetadata(spine, k, proof.SpineChecksums, proof.SpineSignature, proof.SpineProvenance)
	if err != nil {
		return facts, err
	}
	parts := [][]byte{proof.Documents.Canonical, proof.Documents.CanonicalSignature, proof.Documents.Pair, proof.Documents.PairSignature}
	present := 0
	for _, part := range parts {
		if len(part) > 0 {
			present++
		}
	}
	if present != 0 && present != 4 {
		return facts, fmt.Errorf("partial canonical metadata proof")
	}
	if (required || proof.Advertised) && present != 4 {
		return facts, fmt.Errorf("advertised canonical metadata is required")
	}
	if present == 0 {
		if len(proof.Bindings) != 0 {
			return facts, fmt.Errorf("legacy proof cannot enroll opaque identities")
		}
		return CoreMetadataFacts{Schema: CoreReleaseSchema, ExecutionManifestSHA256: digest}, nil
	}
	facts, err = VerifyCoreMetadataBundle(execution, executionSig, proof.Documents, assemblyKey, roleKey)
	if err != nil {
		return facts, err
	}
	if !reflect.DeepEqual(proof.Bindings, facts.Bindings) {
		return facts, fmt.Errorf("protected source registry differs from current authenticated bindings")
	}
	return facts, nil
}

// FetchCoreMetadataProof reads only bounded metadata. Callers bind blob delivery
// to the independently authenticated selection and document delivery to its
// configured release transport. No untrusted address or key is supplied by v2.
func FetchCoreMetadataProof(execution, executionSig []byte, assemblyKey ed25519.PublicKey, roleKey func(CoreMember) (ed25519.PublicKey, error), advertised bool, readBlob func(CoreBlob, int64) ([]byte, error), readDocument func(string, int64) ([]byte, error)) (CoreMetadataProof, CoreMetadataFacts, error) {
	var proof CoreMetadataProof
	var facts CoreMetadataFacts
	r, digest, err := VerifyCoreRelease(execution, executionSig, assemblyKey)
	if err != nil {
		return proof, facts, err
	}
	if roleKey == nil || readBlob == nil {
		return proof, facts, fmt.Errorf("current authority and scoped metadata reader required")
	}
	var spine CoreMember
	for _, m := range r.Members {
		k, err := roleKey(m)
		if err != nil {
			return proof, facts, err
		}
		der, err := x509.MarshalPKIXPublicKey(k)
		if err != nil || metadataHash(der) != m.KeyID {
			return proof, facts, fmt.Errorf("current role key differs before metadata retrieval")
		}
		if m.Role == "spine" {
			spine = m
		}
	}
	proof = CoreMetadataProof{Schema: "youeye.core-metadata-proof.v1", ExecutionManifestSHA256: digest, Advertised: advertised}
	if proof.SpineChecksums, err = readBlob(spine.Checksums, CoreMetadataMaxBytes); err != nil {
		return proof, facts, err
	}
	if proof.SpineSignature, err = readBlob(spine.Signature, 64); err != nil {
		return proof, facts, err
	}
	if proof.SpineProvenance, err = readBlob(spine.Provenance, CoreMetadataMaxBytes); err != nil {
		return proof, facts, err
	}
	k, err := roleKey(spine)
	if err != nil {
		return proof, facts, err
	}
	required, err := VerifyCoreSpineMetadata(spine, k, proof.SpineChecksums, proof.SpineSignature, proof.SpineProvenance)
	if err != nil {
		return proof, facts, err
	}
	if required || advertised {
		if readDocument == nil {
			return proof, facts, fmt.Errorf("required canonical document reader unavailable")
		}
		parts := []struct {
			name  string
			limit int64
			out   *[]byte
		}{{CoreMetadataAssetNames[0], CoreMetadataMaxBytes, &proof.Documents.Canonical}, {CoreMetadataAssetNames[1], 64, &proof.Documents.CanonicalSignature}, {CoreMetadataAssetNames[2], CoreMetadataMaxBytes, &proof.Documents.Pair}, {CoreMetadataAssetNames[3], 64, &proof.Documents.PairSignature}}
		for _, p := range parts {
			*p.out, err = readDocument(p.name, p.limit)
			if err != nil {
				return proof, facts, err
			}
		}
		facts, err = VerifyCoreMetadataBundle(execution, executionSig, proof.Documents, assemblyKey, roleKey)
		if err != nil {
			return proof, facts, err
		}
		proof.Bindings = facts.Bindings
	}
	facts, err = VerifyCoreMetadataProof(execution, executionSig, proof, assemblyKey, roleKey)
	return proof, facts, err
}
func contentIdentity(b CoreBlob) CoreContentIdentity {
	return CoreContentIdentity{Name: b.Name, SHA256: b.SHA256, SizeBytes: b.SizeBytes}
}
func CoreMetadataFromExecution(r CoreRelease) (CoreMetadataV2, error) {
	var out CoreMetadataV2
	if err := r.Validate(); err != nil {
		return out, err
	}
	publisher, err := coreIdentity(r.Source, r.Branch, r.Channel)
	if err != nil {
		return out, err
	}
	out = CoreMetadataV2{Schema: CoreMetadataV2Schema, Version: r.Version, Tag: r.Tag, Publisher: publisher, Branch: r.Branch, SourceCommit: r.SourceCommit, Channel: r.Channel, Sequence: r.Sequence, PreviousExecutionManifestSHA256: r.PreviousManifestSHA256, MinimumMetadataReader: 2, MinimumExecutionReader: 1, ExecutionSchema: CoreReleaseSchema, SignerSHA256: r.SignerSHA256, RequiredCapabilities: []string{CoreMetadataCapability}, Compatibility: r.Compatibility, Members: []CoreMetadataMember{}}
	for _, m := range r.Members {
		channel, err := CoreMemberChannel(m, r.Channel)
		if err != nil {
			return out, err
		}
		identity, err := coreIdentity(m.Source, m.Branch, channel)
		if err != nil {
			return out, err
		}
		v := CoreMetadataMember{Role: m.Role, Publisher: identity, Branch: m.Branch, BuildOrigin: CoreBuildOrigin{Version: m.BuildVersion, Tag: m.Tag, SourceCommit: m.SourceCommit, InputSHA256: m.InputSHA256, ProvenanceSHA256: m.Provenance.SHA256}, KeyID: m.KeyID, DependsOn: append([]string{}, m.DependsOn...), Artifact: contentIdentity(m.Artifact), Checksums: contentIdentity(m.Checksums), Signature: contentIdentity(m.Signature), Provenance: contentIdentity(m.Provenance), SBOM: contentIdentity(m.SBOM)}
		if m.DocumentSignature != nil {
			b := contentIdentity(*m.DocumentSignature)
			v.DocumentSignature = &b
		}
		if m.ReleaseLock != nil {
			b := contentIdentity(*m.ReleaseLock)
			v.ReleaseLock = &b
		}
		out.Members = append(out.Members, v)
	}
	return out, nil
}
func metadataJSON(v any) ([]byte, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return append(raw, '\n'), nil
}
func metadataHash(raw []byte) string { h := sha256.Sum256(raw); return hex.EncodeToString(h[:]) }
func EncodeCoreMetadataV2(r CoreRelease) ([]byte, error) {
	v, err := CoreMetadataFromExecution(r)
	if err != nil {
		return nil, err
	}
	return metadataJSON(v)
}
func decodeCoreMetadata(raw []byte, out any) error {
	if len(raw) == 0 || len(raw) > CoreMetadataMaxBytes {
		return fmt.Errorf("metadata size exceeds bound")
	}
	if err := uniqueCoreJSON(raw); err != nil {
		return err
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(out); err != nil {
		return err
	}
	if d.Decode(new(any)) != io.EOF {
		return fmt.Errorf("trailing metadata JSON")
	}
	return nil
}
func ParseCoreMetadataV2(raw []byte) (CoreMetadataV2, error) {
	var v CoreMetadataV2
	if err := decodeCoreMetadata(raw, &v); err != nil {
		return v, err
	}
	if v.Schema != CoreMetadataV2Schema || v.MinimumMetadataReader != 2 || v.MinimumExecutionReader != 1 || v.ExecutionSchema != CoreReleaseSchema || !reflect.DeepEqual(v.RequiredCapabilities, []string{CoreMetadataCapability}) {
		return v, fmt.Errorf("unsupported canonical metadata schema or capability")
	}
	// All identity fields are constrained by exact normalized comparison below.
	// Reject an address even before that comparison; delivery is caller config.
	semantic, err := json.Marshal(v)
	if err != nil {
		return v, err
	}
	if bytes.Contains(semantic, []byte("://")) {
		return v, fmt.Errorf("canonical metadata must not contain deployment addresses")
	}
	return v, nil
}
func EncodeCoreMetadataPair(execution, canonical []byte) ([]byte, error) {
	r, digest, err := ParseCoreRelease(execution)
	if err != nil {
		return nil, err
	}
	v, err := ParseCoreMetadataV2(canonical)
	if err != nil {
		return nil, err
	}
	expected, err := CoreMetadataFromExecution(r)
	if err != nil || !reflect.DeepEqual(v, expected) {
		return nil, fmt.Errorf("canonical identity differs from execution compatibility")
	}
	normal, _ := metadataJSON(expected)
	return metadataJSON(CoreMetadataPair{Schema: CoreMetadataPairSchema, SourceID: v.Publisher.ID, Branch: r.Branch, Sequence: r.Sequence, ExecutionManifestSHA256: digest, CanonicalManifestSHA256: metadataHash(canonical), NormalizedIdentitySHA256: metadataHash(normal), SignerSHA256: r.SignerSHA256})
}

// VerifyCoreMetadataBundle never accepts a class asserted by the assembly as new
// role authority. It requires independently authenticated exact v1 membership and
// resolves EVERY original source/branch/role through current owner policy. Those
// checked bindings, not bare opaque IDs, form the local trusted registry.
func VerifyCoreMetadataBundle(execution, executionSig []byte, documents CoreMetadataDocuments, assemblyKey ed25519.PublicKey, roleKey func(CoreMember) (ed25519.PublicKey, error)) (CoreMetadataFacts, error) {
	var facts CoreMetadataFacts
	r, digest, err := VerifyCoreRelease(execution, executionSig, assemblyKey)
	if err != nil {
		return facts, err
	}
	if roleKey == nil {
		return facts, fmt.Errorf("current independent role authority resolver required")
	}
	for _, m := range r.Members {
		k, err := roleKey(m)
		if err != nil {
			return facts, err
		}
		if len(k) != ed25519.PublicKeySize {
			return facts, fmt.Errorf("original role key unavailable")
		}
		der, err := x509.MarshalPKIXPublicKey(k)
		if err != nil || metadataHash(der) != m.KeyID {
			return facts, fmt.Errorf("original role authority differs from current policy")
		}
		channel, err := CoreMemberChannel(m, r.Channel)
		if err != nil {
			return facts, err
		}
		id, err := coreIdentity(m.Source, m.Branch, channel)
		if err != nil {
			return facts, err
		}
		facts.Bindings = append(facts.Bindings, CoreSourceBinding{Identity: id, OriginalSource: m.Source, Branch: m.Branch, Role: m.Role, KeyID: m.KeyID})
	}
	v, err := ParseCoreMetadataV2(documents.Canonical)
	if err != nil {
		return facts, err
	}
	expected, err := CoreMetadataFromExecution(r)
	if err != nil || !reflect.DeepEqual(v, expected) {
		return facts, fmt.Errorf("canonical identity or authority binding differs from authenticated execution")
	}
	if len(documents.CanonicalSignature) != ed25519.SignatureSize || !ed25519.Verify(assemblyKey, documents.Canonical, documents.CanonicalSignature) {
		return facts, fmt.Errorf("canonical metadata signature rejected")
	}
	var pair CoreMetadataPair
	if err = decodeCoreMetadata(documents.Pair, &pair); err != nil {
		return facts, err
	}
	expectedPairRaw, err := EncodeCoreMetadataPair(execution, documents.Canonical)
	if err != nil {
		return facts, err
	}
	var expectedPair CoreMetadataPair
	if err = json.Unmarshal(expectedPairRaw, &expectedPair); err != nil {
		return facts, err
	}
	if pair.Schema != CoreMetadataPairSchema || !reflect.DeepEqual(pair, expectedPair) {
		return facts, fmt.Errorf("signed compatibility pair identity differs")
	}
	if len(documents.PairSignature) != ed25519.SignatureSize || !ed25519.Verify(assemblyKey, documents.Pair, documents.PairSignature) {
		return facts, fmt.Errorf("compatibility pair signature rejected")
	}
	facts.Schema = CoreMetadataV2Schema
	facts.CanonicalManifestSHA256 = pair.CanonicalManifestSHA256
	facts.ExecutionManifestSHA256 = digest
	facts.NormalizedIdentitySHA256 = pair.NormalizedIdentitySHA256
	return facts, nil
}

// VerifyCoreSpineMetadata authenticates only bounded signed metadata, never the
// executable payload. The requirement flag is checksum-bound original Spine
// provenance, so stripping provider advertisements cannot cause a downgrade.
func VerifyCoreSpineMetadata(member CoreMember, key ed25519.PublicKey, checksums, signature, provenance []byte) (bool, error) {
	if member.Role != "spine" || len(checksums) > CoreMetadataMaxBytes || len(provenance) > CoreMetadataMaxBytes || len(signature) != ed25519.SignatureSize {
		return false, fmt.Errorf("bounded original Spine metadata required")
	}
	der, err := x509.MarshalPKIXPublicKey(key)
	if err != nil || metadataHash(der) != member.KeyID {
		return false, fmt.Errorf("original Spine authority differs")
	}
	for _, p := range []struct {
		b   CoreBlob
		raw []byte
	}{{member.Checksums, checksums}, {member.Signature, signature}, {member.Provenance, provenance}} {
		if int64(len(p.raw)) != p.b.SizeBytes || metadataHash(p.raw) != p.b.SHA256 {
			return false, fmt.Errorf("original Spine metadata digest differs")
		}
	}
	if !ed25519.Verify(key, checksums, signature) {
		return false, fmt.Errorf("original Spine metadata signature rejected")
	}
	seen := map[string]string{}
	for _, line := range strings.Split(strings.TrimSuffix(string(checksums), "\n"), "\n") {
		parts := strings.SplitN(line, "  ", 2)
		if len(parts) != 2 || !installationHash.MatchString(parts[0]) || !coreAssetName.MatchString(parts[1]) || seen[parts[1]] != "" {
			return false, fmt.Errorf("malformed original Spine checksums")
		}
		seen[parts[1]] = parts[0]
	}
	for _, b := range []CoreBlob{member.Artifact, member.Provenance, member.SBOM} {
		if seen[b.Name] != b.SHA256 {
			return false, fmt.Errorf("original Spine envelope lacks signed identity")
		}
	}
	if err := uniqueCoreJSON(provenance); err != nil {
		return false, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(provenance, &fields); err != nil {
		return false, fmt.Errorf("original Spine provenance is not JSON")
	}
	marker, ok := fields["core_metadata"]
	if !ok {
		return false, nil
	}
	var capability string
	if json.Unmarshal(marker, &capability) != nil || capability != CoreMetadataCapability {
		return false, fmt.Errorf("unsupported original Spine metadata capability")
	}
	return true, nil
}

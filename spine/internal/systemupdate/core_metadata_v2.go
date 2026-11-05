package systemupdate

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"

	"github.com/youeye-platform/YouEye/releasecache"
)

const CoreMetadataProofMaxBytes = 8 << 20
const CoreMetadataProofName = "core-metadata.json"

// ReadAuthenticatedCoreSelection is the shared first-deployment/read boundary.
// It retains original bytes and authenticates the announcement/pair as well as
// every member's current role authority, including genuine legacy selections.
// Neither an assembly signature nor a local source registry enrolls a role key.
func ReadAuthenticatedCoreSelection(ctx context.Context, directory, trustPath, cacheRoot string, client *http.Client) (CoreHostSelection, releasecache.CoreRelease, string, error) {
	selection, err := ReadCoreBootstrapSelection(directory, trustPath)
	if err != nil {
		return selection, releasecache.CoreRelease{}, "", err
	}
	if client == nil {
		client = ReleaseHTTPClient()
	}
	selection, _, err = EnsureCoreMetadata(ctx, selection, trustPath, cacheRoot, client, "")
	if err != nil {
		return selection, releasecache.CoreRelease{}, "", err
	}
	release, digest, err := VerifyCoreSelection(selection.Raw, selection.Signature, trustPath)
	if err != nil {
		return selection, release, digest, err
	}
	for _, member := range release.Members {
		if err := CheckCoreMemberAuthority(member, release.Channel, trustPath); err != nil {
			return selection, release, digest, err
		}
	}
	return selection, release, digest, nil
}

// ReadCoreBootstrapSelection carries the Installer's original protected bytes
// into first boot and CP handoff. A present proof must pass current policy now;
// absence is only an acquisition requirement, never evidence of legacy format.
// Call EnsureCoreMetadata before consuming a selection without a proof.
func ReadCoreBootstrapSelection(directory, trustPath string) (CoreHostSelection, error) {
	var selection CoreHostSelection
	var err error
	selection.Raw, err = ReadCoreState(filepath.Join(directory, "core-release.json"), releasecache.CoreMetadataMaxBytes)
	if err != nil {
		return selection, err
	}
	selection.Signature, err = ReadCoreState(filepath.Join(directory, "core-release.json.sig"), ed25519.SignatureSize)
	if err != nil {
		return selection, err
	}
	if _, _, err = VerifyCoreSelection(selection.Raw, selection.Signature, trustPath); err != nil {
		return selection, err
	}
	selection.MetadataProof, err = ReadCoreState(filepath.Join(directory, CoreMetadataProofName), CoreMetadataProofMaxBytes)
	if errors.Is(err, os.ErrNotExist) {
		return selection, nil
	}
	if err != nil {
		return selection, err
	}
	_, err = VerifyCoreSelectionMetadata(selection, trustPath)
	return selection, err
}

// VerifyCoreSelectionMetadata re-resolves current source/branch/role grants.
// The local URL registry is evidence derived from signed v1, never authority.
func VerifyCoreSelectionMetadata(selection CoreHostSelection, trustPath string) (releasecache.CoreMetadataFacts, error) {
	r, _, err := VerifyCoreSelection(selection.Raw, selection.Signature, trustPath)
	if err != nil {
		return releasecache.CoreMetadataFacts{}, err
	}
	key, err := CoreRoleKey(r.Source, r.Branch, r.Channel, "assembly", trustPath)
	if err != nil {
		return releasecache.CoreMetadataFacts{}, err
	}
	if len(selection.MetadataProof) == 0 || len(selection.MetadataProof) > CoreMetadataProofMaxBytes {
		return releasecache.CoreMetadataFacts{}, fmt.Errorf("authenticated core metadata proof required")
	}
	var proof releasecache.CoreMetadataProof
	decoder := json.NewDecoder(bytes.NewReader(selection.MetadataProof))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&proof); err != nil {
		return releasecache.CoreMetadataFacts{}, fmt.Errorf("invalid protected core metadata proof")
	}
	if decoder.Decode(new(any)) != io.EOF {
		return releasecache.CoreMetadataFacts{}, fmt.Errorf("trailing protected core metadata proof")
	}
	if selection.MetadataAdvertised {
		proof.Advertised = true
	}
	return releasecache.VerifyCoreMetadataProof(selection.Raw, selection.Signature, proof, key, func(m releasecache.CoreMember) (ed25519.PublicKey, error) {
		return CoreMemberKey(m, r.Channel, trustPath)
	})
}

// EnsureCoreMetadata retrieves bounded metadata only. A saved malformed proof
// fails closed; network failure cannot select the legacy execution-only path.
// Inputs is an additive, verified offline envelope, not an artifact URL override.
func EnsureCoreMetadata(ctx context.Context, selection CoreHostSelection, trustPath, cacheRoot string, client *http.Client, inputs string) (CoreHostSelection, releasecache.CoreMetadataFacts, error) {
	r, digest, err := VerifyCoreSelection(selection.Raw, selection.Signature, trustPath)
	if err != nil {
		return selection, releasecache.CoreMetadataFacts{}, err
	}
	if len(selection.MetadataProof) > 0 && inputs == "" {
		facts, err := VerifyCoreSelectionMetadata(selection, trustPath)
		return selection, facts, err
	}
	proofPath := ""
	if cacheRoot != "" {
		if !filepath.IsAbs(cacheRoot) {
			return selection, releasecache.CoreMetadataFacts{}, fmt.Errorf("absolute core metadata cache required")
		}
		proofPath = filepath.Join(cacheRoot, "metadata-v2", digest+".json")
		if inputs == "" {
			raw, e := ReadCoreState(proofPath, CoreMetadataProofMaxBytes)
			if e == nil {
				selection.MetadataProof = raw
				facts, e := VerifyCoreSelectionMetadata(selection, trustPath)
				return selection, facts, e
			}
			if !errors.Is(e, os.ErrNotExist) {
				return selection, releasecache.CoreMetadataFacts{}, e
			}
		}
	}
	key, err := CoreRoleKey(r.Source, r.Branch, r.Channel, "assembly", trustPath)
	if err != nil {
		return selection, releasecache.CoreMetadataFacts{}, err
	}
	client = CoreArtifactHTTPClient(client)
	transport, err := releasecache.CoreTransport(client.Transport, r)
	if err != nil {
		return selection, releasecache.CoreMetadataFacts{}, err
	}
	client.Transport = releasecache.Wrap(transport)
	readBlob := func(blob releasecache.CoreBlob, limit int64) ([]byte, error) {
		if inputs != "" {
			name := ""
			for _, m := range r.Members {
				if m.Role == "spine" {
					switch blob {
					case m.Checksums:
						name = "checksums"
					case m.Signature:
						name = "signature"
					case m.Provenance:
						name = "provenance"
					}
				}
			}
			if name == "" {
				return nil, fmt.Errorf("unsupported offline metadata blob")
			}
			return ReadCoreState(filepath.Join(inputs, name), limit)
		}
		return readCoreMetadata(ctx, client, blob.URL, limit)
	}
	readDocument := func(name string, limit int64) ([]byte, error) {
		if inputs != "" {
			return ReadCoreState(filepath.Join(inputs, name), limit)
		}
		return readCoreMetadata(ctx, client, r.Source+"/releases/download/"+r.Tag+"/"+name, limit)
	}
	advertised := selection.MetadataAdvertised
	if inputs != "" {
		for _, name := range releasecache.CoreMetadataAssetNames {
			if _, e := os.Lstat(filepath.Join(inputs, name)); e == nil {
				advertised = true
			} else if !errors.Is(e, os.ErrNotExist) {
				return selection, releasecache.CoreMetadataFacts{}, e
			}
		}
	}
	proof, facts, err := releasecache.FetchCoreMetadataProof(selection.Raw, selection.Signature, key, func(m releasecache.CoreMember) (ed25519.PublicKey, error) {
		return CoreMemberKey(m, r.Channel, trustPath)
	}, advertised, readBlob, readDocument)
	if err != nil {
		return selection, facts, err
	}
	selection.MetadataProof, err = json.Marshal(proof)
	if err != nil {
		return selection, facts, err
	}
	if proofPath != "" {
		if err = atomicWrite(proofPath, selection.MetadataProof, 0600); err != nil {
			return selection, facts, err
		}
	}
	return selection, facts, nil
}

// ResolveCoreReleaseWithMetadata is the installed reader entry point. Pure
// v1 parsing remains usable by the old execution journal and its recovery code.
func ResolveCoreReleaseWithMetadata(ctx context.Context, client *http.Client, policy CoreReleaseSelection, trustPath, cacheRoot string) (CoreHostSelection, releasecache.CoreRelease, string, error) {
	selection, r, digest, err := ResolveCoreRelease(ctx, client, policy, trustPath)
	if err != nil {
		return selection, r, digest, err
	}
	selection, _, err = EnsureCoreMetadata(ctx, selection, trustPath, cacheRoot, client, "")
	return selection, r, digest, err
}

// This only describes an already authenticated retained proof. It permits an
// old CP checkpoint that predates sidecars; paired releases always require one.
func coreLegacyMetadataAbsence(selection CoreHostSelection) bool {
	if len(selection.MetadataProof) == 0 {
		return true
	} // pre-migration retained v1
	var p releasecache.CoreMetadataProof
	return json.Unmarshal(selection.MetadataProof, &p) == nil && len(p.Documents.Canonical) == 0 && !p.Advertised
}

// VerifyCoreBootstrapMetadata authenticates the retained reader envelope's
// announcement and pair offline before selecting that reader. The caller must
// first enforce the existing protected bootstrap-directory ownership contract.
// This verifier is read-only; acquisition owns durable proof retention.
func VerifyCoreBootstrapMetadata(selection CoreHostSelection, trustPath, directory string) error {
	proofPath := filepath.Join(directory, CoreMetadataProofName)
	proof, err := ReadCoreState(proofPath, CoreMetadataProofMaxBytes)
	if err == nil {
		selection.MetadataProof = proof
		_, err = VerifyCoreSelectionMetadata(selection, trustPath)
		return err
	}
	if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	selection, _, err = EnsureCoreMetadata(context.Background(), selection, trustPath, "", nil, directory)
	if err != nil {
		return err
	}
	return nil
}

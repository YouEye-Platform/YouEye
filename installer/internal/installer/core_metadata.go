package installer

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"

	"github.com/youeye-platform/YouEye/releasecache"
)

const coreMetadataProofMaxBytes = 8 << 20

// The Installer has source-owned public anchors and one explicitly embedded
// development anchor. Resolve every original member independently: an assembly
// signature cannot grant its own key authority over a reused component.
func coreAssemblyKey(r releasecache.CoreRelease) (ed25519.PublicKey, error) {
	trust := embeddedApplianceDevelopmentTrust
	var err error
	if r.Source == releasecache.OfficialRepository {
		if r.Channel == "stable" && r.Branch != "main" || r.Channel == "beta" && r.Branch != "beta" {
			return nil, fmt.Errorf("core public channel differs from source branch")
		}
		trust, err = publicReleaseAnchor(r.Channel)
		if err != nil {
			return nil, err
		}
	}
	return parseEd25519PublicKey(trust)
}

func coreRoleKey(r releasecache.CoreRelease, m releasecache.CoreMember) (ed25519.PublicKey, error) {
	trust := embeddedApplianceDevelopmentTrust
	if m.Source == releasecache.OfficialRepository {
		class, err := releasecache.CoreMemberChannel(m, r.Channel)
		if err != nil {
			return nil, err
		}
		trust, err = publicReleaseAnchor(class)
		if err != nil {
			return nil, err
		}
	}
	return parseEd25519PublicKey(trust)
}

func verifyInstallerCoreProof(raw, signature, encoded []byte) error {
	if len(encoded) == 0 || len(encoded) > coreMetadataProofMaxBytes {
		return fmt.Errorf("core metadata proof missing or oversized")
	}
	var proof releasecache.CoreMetadataProof
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&proof); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return fmt.Errorf("core metadata proof has trailing data")
	}
	r, _, err := releasecache.ParseCoreRelease(raw)
	if err != nil {
		return err
	}
	key, err := coreAssemblyKey(r)
	if err != nil {
		return err
	}
	_, err = releasecache.VerifyCoreMetadataProof(raw, signature, proof, key, func(m releasecache.CoreMember) (ed25519.PublicKey, error) { return coreRoleKey(r, m) })
	return err
}

func fetchInstallerCoreProof(ctx context.Context, client *http.Client, raw, signature []byte, advertised bool) ([]byte, error) {
	r, _, err := releasecache.ParseCoreRelease(raw)
	if err != nil {
		return nil, err
	}
	key, err := coreAssemblyKey(r)
	if err != nil {
		return nil, err
	}
	// Authenticate before constructing any transport mapping or fetching metadata.
	if _, _, err = releasecache.VerifyCoreRelease(raw, signature, key); err != nil {
		return nil, err
	}
	if client == nil {
		return nil, fmt.Errorf("core metadata proof requires a metadata client")
	}
	copy := *client
	transport, err := releasecache.CoreTransport(client.Transport, r)
	if err != nil {
		return nil, err
	}
	copy.Transport = releasecache.Wrap(transport)
	read := func(name, url string, size, limit int64) ([]byte, error) {
		return readCoreAsset(ctx, &copy, applianceReleaseAsset{Name: name, BrowserDownloadURL: url, Size: size}, limit)
	}
	proof, _, err := releasecache.FetchCoreMetadataProof(raw, signature, key, func(m releasecache.CoreMember) (ed25519.PublicKey, error) {
		return coreRoleKey(r, m)
	}, advertised, func(b releasecache.CoreBlob, limit int64) ([]byte, error) {
		return read(b.Name, b.URL, b.SizeBytes, limit)
	}, func(name string, limit int64) ([]byte, error) {
		return read(name, r.Source+"/releases/download/"+r.Tag+"/"+name, 0, limit)
	})
	if err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(proof)
	if err != nil || len(encoded) > coreMetadataProofMaxBytes {
		return nil, fmt.Errorf("core metadata proof exceeds retention limit")
	}
	return encoded, nil
}

func coreMetadataAdvertised(assets []applianceReleaseAsset) bool {
	for _, asset := range assets {
		for _, name := range releasecache.CoreMetadataAssetNames {
			if asset.Name == name {
				return true
			}
		}
	}
	return false
}

// This run-owned sidecar keeps an original answer and its relative frozen cache
// binding intact. Only authenticated public metadata is stored, never secrets.
func writeCoreMetadataSidecar(proof []byte) (string, error) {
	if len(proof) == 0 || len(proof) > coreMetadataProofMaxBytes {
		return "", fmt.Errorf("bounded core metadata proof required")
	}
	f, err := os.CreateTemp("", ".youeye-core-metadata-*.json")
	if err != nil {
		return "", err
	}
	path := f.Name()
	if _, err = f.Write(proof); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		os.Remove(path)
		return "", err
	}
	return path, nil
}

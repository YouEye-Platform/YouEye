package installer

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"

	"github.com/youeye-platform/YouEye/releasecache"
)

func coreManifestDigest(raw []byte) string {
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}

func validCoreTag(tag string) bool {
	return strings.HasPrefix(tag, "youeye-v") && releasecache.ValidCoreVersion(strings.TrimPrefix(tag, "youeye-v"))
}

package releasecache

import "context"

type uncachedVerificationKey struct{}

// UncachedVerification is an explicit development diagnostic context. It
// bypasses frozen installation objects while preserving signed discovery,
// original URLs, authorized mirror mapping and all ordinary signature checks.
func UncachedVerification(ctx context.Context) context.Context {
	return context.WithValue(ctx, uncachedVerificationKey{}, true)
}

func uncachedVerification(ctx context.Context) bool {
	value, _ := ctx.Value(uncachedVerificationKey{}).(bool)
	return value
}

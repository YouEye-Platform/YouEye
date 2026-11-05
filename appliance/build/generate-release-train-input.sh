#!/bin/bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source_dir="${SOURCE_DIR:-$(cd -- "$script_dir/../.." && pwd)}"
release_lock="${RELEASE_LOCK_PATH:-$source_dir/appliance/release-lock.json}"
destination="${1:-${APPLIANCE_RELEASE_DESTINATION:-}}"

if [[ -z $destination || $# -gt 1 ]]; then
    printf 'Usage: %s DESTINATION\n' "${0##*/}" >&2
    printf 'DESTINATION is a public-neutral release-control identifier, not an endpoint.\n' >&2
    exit 2
fi

# shellcheck source=release-lock.sh
. "$script_dir/release-lock.sh"
if ! release_lock_generate_train_input "$release_lock" "$destination"; then
    printf 'Cannot generate appliance release-train input: %s\n' "$release_lock_error" >&2
    exit 1
fi

#!/bin/bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
valid="$root/appliance/build/testdata/build-inputs.json"
# shellcheck source=build-inputs.sh
. "$root/appliance/build/build-inputs.sh"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

fail() {
    printf 'FAIL: %s\n' "$*" >&2
    exit 1
}

build_inputs_validate "$valid" || fail "valid build inputs rejected: $build_inputs_error"

expect_invalid() {
    local mutation=$1 expected=$2
    jq "$mutation" "$valid" > "$work/inputs.json"
    if build_inputs_validate "$work/inputs.json"; then
        fail "invalid build inputs accepted: $mutation"
    fi
    [[ $build_inputs_error == *"$expected"* ]] || fail "$mutation error was $build_inputs_error, want $expected"
}

expect_invalid '.schema="youeye.appliance.release-lock.v1"' 'youeye.build-inputs.v1'
expect_invalid '.unexpected=true' 'youeye.build-inputs.v1'
expect_invalid 'del(.components.ui.source_date_epoch)' 'youeye.build-inputs.v1'
expect_invalid '.components.spine.signature="x"' 'youeye.build-inputs.v1'
expect_invalid '.debian_snapshot="latest"' 'snapshot'
expect_invalid '.release_source="https://forge.example.test/example/YouEye"' 'youeye.build-inputs.v1'
expect_invalid '.market={}' 'youeye.build-inputs.v1'
expect_invalid '.components.ui.source_tree="abc"' '40-character'
expect_invalid '.components.control_panel.artifact_sha256=(.components.control_panel.artifact_sha256|ascii_upcase)' '64-character'
expect_invalid '.components.spine.source_date_epoch=0' 'youeye.build-inputs.v1'
# Since 0.6.13 nothing in the inputs names a version (the shape up to 0.6.12 did).
expect_invalid '.version="0.6.13-dev.1"' 'name no version'
expect_invalid '.minimum_current_version="0.6.5-dev.2"' 'name no version'
expect_invalid '.components.ui.version="0.6.13-dev.1"' 'name no version'
if grep -q -- '-dev\.' "$valid"; then fail 'the build inputs fixture names a build'; fi

# The image build name is the image's internal identity; the line comes with it.
expect_identity() {
    local image=$1 line=$2 expected=$3
    if [[ -z $expected ]]; then
        build_inputs_identity "$image" "$line" "$work" || fail "identity $image/$line rejected: $build_inputs_error"
        return
    fi
    if build_inputs_identity "$image" "$line" "$work"; then fail "identity $image/$line accepted"; fi
    [[ $build_inputs_error == *"$expected"* ]] || fail "identity $image/$line error was $build_inputs_error, want $expected"
}
expect_identity 0.6.13-dev.1 0.6.13 ''
expect_identity 0.6.13-dev.12 0.6.13 ''
expect_identity 0.6.13 0.6.13 'X.Y.Z-dev.N'
expect_identity 0.6.13-beta.1 0.6.13 'X.Y.Z-dev.N'
expect_identity 0.6.13-dev.0 0.6.13 'X.Y.Z-dev.N'
expect_identity 0.6.13-dev.1 0.6.13-dev.1 'release line'
expect_identity 0.6.13-dev.1 '' 'release line'
expect_identity 0.6.12-dev.1 0.6.13 'not a build of the line'
printf '0.6.14\n' > "$work/VERSION"
expect_identity 0.6.13-dev.1 0.6.13 'not the line in VERSION'
expect_identity 0.6.14-dev.1 0.6.14 ''
rm "$work/VERSION"

# The real build entry validates its inputs before the dedicated-path guard.
expect_build_gate() {
    local expected=$1 output
    shift
    if output="$(env -u BUILD_INPUTS_PATH YOUEYE_VERSION="$(cat "$root/VERSION")-dev.1" YOUEYE_LINE="$(cat "$root/VERSION")" OUTPUT_DIR=/ "$@" bash "$root/appliance/build/build-appliance.sh" 2>&1)"; then
        fail 'build probe unexpectedly passed its deliberate output guard'
    fi
    [[ $output == *"$expected"* ]] || fail "build gate error was $output, want $expected"
}
expect_build_gate 'dedicated paths' BUILD_INPUTS_PATH="$valid"
expect_build_gate 'BUILD_INPUTS_PATH must name valid youeye.build-inputs.v1' BUILD_INPUTS_PATH="$work/missing.json"
jq '.schema="youeye.appliance.release-lock.v0"' "$valid" > "$work/inputs.json"
expect_build_gate 'youeye.build-inputs.v1' BUILD_INPUTS_PATH="$work/inputs.json"
expect_build_gate 'YOUEYE_VERSION must be the image build name' BUILD_INPUTS_PATH="$valid" YOUEYE_VERSION=0.6.13
expect_build_gate 'YOUEYE_LINE must be the release line' BUILD_INPUTS_PATH="$valid" YOUEYE_LINE=

printf 'PASS: youeye.build-inputs.v1 validation and build entry gate\n'

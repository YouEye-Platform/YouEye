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
expect_invalid '.version="0.6.0-Dev.1"' 'exact release version'
expect_invalid '.debian_snapshot="latest"' 'snapshot'
expect_invalid '.release_source="https://forge.example.test/example/YouEye"' 'youeye.build-inputs.v1'
expect_invalid '.market={}' 'youeye.build-inputs.v1'
expect_invalid '.components.ui.source_tree="abc"' '40-character'
expect_invalid '.components.control_panel.artifact_sha256=(.components.control_panel.artifact_sha256|ascii_upcase)' '64-character'
expect_invalid '.components.spine.source_date_epoch=0' 'youeye.build-inputs.v1'
for version in 0.5.37 0.5.37-beta.2 0.5.37-feature-one.2; do
    jq --arg v "$version" '.version=$v | .components |= with_entries(.value.version=$v)' "$valid" > "$work/inputs.json"
    build_inputs_validate "$work/inputs.json" || fail "canonical version rejected: $version: $build_inputs_error"
done
for version in 01.5.37 0.5.37-dev.0 0.5.37-dev.01 9007199254740992.0.0; do
    jq --arg v "$version" '.version=$v' "$valid" > "$work/inputs.json"
    if build_inputs_validate "$work/inputs.json"; then fail "invalid version accepted: $version"; fi
done

# The real build entry validates its inputs before the dedicated-path guard.
expect_build_gate() {
    local expected=$1 output
    shift
    if output="$(env -u BUILD_INPUTS_PATH OUTPUT_DIR=/ "$@" bash "$root/appliance/build/build-appliance.sh" 2>&1)"; then
        fail 'build probe unexpectedly passed its deliberate output guard'
    fi
    [[ $output == *"$expected"* ]] || fail "build gate error was $output, want $expected"
}
expect_build_gate 'dedicated paths' BUILD_INPUTS_PATH="$valid"
expect_build_gate 'BUILD_INPUTS_PATH must name valid youeye.build-inputs.v1' BUILD_INPUTS_PATH="$work/missing.json"
jq '.schema="youeye.appliance.release-lock.v2"' "$valid" > "$work/inputs.json"
expect_build_gate 'youeye.build-inputs.v1' BUILD_INPUTS_PATH="$work/inputs.json"

printf 'PASS: youeye.build-inputs.v1 validation and build entry gate\n'

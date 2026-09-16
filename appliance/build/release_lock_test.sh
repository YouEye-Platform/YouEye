#!/bin/bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
fixtures="$root/appliance/build/testdata/release-lock"
# shellcheck source=release-lock.sh
. "$root/appliance/build/release-lock.sh"

fail() {
    printf 'FAIL: %s\n' "$*" >&2
    exit 1
}

expect_valid() {
    local fixture=$1 mode=${2:-public}
    release_lock_validate "$fixtures/$fixture" "$mode" || fail "$fixture should validate: $release_lock_error"
}

expect_invalid() {
    local fixture=$1 expected=$2 mode=${3:-public}
    if release_lock_validate "$fixtures/$fixture" "$mode"; then
        fail "$fixture unexpectedly validated"
    fi
    [[ $release_lock_error == *"$expected"* ]] || fail "$fixture error was $release_lock_error, want $expected"
}

expect_valid valid-public.json
expect_valid valid-custom.json custom
expect_invalid missing-tag.json 'incomplete'
expect_invalid inconsistent-tag.json 'tag must exactly identify'
expect_invalid market-channel-mismatch.json 'official channel identity'
expect_invalid short-market-commit.json '40-character'
expect_invalid uppercase-checksum.json '64-character'
expect_invalid false-public-attribution.json 'official GitHub'
expect_invalid valid-custom.json 'official GitHub'

train_input="$(release_lock_generate_train_input "$fixtures/valid-public.json" 'release-candidate')" || fail "public train input failed: $release_lock_error"
jq -e '
  .adapter == "youeye.appliance.train-input.v1" and (.schema | not) and
  .provider == "github" and .channel == "development" and .destination == "release-candidate" and
  .image.tag == "appliance-dev-v0.5.6.0.2.19" and
  .image.release_source == "https://github.com/YouEye-Platform/YouEye" and
  .market.source == "https://github.com/YouEye-Platform/Market" and
  (.market.commit | test("^[0-9a-f]{40}$")) and
  ([.components.spine, .components.control_panel, .components.ui] | all(.version and .tag and (.source_commit | test("^[0-9a-f]{40}$")) and (.artifact_sha256 | test("^[0-9a-f]{64}$"))))
' <<<"$train_input" >/dev/null || fail 'public train input lost exact release identity'

if APPLIANCE_RELEASE_PROVIDER=github APPLIANCE_RELEASES_API=https://api.github.com/repos/YouEye-Platform/YouEye/releases \
    release_lock_generate_train_input "$fixtures/valid-public.json" release-candidate >/dev/null; then
    fail 'GitHub train input accepted an unnecessary releases API override'
fi
[[ $release_lock_error == *'public default releases API'* ]] || fail "unexpected GitHub override error: $release_lock_error"

custom_input="$(RELEASE_LOCK_SOURCE_MODE=custom APPLIANCE_RELEASE_PROVIDER=forgejo APPLIANCE_RELEASES_API=https://forge.example.test/api/v1/repos/example/YouEye/releases APPLIANCE_RELEASE_CHANNEL=development release_lock_generate_train_input "$fixtures/valid-custom.json" internal-candidate)" || fail "custom train input failed: $release_lock_error"
jq -e '.provider == "forgejo" and .channel == "development" and .destination == "internal-candidate" and .image.release_source == "https://forge.example.test/example/YouEye"' <<<"$custom_input" >/dev/null || fail 'custom train input lost explicit source identity'

if RELEASE_LOCK_SOURCE_MODE=custom APPLIANCE_RELEASE_PROVIDER=forgejo APPLIANCE_RELEASES_API= APPLIANCE_RELEASE_CHANNEL=development \
    release_lock_generate_train_input "$fixtures/valid-custom.json" internal-candidate >/dev/null; then
    fail 'custom provider accepted no releases API'
fi
[[ $release_lock_error == *'explicit HTTPS releases API'* ]] || fail "unexpected custom source error: $release_lock_error"

if release_lock_generate_train_input "$fixtures/valid-public.json" '../private'; then
    fail 'unsafe train destination was accepted'
fi
[[ $release_lock_error == *'public-neutral release destination'* ]] || fail "unexpected destination error: $release_lock_error"

# Exercise the real build entry without starting a build: OUTPUT_DIR=/ reaches
# the dedicated-path guard immediately after lock validation.
build_probe_dir="$(mktemp -d)"
trap 'rm -rf -- "$build_probe_dir"' EXIT
mkdir -p "$build_probe_dir/source/appliance"
cp "$fixtures/valid-custom.json" "$build_probe_dir/source/appliance/release-lock.json"
ln -s "$build_probe_dir/source/appliance/release-lock.json" "$build_probe_dir/default-alias.json"

expect_build_gate() {
    local expected=$1
    shift
    local output
    if output="$(env -u RELEASE_LOCK_PATH -u RELEASE_LOCK_SOURCE_MODE SOURCE_DIR="$build_probe_dir/source" OUTPUT_DIR=/ "$@" bash "$root/appliance/build/build-appliance.sh" 2>&1)"; then
        fail 'build probe unexpectedly passed its deliberate output guard'
    fi
    [[ $output == *"$expected"* ]] || fail "build gate error was $output, want $expected"
}
expect_build_gate 'official GitHub'
expect_build_gate 'official GitHub' RELEASE_LOCK_PATH="$build_probe_dir/default-alias.json"
expect_build_gate 'dedicated paths' RELEASE_LOCK_PATH="$fixtures/valid-custom.json"
expect_build_gate 'official GitHub' RELEASE_LOCK_PATH="$fixtures/valid-custom.json" RELEASE_LOCK_SOURCE_MODE=public
expect_build_gate '64-character' RELEASE_LOCK_PATH="$fixtures/uppercase-checksum.json"
jq '.image.release_source = "https://user:secret@forge.example.test/example/YouEye"' "$fixtures/valid-custom.json" > "$build_probe_dir/credentials.json"
expect_build_gate 'credential-free' RELEASE_LOCK_PATH="$build_probe_dir/credentials.json"

# Main uses unqualified component tags; all other branches retain their name.
jq '.image.release_branch = "main" | .market.branch = "main" |
    .components.spine.tag = ("spine-v" + .components.spine.version) |
    .components.control_panel.tag = ("cp-v" + .components.control_panel.version) |
    .components.ui.tag = ("ui-v" + .components.ui.version)' \
    "$fixtures/valid-custom.json" > "$build_probe_dir/main.json"
release_lock_validate "$build_probe_dir/main.json" custom || fail "main rejected: $release_lock_error"
expect_build_gate 'dedicated paths' RELEASE_LOCK_PATH="$build_probe_dir/main.json"
for component in spine control_panel ui; do
    jq --arg name "$component" '.components[$name].tag |= sub("-v"; "-main-v")' \
        "$build_probe_dir/main.json" > "$build_probe_dir/wrong-main.json"
    expect_build_gate 'tag must exactly identify' RELEASE_LOCK_PATH="$build_probe_dir/wrong-main.json"
done
jq '.image.release_branch = "dev"' "$build_probe_dir/main.json" > "$build_probe_dir/wrong-dev.json"
expect_build_gate 'tag must exactly identify' RELEASE_LOCK_PATH="$build_probe_dir/wrong-dev.json"

printf 'PASS: appliance release-lock validator and train input adapter\n'

public_dir=$(mktemp -d)
trap 'rm -rf -- "$public_dir" "$build_probe_dir"' EXIT
jq '.components.control_panel.source_commit = .components.spine.source_commit | .components.ui.source_commit = .components.spine.source_commit' "$fixtures/valid-public.json" > "$public_dir/lock.json"
jq '{schema:"youeye.appliance.recipe.v1", image:.image, market_branch:.market.branch}' "$public_dir/lock.json" > "$public_dir/recipe.json"
release_lock_validate_public_recipe "$public_dir/lock.json" "$public_dir/recipe.json" || fail "$release_lock_error"
jq '.image.version = "99.0.0"' "$public_dir/recipe.json" > "$public_dir/wrong.json"
if release_lock_validate_public_recipe "$public_dir/lock.json" "$public_dir/wrong.json"; then fail "public recipe allowed version drift"; fi
jq '.components.ui.source_commit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' "$public_dir/lock.json" > "$public_dir/wrong-lock.json"
if release_lock_validate_public_recipe "$public_dir/wrong-lock.json" "$public_dir/recipe.json"; then fail "public lock allowed mixed source commits"; fi
printf 'PASS: public detached lock binds the committed recipe and one source commit\n'

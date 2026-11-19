#!/bin/bash
# Appliance build-inputs validation (youeye.build-inputs.v1).
# This file is source-only: callers own their error presentation and exit policy.
#
# build-inputs.json names the Debian snapshot and the Spine, Control Panel and
# UI artifacts the image embeds or pins. Every component is identified by its
# source tree, artifact sha256 and source epoch. It names no version (Plan 12,
# from 0.6.13): the image's internal identity comes from YOUEYE_VERSION, the
# line from YOUEYE_LINE and the image floor from appliance/recipe.json. No
# repository, branch or channel is an input: a build is promoted unchanged
# through every channel. There is no signing or provenance input.

build_inputs_error=""

build_inputs_fail() {
    build_inputs_error=$1
    return 1
}

# Matches releasecache.ValidCoreVersion: X.Y.Z with an optional -token.N suffix.
build_inputs_valid_version() {
    local value=$1 numeric token number
    [[ $value =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-([a-z][a-z0-9]*(-[a-z0-9]+)*)\.([1-9][0-9]*))?$ ]] || return 1
    token=${BASH_REMATCH[5]}
    [[ ${#token} -le 63 ]] || return 1
    numeric=${value%%-*}
    [[ -z $token ]] || numeric+=.${value##*.}
    local -a numbers
    IFS=. read -r -a numbers <<<"$numeric"
    for number in "${numbers[@]}"; do
        [[ ${#number} -lt 16 || ( ${#number} -eq 16 && ( $number < 9007199254740991 || $number == 9007199254740991 ) ) ]] || return 1
    done
}

build_inputs_component_validate() {
    local inputs=$1 name=$2 tree checksum epoch
    tree="$(jq -er ".components.$name.source_tree" "$inputs")" || return 1
    checksum="$(jq -er ".components.$name.artifact_sha256" "$inputs")" || return 1
    epoch="$(jq -er ".components.$name.source_date_epoch" "$inputs")" || return 1
    [[ $tree =~ ^[0-9a-f]{40}$ ]] || build_inputs_fail "components.$name.source_tree must be an exact 40-character lowercase git tree" || return 1
    [[ $checksum =~ ^[0-9a-f]{64}$ ]] || build_inputs_fail "components.$name.artifact_sha256 must be an exact 64-character lowercase checksum" || return 1
    [[ $epoch =~ ^[1-9][0-9]*$ ]] || build_inputs_fail "components.$name.source_date_epoch must be a positive integer" || return 1
}

build_inputs_validate() {
    local inputs=$1 name
    build_inputs_error=""
    [[ -f $inputs ]] || build_inputs_fail "build inputs do not exist: $inputs" || return 1
    command -v jq >/dev/null 2>&1 || build_inputs_fail "jq is required to validate the build inputs" || return 1
    # Inputs written for builds up to 0.6.12 name versions; this build bakes none into them.
    if jq -e 'type == "object" and (has("version") or has("minimum_current_version") or
        ((.components | type) == "object" and ([.components[] | objects | has("version")] | any)))' "$inputs" >/dev/null 2>&1; then
        build_inputs_fail "build inputs name no version from 0.6.13 on (the image build name is YOUEYE_VERSION, the image floor appliance/recipe.json)" || return 1
    fi
    jq -e '
      type == "object" and
      keys == ["components", "debian_snapshot", "schema"] and
      .schema == "youeye.build-inputs.v1" and
      (.debian_snapshot | type == "string") and
      (.components | type == "object" and keys == ["control_panel", "spine", "ui"]) and
      ([.components[]] | all(type == "object" and keys == ["artifact_sha256", "source_date_epoch", "source_tree"] and
        ([.artifact_sha256, .source_tree] | all(type == "string")) and
        (.source_date_epoch | type == "number" and floor == . and . > 0)))
    ' "$inputs" >/dev/null || build_inputs_fail "build inputs are incomplete or do not match youeye.build-inputs.v1" || return 1

    [[ $(jq -r .debian_snapshot "$inputs") =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || build_inputs_fail "debian_snapshot must be an exact UTC snapshot timestamp" || return 1
    for name in spine control_panel ui; do
        build_inputs_component_validate "$inputs" "$name" || return 1
    done
}

# build_inputs_identity <image version> <line> <source dir>: the image build
# name (X.Y.Z-dev.N, the image's internal identity, never shown) must be a
# build of the line, and the line the one in VERSION when the source has it.
build_inputs_identity() {
    local image=$1 line=$2 source=$3
    build_inputs_error=""
    [[ $line =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] && build_inputs_valid_version "$line" || \
        build_inputs_fail "YOUEYE_LINE must be the release line X.Y.Z" || return 1
    [[ $image =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-dev\.[1-9][0-9]*$ ]] && build_inputs_valid_version "$image" || \
        build_inputs_fail "YOUEYE_VERSION must be the image build name X.Y.Z-dev.N" || return 1
    [[ ${image%%-*} == "$line" ]] || build_inputs_fail "YOUEYE_VERSION $image is not a build of the line $line" || return 1
    if [[ -f $source/VERSION && $line != "$(tr -d '[:space:]' < "$source/VERSION")" ]]; then
        build_inputs_fail "YOUEYE_LINE $line is not the line in VERSION" || return 1
    fi
}

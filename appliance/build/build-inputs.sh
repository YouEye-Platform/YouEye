#!/bin/bash
# Appliance build-inputs validation (youeye.build-inputs.v1).
# This file is source-only: callers own their error presentation and exit policy.
#
# build-inputs.json names the exact image version, Debian snapshot and the
# Spine, Control Panel and UI artifacts the image embeds or pins. Every
# component is identified by version, source tree, artifact sha256 and source
# epoch. No repository, branch or channel is an input: a build is promoted
# unchanged through every channel. There is no signing or provenance input.

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
    local inputs=$1 name=$2 version tree checksum epoch
    version="$(jq -er ".components.$name.version" "$inputs")" || return 1
    tree="$(jq -er ".components.$name.source_tree" "$inputs")" || return 1
    checksum="$(jq -er ".components.$name.artifact_sha256" "$inputs")" || return 1
    epoch="$(jq -er ".components.$name.source_date_epoch" "$inputs")" || return 1
    build_inputs_valid_version "$version" || build_inputs_fail "components.$name.version must be an exact release version" || return 1
    [[ $tree =~ ^[0-9a-f]{40}$ ]] || build_inputs_fail "components.$name.source_tree must be an exact 40-character lowercase git tree" || return 1
    [[ $checksum =~ ^[0-9a-f]{64}$ ]] || build_inputs_fail "components.$name.artifact_sha256 must be an exact 64-character lowercase checksum" || return 1
    [[ $epoch =~ ^[1-9][0-9]*$ ]] || build_inputs_fail "components.$name.source_date_epoch must be a positive integer" || return 1
}

build_inputs_validate() {
    local inputs=$1 name
    build_inputs_error=""
    [[ -f $inputs ]] || build_inputs_fail "build inputs do not exist: $inputs" || return 1
    command -v jq >/dev/null 2>&1 || build_inputs_fail "jq is required to validate the build inputs" || return 1
    jq -e '
      type == "object" and
      keys == ["components", "debian_snapshot", "minimum_current_version", "schema", "version"] and
      .schema == "youeye.build-inputs.v1" and
      ([.version, .debian_snapshot, .minimum_current_version] | all(type == "string")) and
      (.components | type == "object" and keys == ["control_panel", "spine", "ui"]) and
      ([.components[]] | all(type == "object" and keys == ["artifact_sha256", "source_date_epoch", "source_tree", "version"] and
        ([.artifact_sha256, .source_tree, .version] | all(type == "string")) and
        (.source_date_epoch | type == "number" and floor == . and . > 0)))
    ' "$inputs" >/dev/null || build_inputs_fail "build inputs are incomplete or do not match youeye.build-inputs.v1" || return 1

    build_inputs_valid_version "$(jq -r .version "$inputs")" || build_inputs_fail "version must be an exact release version" || return 1
    build_inputs_valid_version "$(jq -r .minimum_current_version "$inputs")" || build_inputs_fail "minimum_current_version must be an exact release version" || return 1
    [[ $(jq -r .debian_snapshot "$inputs") =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || build_inputs_fail "debian_snapshot must be an exact UTC snapshot timestamp" || return 1
    for name in spine control_panel ui; do
        build_inputs_component_validate "$inputs" "$name" || return 1
    done
}

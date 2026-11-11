#!/bin/bash
# Appliance build-inputs validation (youeye.build-inputs.v1).
# This file is source-only: callers own their error presentation and exit policy.
#
# build-inputs.json names the exact image version, Debian snapshot, Market
# commit and the Spine, Control Panel and UI release artifacts the image embeds
# or pins. Every component is identified by version, tag, source commit, artifact
# sha256 and source epoch. There is no signing or provenance input.

build_inputs_error=""

build_inputs_fail() {
    build_inputs_error=$1
    return 1
}

build_inputs_valid_https_repository() {
    local value=$1
    [[ $value =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/[A-Za-z0-9._~-]+/[A-Za-z0-9._~-]+$ ]] || return 1
    [[ $value != *'@'* && $value != *'?'* && $value != *'#'* ]] || return 1
}

build_inputs_valid_branch() {
    local branch=$1 component
    [[ -n $branch && ${#branch} -le 128 && $branch != *'\\'* && $branch != *'%'* && $branch != *'..'* && $branch != */ && $branch != /* ]] || return 1
    IFS=/ read -r -a components <<<"$branch"
    for component in "${components[@]}"; do
        [[ -n $component && $component != . && $component != .. && $component != .* && $component != *. && $component != *.lock && $component =~ ^[A-Za-z0-9._-]+$ ]] || return 1
    done
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
    local inputs=$1 name=$2 version tag commit checksum epoch
    version="$(jq -er ".components.$name.version" "$inputs")" || return 1
    tag="$(jq -er ".components.$name.tag" "$inputs")" || return 1
    commit="$(jq -er ".components.$name.source_commit" "$inputs")" || return 1
    checksum="$(jq -er ".components.$name.artifact_sha256" "$inputs")" || return 1
    epoch="$(jq -er ".components.$name.source_date_epoch" "$inputs")" || return 1
    build_inputs_valid_version "$version" || build_inputs_fail "components.$name.version must be an exact release version" || return 1
    [[ $tag == "youeye-v$version" ]] || build_inputs_fail "components.$name.tag must be youeye-v<version>" || return 1
    [[ $commit =~ ^[0-9a-f]{40}$ ]] || build_inputs_fail "components.$name.source_commit must be an exact 40-character lowercase commit" || return 1
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
      keys == ["components", "debian_snapshot", "market", "minimum_current_version", "release_branch", "release_source", "schema", "version"] and
      .schema == "youeye.build-inputs.v1" and
      ([.version, .debian_snapshot, .minimum_current_version, .release_source, .release_branch] | all(type == "string")) and
      (.market | type == "object" and keys == ["branch", "commit", "source"] and ([.[]] | all(type == "string"))) and
      (.components | type == "object" and keys == ["control_panel", "spine", "ui"]) and
      ([.components[]] | all(type == "object" and keys == ["artifact_sha256", "source_commit", "source_date_epoch", "tag", "version"] and
        ([.artifact_sha256, .source_commit, .tag, .version] | all(type == "string")) and
        (.source_date_epoch | type == "number" and floor == . and . > 0)))
    ' "$inputs" >/dev/null || build_inputs_fail "build inputs are incomplete or do not match youeye.build-inputs.v1" || return 1

    build_inputs_valid_version "$(jq -r .version "$inputs")" || build_inputs_fail "version must be an exact release version" || return 1
    build_inputs_valid_version "$(jq -r .minimum_current_version "$inputs")" || build_inputs_fail "minimum_current_version must be an exact release version" || return 1
    [[ $(jq -r .debian_snapshot "$inputs") =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || build_inputs_fail "debian_snapshot must be an exact UTC snapshot timestamp" || return 1
    build_inputs_valid_https_repository "$(jq -r .release_source "$inputs")" || build_inputs_fail "release_source must be a credential-free HTTPS repository URL" || return 1
    build_inputs_valid_branch "$(jq -r .release_branch "$inputs")" || build_inputs_fail "release_branch is not a safe release branch" || return 1
    build_inputs_valid_https_repository "$(jq -r .market.source "$inputs")" || build_inputs_fail "market.source must be a credential-free HTTPS repository URL" || return 1
    build_inputs_valid_branch "$(jq -r .market.branch "$inputs")" || build_inputs_fail "market.branch is not a safe branch" || return 1
    [[ $(jq -r .market.commit "$inputs") =~ ^[0-9a-f]{40}$ ]] || build_inputs_fail "market.commit must be an exact 40-character lowercase commit" || return 1
    for name in spine control_panel ui; do
        build_inputs_component_validate "$inputs" "$name" || return 1
    done
}

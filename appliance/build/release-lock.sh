#!/bin/bash
# Shared appliance release-lock validation and deterministic train-input adapter.
# This file is source-only: callers own their error presentation and exit policy.

release_lock_error=""

release_lock_fail() {
    release_lock_error=$1
    return 1
}

release_lock_valid_https_repository() {
    local value=$1
    [[ $value =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/[A-Za-z0-9._~-]+/[A-Za-z0-9._~-]+$ ]] || return 1
    [[ $value != *'@'* && $value != *'?'* && $value != *'#'* ]] || return 1
}

release_lock_valid_https_releases_api() {
    local value=$1
    [[ $value =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~-]+)+/releases$ ]] || return 1
    [[ $value != *'@'* && $value != *'?'* && $value != *'#'* ]] || return 1
}

release_lock_valid_branch() {
    local branch=$1 component
    [[ -n $branch && ${#branch} -le 96 && $branch != *'\\'* && $branch != *'%'* ]] || return 1
    IFS=/ read -r -a components <<<"$branch"
    for component in "${components[@]}"; do
        [[ -n $component && $component != . && $component != .. && $component != .* && $component != *. && $component != *.lock && $component =~ ^[a-z0-9._-]+$ ]] || return 1
    done
}

release_lock_valid_version() {
    [[ $1 =~ ^[0-9]+(\.[0-9]+)+$ ]]
}

release_lock_valid_commit() {
    [[ $1 =~ ^[0-9a-f]{40}$ ]]
}

release_lock_valid_sha256() {
    [[ $1 =~ ^[0-9a-f]{64}$ ]]
}

release_lock_component_validate() {
    local lock=$1 name=$2 branch=$3 version tag commit checksum epoch branch_prefix
    branch_prefix="${branch}-"
    [[ $branch != main ]] || branch_prefix=""
    version="$(jq -er ".components.$name.version" "$lock")" || return 1
    tag="$(jq -er ".components.$name.tag" "$lock")" || return 1
    commit="$(jq -er ".components.$name.source_commit" "$lock")" || return 1
    checksum="$(jq -er ".components.$name.artifact_sha256" "$lock")" || return 1
    epoch="$(jq -er ".components.$name.source_date_epoch // empty" "$lock")" || true

    release_lock_valid_version "$version" || release_lock_fail "components.$name.version must be an exact dotted version" || return 1
    case "$name" in
        spine) [[ $tag == "spine-${branch_prefix}v${version}" ]] ;;
        control_panel) [[ $tag == "cp-${branch_prefix}v${version}" ]] ;;
        ui) [[ $tag == "ui-${branch_prefix}v${version}" ]] ;;
    esac || release_lock_fail "components.$name.tag must exactly identify its release branch and version" || return 1
    release_lock_valid_commit "$commit" || release_lock_fail "components.$name.source_commit must be an exact 40-character lowercase commit" || return 1
    release_lock_valid_sha256 "$checksum" || release_lock_fail "components.$name.artifact_sha256 must be an exact 64-character lowercase checksum" || return 1
    if [[ $name == spine ]]; then
        [[ $epoch =~ ^[1-9][0-9]*$ ]] || release_lock_fail "components.spine.source_date_epoch must be a positive integer" || return 1
    fi
}

release_lock_validate() {
    local lock=$1 source_mode=${2:-${RELEASE_LOCK_SOURCE_MODE:-public}}
    local release_source market_source release_branch market_branch image_version minimum_version snapshot market_commit
    release_lock_error=""
    [[ -f $lock ]] || release_lock_fail "release lock does not exist: $lock" || return 1
    command -v jq >/dev/null 2>&1 || release_lock_fail "jq is required to validate the appliance release lock" || return 1

    jq -e '
      type == "object" and
      keys == ["components", "image", "market", "schema"] and
      .schema == "youeye.appliance.release-lock.v1" and
      (.image | type == "object" and keys == ["debian_snapshot", "minimum_current_version", "release_branch", "release_source", "version"]) and
      (.market | type == "object" and keys == ["branch", "commit", "source"]) and
      (.components | type == "object" and keys == ["control_panel", "spine", "ui"]) and
      ([.image.version, .image.minimum_current_version, .image.release_source, .image.release_branch, .image.debian_snapshot, .market.source, .market.branch, .market.commit] | all(type == "string")) and
      (.components.spine | type == "object" and keys == ["artifact_sha256", "source_commit", "source_date_epoch", "tag", "version"]) and
      ([.components.control_panel, .components.ui] | all(type == "object" and keys == ["artifact_sha256", "source_commit", "tag", "version"])) and
      ([.components.spine.version, .components.spine.tag, .components.spine.source_commit, .components.spine.artifact_sha256, .components.control_panel.version, .components.control_panel.tag, .components.control_panel.source_commit, .components.control_panel.artifact_sha256, .components.ui.version, .components.ui.tag, .components.ui.source_commit, .components.ui.artifact_sha256] | all(type == "string")) and
      (.components.spine.source_date_epoch | type == "number" and floor == . and . > 0)
    ' "$lock" >/dev/null || release_lock_fail "release lock is incomplete or does not match youeye.appliance.release-lock.v1" || return 1

    image_version="$(jq -er '.image.version' "$lock")"
    minimum_version="$(jq -er '.image.minimum_current_version' "$lock")"
    release_source="$(jq -er '.image.release_source' "$lock")"
    release_branch="$(jq -er '.image.release_branch' "$lock")"
    snapshot="$(jq -er '.image.debian_snapshot' "$lock")"
    market_source="$(jq -er '.market.source' "$lock")"
    market_branch="$(jq -er '.market.branch' "$lock")"
    market_commit="$(jq -er '.market.commit' "$lock")"

    release_lock_valid_version "$image_version" || release_lock_fail "image.version must be an exact dotted version" || return 1
    release_lock_valid_version "$minimum_version" || release_lock_fail "image.minimum_current_version must be an exact dotted version" || return 1
    release_lock_valid_branch "$release_branch" || release_lock_fail "image.release_branch is not a safe release branch" || return 1
    [[ $snapshot =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || release_lock_fail "image.debian_snapshot must be an exact UTC snapshot timestamp" || return 1
    [[ $market_branch == main || ( $release_branch == beta && $market_branch == beta ) ]] || release_lock_fail "market.branch must match the official channel identity (main or the selected beta channel)" || return 1
    release_lock_valid_commit "$market_commit" || release_lock_fail "market.commit must be an exact 40-character lowercase commit" || return 1

    case "$source_mode" in
        public)
            [[ $release_source == https://github.com/YouEye-Platform/YouEye && $market_source == https://github.com/YouEye-Platform/Market ]] ||
                release_lock_fail "public release locks must use the official GitHub YouEye and Market sources" || return 1
            ;;
        custom)
            release_lock_valid_https_repository "$release_source" || release_lock_fail "custom image.release_source must be a credential-free HTTPS repository URL" || return 1
            release_lock_valid_https_repository "$market_source" || release_lock_fail "custom market.source must be a credential-free HTTPS repository URL" || return 1
            ;;
        *) release_lock_fail "RELEASE_LOCK_SOURCE_MODE must be public or custom" || return 1 ;;
    esac

    release_lock_component_validate "$lock" spine "$release_branch" || return 1
    release_lock_component_validate "$lock" control_panel "$release_branch" || return 1
    release_lock_component_validate "$lock" ui "$release_branch" || return 1
}

release_lock_channel_for_branch() {
    case "$1" in
        main) printf 'stable\n' ;;
        dev) printf 'development\n' ;;
        *) printf 'branch\n' ;;
    esac
}

release_lock_image_tag() {
    local branch=$1 version=$2
    case "$branch" in
        main) printf 'appliance-v%s\n' "$version" ;;
        dev) printf 'appliance-dev-v%s\n' "$version" ;;
        *) printf 'appliance-%s-v%s\n' "$branch" "$version" ;;
    esac
}

release_lock_generate_train_input() {
    local lock=$1 destination=$2 source_mode=${RELEASE_LOCK_SOURCE_MODE:-public}
    local provider=${APPLIANCE_RELEASE_PROVIDER:-github} channel=${APPLIANCE_RELEASE_CHANNEL:-}
    local releases_api=${APPLIANCE_RELEASES_API:-} release_branch image_version image_tag market_source market_branch market_commit

    release_lock_validate "$lock" "$source_mode" || return 1
    [[ $destination =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$ && $destination != *'..'* && $destination != */ ]] ||
        release_lock_fail "destination must be a public-neutral release destination identifier" || return 1
    release_branch="$(jq -er '.image.release_branch' "$lock")"
    image_version="$(jq -er '.image.version' "$lock")"
    image_tag="$(release_lock_image_tag "$release_branch" "$image_version")"
    market_source="$(jq -er '.market.source' "$lock")"
    market_branch="$(jq -er '.market.branch' "$lock")"
    market_commit="$(jq -er '.market.commit' "$lock")"
    [[ -n $channel ]] || channel="$(release_lock_channel_for_branch "$release_branch")"

    case "$provider" in
        github)
            [[ -z $releases_api ]] || release_lock_fail "GitHub uses the public default releases API; do not provide APPLIANCE_RELEASES_API" || return 1
            [[ $source_mode == public ]] || release_lock_fail "custom source mode requires an explicit forgejo or custom provider" || return 1
            ;;
        forgejo|custom)
            [[ $source_mode == custom && -n $releases_api ]] || release_lock_fail "$provider requires custom source mode and an explicit HTTPS releases API" || return 1
            release_lock_valid_https_releases_api "$releases_api" || release_lock_fail "APPLIANCE_RELEASES_API must be a credential-free HTTPS repository releases URL" || return 1
            ;;
        *) release_lock_fail "APPLIANCE_RELEASE_PROVIDER must be github, forgejo, or custom" || return 1 ;;
    esac
    case "$channel" in
        stable) [[ $release_branch == main ]] || release_lock_fail "stable channel requires image.release_branch main" || return 1 ;;
        development) [[ $release_branch == dev ]] || release_lock_fail "development channel requires image.release_branch dev" || return 1 ;;
        branch) [[ $release_branch != main && $release_branch != dev ]] || release_lock_fail "branch channel requires a non-default image.release_branch" || return 1 ;;
        *) release_lock_fail "APPLIANCE_RELEASE_CHANNEL must be stable, development, or branch" || return 1 ;;
    esac

    jq -S -n \
        --arg provider "$provider" --arg channel "$channel" --arg destination "$destination" \
        --arg release_source "$(jq -er '.image.release_source' "$lock")" --arg release_branch "$release_branch" --arg image_version "$image_version" --arg image_tag "$image_tag" \
        --arg market_source "$market_source" --arg market_branch "$market_branch" --arg market_commit "$market_commit" \
        --slurpfile components <(jq -S '.components' "$lock") \
        '{adapter:"youeye.appliance.train-input.v1",provider:$provider,channel:$channel,destination:$destination,image:{version:$image_version,tag:$image_tag,release_source:$release_source,release_branch:$release_branch},market:{source:$market_source,branch:$market_branch,commit:$market_commit},components:$components[0]}'
}

# Public source commits contain a recipe; only the detached release lock may
# contain final component hashes. Match every recipe field before any build.
release_lock_validate_public_recipe() {
    local lock=$1 recipe=$2
    [[ -f $recipe ]] || release_lock_fail "public source recipe is missing" || return 1
    jq -e --slurpfile recipe "$recipe" '
      ($recipe | length == 1) and
      ($recipe[0] | keys == ["image", "market_branch", "schema"] and .schema == "youeye.appliance.recipe.v1") and
      .image == $recipe[0].image and .market.branch == $recipe[0].market_branch and
      .components.spine.source_commit == .components.control_panel.source_commit and
      .components.spine.source_commit == .components.ui.source_commit
    ' "$lock" >/dev/null || release_lock_fail "public resolved lock differs from its committed recipe or component source" || return 1
}

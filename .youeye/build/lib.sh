#!/bin/bash
set -euo pipefail

youeye_build_fail() {
    printf 'youeye-build: %s\n' "$*" >&2
    exit 1
}

youeye_require_command() {
    command -v "$1" >/dev/null 2>&1 || youeye_build_fail "required command is missing: $1"
}

youeye_prepare_contract() {
    local script_dir
    script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[1]}")" && pwd)"
    YOUEYE_SOURCE_DIR="${YOUEYE_SOURCE_DIR:-$(cd -- "$script_dir/../.." && pwd)}"
    YOUEYE_OUTPUT_DIR="${YOUEYE_OUTPUT_DIR:-}"
    YOUEYE_WORK_DIR="${YOUEYE_WORK_DIR:-}"
    YOUEYE_SOURCE_TREE="${YOUEYE_SOURCE_TREE:-}"
    YOUEYE_VERSION="${YOUEYE_VERSION:-}"
    SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-}"

    [[ -d $YOUEYE_SOURCE_DIR ]] || youeye_build_fail 'YOUEYE_SOURCE_DIR must be an existing source directory'
    [[ -n $YOUEYE_OUTPUT_DIR && $YOUEYE_OUTPUT_DIR != / && $YOUEYE_OUTPUT_DIR != "$YOUEYE_SOURCE_DIR" ]] || \
        youeye_build_fail 'YOUEYE_OUTPUT_DIR must be a dedicated non-root directory'
    [[ -n $YOUEYE_WORK_DIR && $YOUEYE_WORK_DIR != / && $YOUEYE_WORK_DIR != "$YOUEYE_SOURCE_DIR" ]] || \
        youeye_build_fail 'YOUEYE_WORK_DIR must be a dedicated non-root directory'
    # The full build version (X.Y.Z-rc.N) comes from the publish tool; the
    # source tree only holds the line in VERSION.
    [[ $YOUEYE_VERSION =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-rc\.[1-9][0-9]*$ ]] || \
        youeye_build_fail 'YOUEYE_VERSION must be the build version X.Y.Z-rc.N'
    if [[ -f $YOUEYE_SOURCE_DIR/VERSION && ${YOUEYE_VERSION%%-*} != "$(tr -d '[:space:]' < "$YOUEYE_SOURCE_DIR/VERSION")" ]]; then
        youeye_build_fail "YOUEYE_VERSION $YOUEYE_VERSION is not a build of the line in VERSION"
    fi

    # A build is identified by its git tree, the same on every host.
    local git_tree
    if git_tree="$(git -C "$YOUEYE_SOURCE_DIR" rev-parse 'HEAD^{tree}' 2>/dev/null)"; then
        if [[ -n $YOUEYE_SOURCE_TREE && $YOUEYE_SOURCE_TREE != "$git_tree" ]]; then
            youeye_build_fail 'YOUEYE_SOURCE_TREE does not match the checked-out source tree'
        fi
        YOUEYE_SOURCE_TREE="$git_tree"
        if [[ -z $SOURCE_DATE_EPOCH ]]; then
            SOURCE_DATE_EPOCH="$(git -C "$YOUEYE_SOURCE_DIR" show -s --format=%ct HEAD)"
        fi
    fi
    [[ $YOUEYE_SOURCE_TREE =~ ^[0-9a-f]{40}$ ]] || \
        youeye_build_fail 'YOUEYE_SOURCE_TREE must be the exact 40-character source tree'
    [[ $SOURCE_DATE_EPOCH =~ ^[1-9][0-9]*$ ]] || \
        youeye_build_fail 'SOURCE_DATE_EPOCH must be a positive integer'

    install -d -m 0755 "$YOUEYE_OUTPUT_DIR" "$YOUEYE_WORK_DIR"
    export YOUEYE_SOURCE_DIR YOUEYE_OUTPUT_DIR YOUEYE_WORK_DIR YOUEYE_SOURCE_TREE YOUEYE_VERSION SOURCE_DATE_EPOCH
    export LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC
}

youeye_require_pnpm() {
    youeye_require_command node
    youeye_require_command pnpm
    local actual
    actual="$(pnpm --version)"
    [[ $actual == 10.6.2 ]] || youeye_build_fail "pnpm 10.6.2 is required; found $actual"
	[[ -n ${YOUEYE_PNPM_STORE_DIR:-} && -d $YOUEYE_PNPM_STORE_DIR ]] || \
		youeye_build_fail 'YOUEYE_PNPM_STORE_DIR must select the reviewed shared content-addressed store'
}

youeye_find_standalone_root() {
    local root=$1
    if [[ -f $root/server.js ]]; then
        printf '%s\n' "$root"
        return
    fi
    local -a matches=()
    mapfile -d '' matches < <(find "$root" -mindepth 1 -maxdepth 5 \( -type d \( -name node_modules -o -name .next -o -name public \) -prune \) -o \( -type f -name server.js -print0 \))
    [[ ${#matches[@]} -eq 1 ]] || \
        youeye_build_fail "expected exactly one standalone server.js under $root; found ${#matches[@]}"
    dirname -- "${matches[0]}"
}

youeye_package_standalone() {
    local standalone_root=$1
    local output=$YOUEYE_OUTPUT_DIR/standalone.tar
    local temporary=$YOUEYE_WORK_DIR/standalone.tar.partial
    [[ -f $standalone_root/server.js ]] || youeye_build_fail 'standalone server.js is missing'
    node --check "$standalone_root/server.js" >/dev/null
    rm -f -- "$temporary" "$output"
    tar --sort=name --format=posix --numeric-owner --owner=0 --group=0 \
        --mtime="@$SOURCE_DATE_EPOCH" --pax-option=delete=atime,delete=ctime \
        -C "$standalone_root" -cf "$temporary" .
    [[ -s $temporary ]] || youeye_build_fail 'standalone.tar is empty'
    tar -tf "$temporary" ./server.js >/dev/null || youeye_build_fail 'standalone.tar is not rooted at server.js'
    mv -- "$temporary" "$output"
    sha256sum "$output"
}

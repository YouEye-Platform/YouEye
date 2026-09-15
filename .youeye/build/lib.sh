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
    YOUEYE_SOURCE_COMMIT="${YOUEYE_SOURCE_COMMIT:-}"
    SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-}"

    [[ -d $YOUEYE_SOURCE_DIR ]] || youeye_build_fail 'YOUEYE_SOURCE_DIR must be an existing source directory'
    [[ -n $YOUEYE_OUTPUT_DIR && $YOUEYE_OUTPUT_DIR != / && $YOUEYE_OUTPUT_DIR != "$YOUEYE_SOURCE_DIR" ]] || \
        youeye_build_fail 'YOUEYE_OUTPUT_DIR must be a dedicated non-root directory'
    [[ -n $YOUEYE_WORK_DIR && $YOUEYE_WORK_DIR != / && $YOUEYE_WORK_DIR != "$YOUEYE_SOURCE_DIR" ]] || \
        youeye_build_fail 'YOUEYE_WORK_DIR must be a dedicated non-root directory'

    local git_commit
    if git_commit="$(git -C "$YOUEYE_SOURCE_DIR" rev-parse HEAD 2>/dev/null)"; then
        if [[ -n $YOUEYE_SOURCE_COMMIT && $YOUEYE_SOURCE_COMMIT != "$git_commit" ]]; then
            youeye_build_fail 'YOUEYE_SOURCE_COMMIT does not match the checked-out source commit'
        fi
        YOUEYE_SOURCE_COMMIT="$git_commit"
        if [[ -z $SOURCE_DATE_EPOCH ]]; then
            SOURCE_DATE_EPOCH="$(git -C "$YOUEYE_SOURCE_DIR" show -s --format=%ct "$git_commit")"
        fi
    fi
    [[ $YOUEYE_SOURCE_COMMIT =~ ^[0-9a-f]{40}$ ]] || \
        youeye_build_fail 'YOUEYE_SOURCE_COMMIT must be the exact 40-character source commit'
    [[ $SOURCE_DATE_EPOCH =~ ^[1-9][0-9]*$ ]] || \
        youeye_build_fail 'SOURCE_DATE_EPOCH must be a positive integer'

    install -d -m 0755 "$YOUEYE_OUTPUT_DIR" "$YOUEYE_WORK_DIR"
    export YOUEYE_SOURCE_DIR YOUEYE_OUTPUT_DIR YOUEYE_WORK_DIR YOUEYE_SOURCE_COMMIT SOURCE_DATE_EPOCH
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
    mapfile -d '' matches < <(find "$root" -mindepth 2 -maxdepth 5 -type f -name server.js -print0)
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

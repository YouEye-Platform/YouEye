# Sourced by the control-panel and ui entrypoints only. It is kept out of lib.sh on purpose: lib.sh is an
# input of the system image, so a change there rebuilds the image and turns the next update into a reboot.

# Run a copy of the packaged standalone tree and fail when the server writes
# into it (payload-guard.mjs). The installed tree must stay what was shipped.
youeye_guard_standalone_payload() {
    local guard
    guard="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/payload-guard.mjs"
    if ! node "$guard" "$YOUEYE_OUTPUT_DIR/standalone.tar"; then
        rm -f -- "$YOUEYE_OUTPUT_DIR/standalone.tar"
        youeye_build_fail 'payload guard failed: the packaged server must not write into its own tree (see payload-guard above)'
    fi
}

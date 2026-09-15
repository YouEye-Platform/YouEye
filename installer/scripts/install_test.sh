#!/bin/sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
install_script="$script_dir/install.sh"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT HUP INT TERM

sh -n "$install_script"
grep -Fq 'INSTALLER_CHANNEL:-stable' "$install_script"
grep -Fq 'INSTALLER_PROVIDER:-github' "$install_script"
grep -Fq 'https://api.github.com/repos/YouEye-Platform/YouEye/releases' "$install_script"
grep -Fq 'page_size_key=per_page' "$install_script"
grep -Fq 'page_size_key=limit' "$install_script"
grep -Fq 'INSTALLER_TAG:-' "$install_script"
grep -Fq 'INSTALLER_RELEASE_BRANCH:-' "$install_script"
grep -Fq 'browser_download_url' "$install_script"
grep -Fq 'openssl pkeyutl -verify -pubin' "$install_script"
grep -Fq 'Signed checksum entry count does not match the appliance contract' "$install_script"
grep -Fq 'exact 18-asset appliance set' "$install_script"
grep -Fq 'Signed appliance trust anchor does not match the embedded installer authority' "$install_script"
grep -Fq 'GitHub Installer download redirected to an untrusted host' "$install_script"
grep -Fq 'Installer download exceeded five redirects.' "$install_script"
grep -Fq 'exec "$release_cache/$asset" proxmox \' "$install_script"
if grep -Eq '(^|[[:space:]])tag=appliance-' "$install_script"; then
    printf '%s\n' 'installer bootstrap must not pin a release tag' >&2
    exit 1
fi
if grep -q 'INSTALLER_URL' "$install_script"; then
    printf '%s\n' 'installer bootstrap must not permit an unsigned direct binary URL' >&2
    exit 1
fi
if grep -q 'YOUEYE_APPLIANCE_RELEASE' "$install_script"; then
    printf '%s\n' 'installer bootstrap must not retain retired appliance release environment aliases' >&2
    exit 1
fi

bin_dir="$test_root/bin"
mkdir -p "$bin_dir"
cat > "$bin_dir/id" <<'EOF'
#!/bin/sh
test "${1:-}" = -u && { printf '0\n'; exit 0; }
exec /usr/bin/id "$@"
EOF
cat > "$bin_dir/openssl" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$OPENSSL_LOG"
exit 0
EOF
for command in qm pvesm pvesh sgdisk; do
    cat > "$bin_dir/$command" <<'EOF'
#!/bin/sh
exit 0
EOF
done
chmod +x "$bin_dir"/*

fixture_binary="$test_root/fixture-installer"
cat > "$fixture_binary" <<'EOF'
#!/bin/sh
printf 'launched:%s\n' "$*"
EOF
chmod +x "$fixture_binary"
fixture_digest="$(sha256sum "$fixture_binary" | awk '{print $1}')"

cat > "$bin_dir/curl" <<'EOF'
#!/bin/sh
set -eu
output=
url=
while [ "$#" -gt 0 ]; do
    case "$1" in
        -o) output="$2"; shift 2 ;;
        -D) headers="$2"; shift 2 ;;
        -w) writeout="$2"; shift 2 ;;
        -H|--retry|--connect-timeout|--max-redirs|--proto) shift 2 ;;
        -*) shift ;;
        *) url="$1"; shift ;;
    esac
done
printf '%s\n' "$url" >> "$CURL_LOG"
[ -n "${headers:-}" ] && printf 'HTTP/1.1 200 OK\r\n\r\n' > "$headers"
if [ "${CURL_CROSS_ORIGIN:-0}" = 1 ]; then
    case "$url" in
        *page=1)
            printf 'HTTP/1.1 302 Found\r\nLocation: https://untrusted.example.invalid/releases\r\n\r\n' > "$headers"
            : > "$output"
            printf '302'
            exit 0
            ;;
    esac
fi
case "$url" in
    *page=1)
        python3 - > "$output" <<'PY'
import json
print(json.dumps([{"tag_name": f"cp-dev-v0.0.{index}", "assets": []} for index in range(50)]))
PY
        ;;
    *page=2)
        python3 - > "$output" <<'PY'
import json
import os

tag = os.environ.get("FIXTURE_RELEASE_TAG", "appliance-dev-v0.5.6.0.3")
names = [
    "SHA256SUMS", "SHA256SUMS.sig", "appliance-development.pub",
    "appliance-manifest.json", "appliance-manifest.json.sig",
    "internal-recovery.img.zst", "provenance.json", "recovery.efi",
    "sbom.spdx.json", "system-a.efi", "system-b.efi",
    "system-root.img.zst", "system-update-manifest.json",
    "system-update-manifest.json.sig", "youeye-appliance-amd64.iso",
    "youeye-installer-linux-amd64", "youeye-system-update-bootstrap",
    "youeye-system-updater-linux-amd64",
]
assets = [
    {"name": name, "browser_download_url": f"https://forgejo.example.test/releases/download/{tag}/{name}"}
    for name in names
]
print(json.dumps([{"tag_name": tag, "draft": False, "prerelease": True, "published_at": "2026-08-15T01:00:00Z", "assets": assets}]))
PY
        ;;
    *page=3) printf '%s\n' '[]' > "$output" ;;
    */SHA256SUMS)
        for name in \
            appliance-development.pub appliance-manifest.json appliance-manifest.json.sig \
            internal-recovery.img.zst provenance.json recovery.efi sbom.spdx.json \
            system-a.efi system-b.efi system-root.img.zst system-update-manifest.json \
            system-update-manifest.json.sig youeye-appliance-amd64.iso \
            youeye-installer-linux-amd64 youeye-system-update-bootstrap \
            youeye-system-updater-linux-amd64
        do
            case "$name" in
                appliance-development.pub) digest=fe591510ae710cb1bf46b9be8c4bbde6f3446e4b3664ff5996565e6ab9712984 ;;
                youeye-installer-linux-amd64) digest="$FIXTURE_DIGEST" ;;
                *) digest=0000000000000000000000000000000000000000000000000000000000000000 ;;
            esac
            printf '%s  %s\n' "$digest" "$name"
        done > "$output"
        ;;
    */SHA256SUMS.sig) printf '%s\n' signature > "$output" ;;
    */youeye-installer-linux-amd64) cp "$FIXTURE_BINARY" "$output" ;;
    *) printf 'unexpected curl URL: %s\n' "$url" >&2; exit 22 ;;
esac
[ -n "${writeout:-}" ] && printf '200'
EOF
chmod +x "$bin_dir/curl"

curl_log="$test_root/curl.log"
openssl_log="$test_root/openssl.log"
: > "$curl_log"
: > "$openssl_log"
output="$(
    PATH="$bin_dir:$PATH" \
    CURL_LOG="$curl_log" OPENSSL_LOG="$openssl_log" \
    FIXTURE_BINARY="$fixture_binary" FIXTURE_DIGEST="$fixture_digest" \
    YOUEYE_INSTALLER_CACHE="$test_root/cache" \
    sh "$install_script" --provider forgejo \
        --releases-api https://forgejo.example.test/api/v1/repos/owner/YouEye/releases \
        --channel development --silent --yes
)"
case "$output" in
	*'Launching signed YouEye Installer appliance-dev-v0.5.6.0.3'*'launched:proxmox'*'--provider forgejo'*'--channel development'*) ;;
    *) printf 'unexpected bootstrap output: %s\n' "$output" >&2; exit 1 ;;
esac
grep -q 'limit=50&page=2' "$curl_log"
grep -q '/releases/download/appliance-dev-v0.5.6.0.3/youeye-installer-linux-amd64' "$curl_log"
grep -q 'pkeyutl -verify -pubin' "$openssl_log"

branch_output="$(
    PATH="$bin_dir:$PATH" \
    CURL_LOG="$curl_log" OPENSSL_LOG="$openssl_log" \
    FIXTURE_BINARY="$fixture_binary" FIXTURE_DIGEST="$fixture_digest" \
    FIXTURE_RELEASE_TAG=appliance-f-bootstrap-check-v0.5.6.0.4 \
    YOUEYE_INSTALLER_CACHE="$test_root/branch-cache" \
    sh "$install_script" --provider forgejo \
        --releases-api https://forgejo.example.test/api/v1/repos/owner/YouEye/releases \
        --channel branch --release-branch f-bootstrap-check --silent --yes
)"
case "$branch_output" in
    *'Launching signed YouEye Installer appliance-f-bootstrap-check-v0.5.6.0.4'*'launched:proxmox'*'--channel branch'*'--release-branch f-bootstrap-check'*) ;;
    *) printf 'unexpected branch bootstrap output: %s\n' "$branch_output" >&2; exit 1 ;;
esac

if PATH="$bin_dir:$PATH" \
    CURL_LOG="$curl_log" OPENSSL_LOG="$openssl_log" \
    FIXTURE_BINARY="$fixture_binary" FIXTURE_DIGEST="$fixture_digest" \
    YOUEYE_INSTALLER_CACHE="$test_root/no-fallback-cache" \
	sh "$install_script" --provider forgejo \
	    --releases-api https://forgejo.example.test/api/v1/repos/owner/YouEye/releases \
	    --channel stable > "$test_root/no-fallback.out" 2>&1; then
    printf '%s\n' 'stable selection unexpectedly fell back to development' >&2
    exit 1
fi
grep -q 'refusing channel fallback' "$test_root/no-fallback.out"

if PATH="$bin_dir:$PATH" \
    CURL_LOG="$curl_log" OPENSSL_LOG="$openssl_log" CURL_CROSS_ORIGIN=1 \
    FIXTURE_BINARY="$fixture_binary" FIXTURE_DIGEST="$fixture_digest" \
    YOUEYE_INSTALLER_CACHE="$test_root/cross-origin-cache" \
	sh "$install_script" --provider forgejo \
	    --releases-api https://forgejo.example.test/api/v1/repos/owner/YouEye/releases \
	    --channel development > "$test_root/cross-origin.out" 2>&1; then
    printf '%s\n' 'cross-origin redirect unexpectedly passed' >&2
    exit 1
fi
grep -q 'redirected across origins' "$test_root/cross-origin.out"
if grep -q 'untrusted.example.invalid' "$curl_log"; then
    printf '%s\n' 'bootstrap contacted the rejected cross-origin redirect' >&2
    exit 1
fi

printf '%s\n' 'signed installer bootstrap tests passed'

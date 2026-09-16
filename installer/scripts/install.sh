#!/bin/sh
# YouEye Installer bootstrap for Proxmox VE.
#
# Stable:
#   curl -fsSL https://raw.githubusercontent.com/YouEye-Platform/YouEye/main/installer/scripts/install.sh | sh
# Development from an explicit Forgejo-compatible source:
#   curl -fsSL https://raw.githubusercontent.com/YouEye-Platform/YouEye/main/installer/scripts/install.sh |
#     sh -s -- --provider forgejo --releases-api https://forge.example.test/api/v1/repos/example/YouEye/releases --channel development
#
# The booted YouEye ISO runs the same binary as `youeye-installer install`.
set -eu

provider="${INSTALLER_PROVIDER:-github}"
releases_api="${INSTALLER_RELEASES_API:-}"
channel="${INSTALLER_CHANNEL:-stable}"
release_branch="${INSTALLER_RELEASE_BRANCH:-}"
exact_tag="${INSTALLER_TAG:-}"
installer_sha256="${INSTALLER_SHA256:-}"
iso_sha256="${INSTALLER_ISO_SHA256:-}"
cache_root="${YOUEYE_INSTALLER_CACHE:-/var/cache/youeye-installer/bootstrap}"
asset=youeye-installer-linux-amd64
max_pages=200

# Generated from the compiled public trust policy before a public snapshot is
# committed. Never obtain a replacement authority from a release/download URL.
public_trust_policy=$(cat <<'YOUEYE_PUBLIC_TRUST'
# BEGIN GENERATED PUBLIC TRUST
{"keys":{"beta":"-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAVi0aLbxkZrilqlsDVSNI3ukJLzNdriZM08Wye3YP8ok=\n-----END PUBLIC KEY-----\n","stable":"-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEATDcZkxI90DbHw/7AauXbwwrEY6rDikxk8u0Y8IIwhkc=\n-----END PUBLIC KEY-----\n"},"schema":"youeye.public-trust.v1"}
# END GENERATED PUBLIC TRUST
YOUEYE_PUBLIC_TRUST
)

parse_bootstrap_options() {
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --provider)
                [ "$#" -ge 2 ] || { printf '%s requires a value.\n' "$1" >&2; exit 1; }
                provider=$2; shift 2 ;;
            --provider=*) provider=${1#*=}; shift ;;
            --releases-api)
                [ "$#" -ge 2 ] || { printf '%s requires a value.\n' "$1" >&2; exit 1; }
                releases_api=$2; shift 2 ;;
            --releases-api=*) releases_api=${1#*=}; shift ;;
            --channel)
                [ "$#" -ge 2 ] || { printf '%s requires a value.\n' "$1" >&2; exit 1; }
                channel=$2; shift 2 ;;
            --channel=*) channel=${1#*=}; shift ;;
            --release-branch)
                [ "$#" -ge 2 ] || { printf '%s requires a value.\n' "$1" >&2; exit 1; }
                release_branch=$2; shift 2 ;;
            --release-branch=*) release_branch=${1#*=}; shift ;;
            --release-tag)
                [ "$#" -ge 2 ] || { printf '%s requires a value.\n' "$1" >&2; exit 1; }
                exact_tag=$2; shift 2 ;;
            --release-tag=*) exact_tag=${1#*=}; shift ;;
            --installer-sha256)
                [ "$#" -ge 2 ] || { printf '%s requires a value.\n' "$1" >&2; exit 1; }
                installer_sha256=$2; shift 2 ;;
            --installer-sha256=*) installer_sha256=${1#*=}; shift ;;
            --iso-sha256)
                [ "$#" -ge 2 ] || { printf '%s requires a value.\n' "$1" >&2; exit 1; }
                iso_sha256=$2; shift 2 ;;
            --iso-sha256=*) iso_sha256=${1#*=}; shift ;;
            *) shift ;;
        esac
    done
}
parse_bootstrap_options "$@"

provider="$(printf '%s' "$provider" | tr '[:upper:]' '[:lower:]')"
channel="$(printf '%s' "$channel" | tr '[:upper:]' '[:lower:]')"
if [ -z "$releases_api" ] && [ "$provider" = github ]; then
    releases_api=https://api.github.com/repos/YouEye-Platform/YouEye/releases
fi

if [ "$(id -u)" -ne 0 ]; then
    printf '%s\n' 'Run the YouEye Installer as root on a Proxmox VE host.' >&2
    exit 1
fi
for command in curl openssl sha256sum python3 qm pvesm pvesh sgdisk; do
    if ! command -v "$command" >/dev/null 2>&1; then
        printf 'Required Proxmox installer command is missing: %s\n' "$command" >&2
        exit 1
    fi
done

case "$channel" in
    stable) ;;
    development|dev) channel=development ;;
    branch) ;;
    exact) ;;
    *) printf 'Installer channel must be stable, development, branch, or exact, got %s\n' "$channel" >&2; exit 1 ;;
esac
case "$provider" in
    github) page_size=100; page_size_key=per_page ;;
    forgejo|custom) page_size=50; page_size_key=limit ;;
    *) printf 'Installer provider must be github, forgejo, or custom, got %s\n' "$provider" >&2; exit 1 ;;
esac
if [ -z "$releases_api" ]; then
    printf '%s\n' 'Forgejo and custom providers require an explicit --releases-api HTTPS URL.' >&2
    exit 1
fi
python3 - "$provider" "$releases_api" <<'PY'
import sys
from urllib.parse import parse_qs, urlparse

provider, raw = sys.argv[1:]
parsed = urlparse(raw)
if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password or parsed.fragment:
    raise SystemExit("Releases API must use HTTPS without credentials or a fragment")
unsupported = set(parse_qs(parsed.query)) - {"limit", "per_page", "page"}
if unsupported:
    raise SystemExit(f"Releases API contains unsupported query parameter: {sorted(unsupported)[0]}")
if provider == "github":
    parts = [part for part in parsed.path.split("/") if part]
    if (parsed.hostname or "").lower() != "api.github.com" or len(parts) != 4 or parts[0] != "repos" or parts[3] != "releases":
        raise SystemExit("GitHub provider requires one api.github.com repository releases URL")
PY
if [ "$channel" = exact ]; then
    [ -n "$exact_tag" ] || { printf '%s\n' 'Exact selection requires --release-tag.' >&2; exit 1; }
    [ -n "$iso_sha256" ] || { printf '%s\n' 'Exact selection requires --iso-sha256.' >&2; exit 1; }
    [ -n "$installer_sha256" ] || { printf '%s\n' 'Exact selection requires --installer-sha256.' >&2; exit 1; }
elif [ -n "$exact_tag" ] || [ -n "$iso_sha256" ] || [ -n "$installer_sha256" ]; then
    printf '%s\n' 'Release tag and exact digests require --channel exact.' >&2
    exit 1
fi
if [ "$channel" = branch ]; then
    python3 - "$release_branch" <<'PY'
import re
import sys

branch = sys.argv[1]
if not branch or len(branch) > 96 or any(part in {"", ".", ".."} or part.startswith(".") or part.endswith(".") or part.endswith(".lock") or not re.fullmatch(r"[a-z0-9._-]+", part) for part in branch.split("/")):
    raise SystemExit("Branch selection requires a safe signed release branch")
PY
elif [ -n "$release_branch" ]; then
    printf '%s\n' 'Release branch requires --channel branch.' >&2
    exit 1
fi
validate_digest() {
    digest_name=$1
    digest_value=$2
    if [ -n "$digest_value" ] && { [ "${#digest_value}" -ne 64 ] || printf '%s' "$digest_value" | grep -q '[^0-9a-f]'; }; then
        printf '%s must be exactly 64 lowercase hexadecimal characters.\n' "$digest_name" >&2
        exit 1
    fi
}
validate_digest installer_sha256 "$installer_sha256"
validate_digest iso_sha256 "$iso_sha256"

umask 077
install -d -m 0700 "$cache_root"
pages_dir="$(mktemp -d "$cache_root/.release-pages.XXXXXX")"
cleanup() {
    rm -rf "$pages_dir"
}
trap cleanup EXIT HUP INT TERM

download_https() {
    source_url=$1
    destination=$2
    current_url=$source_url
    redirect_count=0
    headers_path="$destination.headers.$$"
    body_path="$destination.body.$$"
    rm -f "$headers_path" "$body_path"
    while :; do
        python3 - "$source_url" "$current_url" <<'PY'
import sys
from urllib.parse import urlparse

origin = urlparse(sys.argv[1])
current = urlparse(sys.argv[2])
if current.scheme != "https" or not current.netloc or current.username or current.password or current.fragment:
    raise SystemExit("Installer download redirects must use HTTPS without credentials or a fragment")
if (origin.hostname or "").lower() == "github.com":
    allowed = {"github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"}
    if (current.hostname or "").lower() not in allowed:
        raise SystemExit(f"GitHub Installer download redirected to an untrusted host {current.hostname!r}")
elif current.netloc.lower() != origin.netloc.lower():
    raise SystemExit("Installer download redirected across origins")
PY
        if ! status="$(curl -sS --proto '=https' --max-redirs 0 --retry 3 --connect-timeout 15 \
            -H 'Accept: application/json' -H 'User-Agent: youeye-installer-bootstrap' \
            -D "$headers_path" -o "$body_path" -w '%{http_code}' "$current_url")"; then
            rm -f "$headers_path" "$body_path"
            return 1
        fi
        case "$status" in
            200)
                mv "$body_path" "$destination"
                rm -f "$headers_path"
                return 0
                ;;
            301|302|303|307|308)
                if [ "$redirect_count" -ge 5 ]; then
                    printf '%s\n' 'Installer download exceeded five redirects.' >&2
                    rm -f "$headers_path" "$body_path"
                    return 1
                fi
                current_url="$(python3 - "$source_url" "$current_url" "$headers_path" <<'PY'
import sys
from urllib.parse import urljoin, urlparse

origin = urlparse(sys.argv[1])
with open(sys.argv[3], "r", encoding="iso-8859-1", newline="") as source:
    locations = [line.split(":", 1)[1].strip() for line in source.read().splitlines() if line.lower().startswith("location:")]
if len(locations) != 1:
    raise SystemExit("Installer redirect must contain exactly one Location header")
target = urlparse(urljoin(sys.argv[2], locations[0]))
if target.scheme != "https" or not target.netloc or target.username or target.password or target.fragment:
    raise SystemExit("Installer download redirects must use HTTPS without credentials or a fragment")
if (origin.hostname or "").lower() == "github.com":
    allowed = {"github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"}
    if (target.hostname or "").lower() not in allowed:
        raise SystemExit(f"GitHub Installer download redirected to an untrusted host {target.hostname!r}")
elif target.netloc.lower() != origin.netloc.lower():
    raise SystemExit("Installer download redirected across origins")
print(target.geturl())
PY
)" || {
                    rm -f "$headers_path" "$body_path"
                    return 1
                }
                redirect_count=$((redirect_count + 1))
                rm -f "$headers_path" "$body_path"
                ;;
            *)
                printf 'Installer download returned HTTP %s for %s\n' "$status" "$current_url" >&2
                rm -f "$headers_path" "$body_path"
                return 1
                ;;
        esac
    done
}

case "$releases_api" in
    *\?*) query_separator='&' ;;
    *) query_separator='?' ;;
esac
page=1
while [ "$page" -le "$max_pages" ]; do
    page_path="$pages_dir/page-$page.json"
	download_https "${releases_api}${query_separator}${page_size_key}=${page_size}&page=${page}" "$page_path"
    count="$(python3 - "$page_path" <<'PY'
import json
import sys

with open(sys.argv[1], "rb") as source:
    releases = json.load(source)
if not isinstance(releases, list):
    raise SystemExit("Releases response is not an array")
print(len(releases))
PY
)"
	if [ "$count" -eq 0 ]; then
        break
    fi
    if [ "$page" -eq "$max_pages" ]; then
        printf 'Release discovery exceeded %s pages; use INSTALLER_TAG for an exact release.\n' "$max_pages" >&2
        exit 1
    fi
    page=$((page + 1))
done

selection="$pages_dir/selection"
python3 - "$provider" "$releases_api" "$channel" "$release_branch" "$exact_tag" "$selection" "$pages_dir"/page-*.json <<'PY'
import json
import re
import sys
from datetime import datetime
from urllib.parse import unquote, urlparse

provider, releases_api, channel, release_branch, exact_tag, destination, *page_paths = sys.argv[1:]
source_url = urlparse(releases_api)
releases = []
seen_tags = set()
for path in page_paths:
    with open(path, "rb") as source:
        page = json.load(source)
    if not isinstance(page, list):
        raise SystemExit("Releases response is not an array")
    for release in page:
        tag = release.get("tag_name", "")
        if tag in seen_tags:
            raise SystemExit(f"Releases response contains duplicate tag {tag!r}")
        seen_tags.add(tag)
        releases.append(release)

stable_pattern = re.compile(r"appliance-v(\d+(?:\.\d+)+)")
development_pattern = re.compile(r"appliance-dev-v(\d+(?:\.\d+)+)")
branch_pattern = re.compile(rf"appliance-{re.escape(release_branch)}-v(\d+(?:\.\d+)+)") if release_branch else None
any_branch_pattern = re.compile(r"appliance-([a-z0-9._/-]+)-v(\d+(?:\.\d+)+)")

def release_identity(release):
    tag = release.get("tag_name", "")
    if channel == "exact":
        if tag != exact_tag:
            return None
        match = stable_pattern.fullmatch(tag) or development_pattern.fullmatch(tag)
        if not match:
            generic = any_branch_pattern.fullmatch(tag)
            if generic:
                parts = generic.group(1).split("/")
                if all(part not in {"", ".", ".."} and not part.startswith(".") and not part.endswith(".") and not part.endswith(".lock") and re.fullmatch(r"[a-z0-9._-]+", part) for part in parts):
                    match = re.fullmatch(r"(\d+(?:\.\d+)+)", generic.group(2))
    elif channel == "stable":
        match = stable_pattern.fullmatch(tag)
    elif channel == "branch":
        match = branch_pattern.fullmatch(tag) if branch_pattern else None
    else:
        match = development_pattern.fullmatch(tag)
    if not match or release.get("draft"):
        return None
    is_stable = stable_pattern.fullmatch(tag) is not None
    if is_stable and release.get("prerelease"):
        return None
    published = release.get("published_at")
    if not isinstance(published, str) or not published:
        return None
    try:
        published_at = datetime.fromisoformat(published.replace("Z", "+00:00"))
    except ValueError:
        return None
    return published_at, tuple(int(part) for part in match.group(1).split("."))

candidates = [(release_identity(release), release) for release in releases]
candidates = [(identity, release) for identity, release in candidates if identity is not None]
if not candidates:
    requested = exact_tag or channel
    raise SystemExit(f"No exact signed appliance release was found for {requested}; refusing channel fallback")
candidates.sort(key=lambda item: item[0], reverse=True)
release = candidates[0][1]
tag = release["tag_name"]
parts = source_url.path.strip("/").split("/")
private_main = (provider == "forgejo" and len(parts) == 6 and
                parts[:3] == ["api", "v1", "repos"] and parts[5] == "releases" and
                source_url.hostname not in ("github.com", "api.github.com") and
                not source_url.hostname.endswith(".github.com") and
                re.fullmatch(r"appliance-v\d+(?:\.\d+){4}", tag) is not None)
trust_class = "development"
if not private_main:
    if stable_pattern.fullmatch(tag):
        trust_class = "stable"
    elif tag.startswith("appliance-beta-v"):
        trust_class = "beta"

checksum_assets = {
    "appliance-development.pub",
    "appliance-manifest.json",
    "appliance-manifest.json.sig",
    "internal-recovery.img.zst",
    "provenance.json",
    "recovery.efi",
    "sbom.spdx.json",
    "system-a.efi",
    "system-b.efi",
    "system-root.img.zst",
    "system-update-manifest.json",
    "system-update-manifest.json.sig",
    "youeye-appliance-amd64.iso",
    "youeye-installer-linux-amd64",
    "youeye-system-update-bootstrap",
    "youeye-system-updater-linux-amd64",
}
required = checksum_assets | {"SHA256SUMS", "SHA256SUMS.sig"}
if trust_class != "development" or any(a.get("name") == "release-lock.json" for a in release.get("assets", [])):
    required.add("release-lock.json")
assets = {}
for entry in release.get("assets", []):
    name = entry.get("name", "")
    if name in assets:
        raise SystemExit(f"Release {release['tag_name']} contains duplicate {name}")
    raw_url = entry.get("browser_download_url", "")
    parsed = urlparse(raw_url)
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment or any(character in raw_url for character in "\r\n\t"):
        raise SystemExit(f"Release {release['tag_name']} contains an invalid HTTPS URL for {name}")
    if provider == "github":
        if (parsed.hostname or "").lower() != "github.com":
            raise SystemExit(f"Release {release['tag_name']} contains a non-GitHub URL for {name}")
        source_parts = [part for part in source_url.path.split("/") if part]
        if len(source_parts) < 4 or parsed.path.split("/")[1:3] != source_parts[1:3]:
            raise SystemExit(f"Release {release['tag_name']} asset {name} does not match the configured GitHub repository")
    elif parsed.netloc.lower() != source_url.netloc.lower():
        raise SystemExit(f"Release {release['tag_name']} contains a cross-origin URL for {name}")
    expected_suffix = f"/releases/download/{release['tag_name']}/{name}"
    if not parsed.path.endswith(expected_suffix):
        raise SystemExit(f"Release {release['tag_name']} asset {name} is not release-scoped")
    final_name = unquote(parsed.path.rsplit("/", 1)[-1])
    if final_name != name or "/" in final_name or "\\" in final_name or "%2f" in parsed.path.lower() or "%5c" in parsed.path.lower():
        raise SystemExit(f"Release {release['tag_name']} contains an invalid asset identity for {name}")
    assets[name] = raw_url
if set(assets) != required:
    missing = sorted(required - assets.keys())
    unexpected = sorted(assets.keys() - required)
    detail = []
    if missing:
        detail.append(f"missing {', '.join(missing)}")
    if unexpected:
        detail.append(f"unexpected {', '.join(unexpected)}")
    raise SystemExit(f"Release {release['tag_name']} is not the exact {len(required)}-asset appliance set: {'; '.join(detail)}")

with open(destination, "w", encoding="utf-8", newline="\n") as output:
    output.write(release["tag_name"] + "\n")
    output.write(assets["SHA256SUMS"] + "\n")
    output.write(assets["SHA256SUMS.sig"] + "\n")
    output.write(assets["youeye-installer-linux-amd64"] + "\n")
    output.write(trust_class + "\n")
    output.write(assets["appliance-manifest.json"] + "\n")
    output.write(assets["provenance.json"] + "\n")
    output.write(assets.get("release-lock.json", "-") + "\n")
    output.write((source_url.scheme + "://" + source_url.netloc + "/" + parts[3] + "/" + parts[4] if private_main else "-") + "\n")
PY

selected_tag="$(sed -n '1p' "$selection")"
checksums_url="$(sed -n '2p' "$selection")"
signature_url="$(sed -n '3p' "$selection")"
installer_url="$(sed -n '4p' "$selection")"
trust_class="$(sed -n '5p' "$selection")"
manifest_url="$(sed -n '6p' "$selection")"
provenance_url="$(sed -n '7p' "$selection")"
lock_url="$(sed -n '8p' "$selection")"
private_source="$(sed -n '9p' "$selection")"
release_cache="$cache_root/$selected_tag"
install -d -m 0700 "$release_cache"

trust_key="$release_cache/appliance-development.pub"
cat > "$trust_key" <<'EOF'
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAha3Qt2DxI8tDarUb24mmRRekCa1acvk/ttqyJ14y1OE=
-----END PUBLIC KEY-----
EOF
if [ "$trust_class" != development ]; then
    python3 - "$trust_class" "$public_trust_policy" "$trust_key" <<'PY'
import json
import sys
class_name, policy, destination = sys.argv[1:]
policy = json.loads("\n".join(line for line in policy.splitlines() if not line.startswith("#")))
key = policy.get("keys", {}).get(class_name)
if policy.get("schema") != "youeye.public-trust.v1" or not isinstance(key, str) or not key:
    raise SystemExit(f"Public {class_name} trust is not provisioned in this Installer")
with open(destination, "w", encoding="ascii", newline="\n") as output:
    output.write(key)
PY
fi

checksums_tmp="$release_cache/.SHA256SUMS.$$"
signature_tmp="$release_cache/.SHA256SUMS.sig.$$"
installer_tmp="$release_cache/.$asset.$$"
download_https "$checksums_url" "$checksums_tmp"
download_https "$signature_url" "$signature_tmp"
download_https "$installer_url" "$installer_tmp"

openssl pkeyutl -verify -pubin -inkey "$trust_key" -rawin \
    -in "$checksums_tmp" -sigfile "$signature_tmp" >/dev/null

signed_digests="$(python3 - "$checksums_tmp" "$asset" <<'PY'
import re
import sys

path, required = sys.argv[1:]
expected = {
    "appliance-development.pub",
    "appliance-manifest.json",
    "appliance-manifest.json.sig",
    "internal-recovery.img.zst",
    "provenance.json",
    "recovery.efi",
    "sbom.spdx.json",
    "system-a.efi",
    "system-b.efi",
    "system-root.img.zst",
    "system-update-manifest.json",
    "system-update-manifest.json.sig",
    "youeye-appliance-amd64.iso",
    "youeye-installer-linux-amd64",
    "youeye-system-update-bootstrap",
    "youeye-system-updater-linux-amd64",
}
entries = {}
with open(path, "r", encoding="ascii", newline="") as source:
    lines = source.read().splitlines()
if len(lines) != len(expected):
    raise SystemExit("Signed checksum entry count does not match the appliance contract")
for line in lines:
    match = re.fullmatch(r"([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)", line)
    if not match:
        raise SystemExit("Signed checksum set contains an invalid entry")
    digest, name = match.groups()
    if name in entries:
        raise SystemExit(f"Signed checksum set contains duplicate {name}")
    entries[name] = digest
if set(entries) != expected:
    raise SystemExit("Signed checksum asset identities do not match the appliance contract")
print(entries[required])
print(entries["appliance-development.pub"])
PY
)"
signed_digest="$(printf '%s\n' "$signed_digests" | sed -n '1p')"
signed_trust_digest="$(printf '%s\n' "$signed_digests" | sed -n '2p')"
embedded_trust_digest="$(sha256sum "$trust_key" | awk '{print $1}')"
if [ "$signed_trust_digest" != "$embedded_trust_digest" ]; then
    printf '%s\n' 'Signed appliance trust anchor does not match the embedded installer authority.' >&2
    exit 1
fi
if [ -n "$installer_sha256" ] && [ "$signed_digest" != "$installer_sha256" ]; then
    printf '%s\n' 'INSTALLER_SHA256 does not match the signed release digest.' >&2
    exit 1
fi
printf '%s  %s\n' "$signed_digest" "$installer_tmp" | sha256sum -c - >/dev/null

# Bind execution to the signed release identity, including the detached public
# lock. A provenance-bound lock does not change the 16-entry checksum contract.
manifest_tmp="$release_cache/.appliance-manifest.json.$$"
download_https "$manifest_url" "$manifest_tmp"
provenance_tmp="$release_cache/.provenance.json.$$"
lock_tmp="$release_cache/.release-lock.json.$$"
if [ "$lock_url" != - ]; then
    download_https "$provenance_url" "$provenance_tmp"
    download_https "$lock_url" "$lock_tmp"
fi
python3 - "$checksums_tmp" "$manifest_tmp" "$provenance_tmp" "$lock_tmp" "$lock_url" "$trust_class" "$selected_tag" "$private_source" <<'PY'
import hashlib
import json
import re
import sys
from pathlib import Path

sums_path, manifest_path, provenance_path, lock_path, lock_url, trust_class, tag, private_source = sys.argv[1:]
sums = {line.split()[1].lstrip("*"): line.split()[0] for line in Path(sums_path).read_text().splitlines()}
def reject(message):
    raise SystemExit(message)
def verified_json(path, digest):
    raw = Path(path).read_bytes()
    if not re.fullmatch(r"[0-9a-f]{64}", digest or "") or hashlib.sha256(raw).hexdigest() != digest:
        reject("Signed appliance metadata digest mismatch")
    return json.loads(raw)

manifest = verified_json(manifest_path, sums["appliance-manifest.json"])
release = manifest.get("release_set", {})
branch = release.get("branch")
version = manifest.get("image_version")
expected_tag = f"appliance-v{version}" if branch == "main" else f"appliance-{branch}-v{version}"
commit = manifest.get("source_commit", "")
if (manifest.get("schema") != "youeye.appliance.manifest.v1" or
    manifest.get("trust", {}).get("class") != trust_class or tag != expected_tag or
    not re.fullmatch(r"[0-9a-f]{40}", commit)):
    reject("Signed appliance trust/source identity differs from selected release")
if trust_class != "development" and (release.get("source") != "https://github.com/YouEye-Platform/YouEye" or
    branch != {"stable": "main", "beta": "beta"}[trust_class]):
    reject("Signed public appliance source/channel mismatch")
if private_source != "-" and (release.get("source") != private_source or branch != "main"):
    reject("Signed appliance source differs from selected Forgejo main repository")
if lock_url != "-":
    provenance = verified_json(provenance_path, sums["provenance.json"])
    lock = verified_json(lock_path, provenance.get("resolved_lock_sha256"))
    image = lock.get("image", {})
    source = provenance.get("source", {})
    if (provenance.get("schema") != "youeye.appliance.provenance.v2" or
        lock.get("schema") != "youeye.appliance.release-lock.v1" or
        image.get("version") != version or image.get("release_source") != release.get("source") or
        image.get("release_branch") != branch or not image.get("debian_snapshot") or
        image.get("debian_snapshot") != provenance.get("debian_snapshot") or
        provenance.get("source_commit") != commit or source.get("commit") != commit or source.get("branch") != branch or
        provenance.get("release_set") != release or release.get("fallback", [])):
        reject("Detached lock/provenance differs from signed appliance identity")
    components = lock.get("components", {})
    if set(components) != {"spine", "control_panel", "ui"}:
        reject("Detached lock component set mismatch")
    for name, component in components.items():
        pin = {key: component.get(key) for key in ("version", "tag", "source_commit", "artifact_sha256")}
        if pin != release.get(name) or (trust_class != "development" and pin["source_commit"] != commit):
            reject("Detached lock component source/pin mismatch")
    market = lock.get("market", {})
    bound_market = provenance.get("market", {})
    if (not market.get("source") or not market.get("branch") or not re.fullmatch(r"[0-9a-f]{40}", market.get("commit", "")) or
        market.get("source") != bound_market.get("source") or market.get("branch") != bound_market.get("branch") or
        market.get("commit") != bound_market.get("source_commit") or
        (trust_class != "development" and market.get("source") != "https://github.com/YouEye-Platform/Market")):
        reject("Detached lock Market differs from signed provenance")
PY

mv "$checksums_tmp" "$release_cache/SHA256SUMS"
mv "$signature_tmp" "$release_cache/SHA256SUMS.sig"
mv "$installer_tmp" "$release_cache/$asset"
mv "$manifest_tmp" "$release_cache/appliance-manifest.json"
if [ "$lock_url" != - ]; then
    mv "$provenance_tmp" "$release_cache/provenance.json"
    mv "$lock_tmp" "$release_cache/release-lock.json"
fi
chmod 0700 "$release_cache/$asset"

printf 'Launching signed YouEye Installer %s...\n' "$selected_tag"
rm -rf "$pages_dir"
trap - EXIT HUP INT TERM
if [ "$channel" = exact ]; then
    exec "$release_cache/$asset" proxmox \
        --provider "$provider" --releases-api "$releases_api" --channel exact \
        --release-tag "$exact_tag" --installer-sha256 "$installer_sha256" --iso-sha256 "$iso_sha256" "$@"
fi
if [ "$channel" = branch ]; then
    exec "$release_cache/$asset" proxmox \
        --provider "$provider" --releases-api "$releases_api" --channel branch \
        --release-branch "$release_branch" "$@"
fi
exec "$release_cache/$asset" proxmox \
    --provider "$provider" --releases-api "$releases_api" --channel "$channel" "$@"

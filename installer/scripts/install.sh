#!/bin/sh
# YouEye Installer bootstrap for Proxmox VE.
#
# Latest Stable release from the official repository:
#   curl -fsSL https://releases.youeye.me/install.sh | sh
# Latest Development release of another repository:
#   curl -fsSL https://releases.youeye.me/install.sh |
#     sh -s -- --repository https://code.example.test/example/YouEye --channel dev
#
# The bootstrap selects one System release, downloads its core-release.json
# over HTTPS, checks the Installer binary against the sha256 and size listed
# there and runs it with that exact release tag and core-release.json digest.
# Release signing is not used; integrity comes from HTTPS and SHA-256. The
# Installer then verifies every image artifact the same way.
#
# Channels:
#   stable  newest non-prerelease youeye-vX.Y.Z* release on branch main
#   dev     newest prerelease whose tag contains "-dev." on branch dev
#   branch  newest youeye-v release built from --release-branch
#   exact   the release named by --release-tag (optionally pinned with
#           --core-manifest-sha256)
#
# The booted YouEye ISO runs the same binary as `youeye-installer install`.
set -eu

repository="${INSTALLER_REPOSITORY:-https://github.com/YouEye-Platform/YouEye}"
channel="${INSTALLER_CHANNEL:-stable}"
release_branch="${INSTALLER_RELEASE_BRANCH:-}"
exact_tag="${INSTALLER_TAG:-}"
core_manifest_sha256="${INSTALLER_CORE_MANIFEST_SHA256:-}"
cache_root="${YOUEYE_INSTALLER_CACHE:-/var/cache/youeye-installer/bootstrap}"

option_value() {
    [ "$#" -ge 2 ] || { printf '%s requires a value.\n' "$1" >&2; exit 1; }
}
parse_bootstrap_options() {
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --repository) option_value "$@"; repository=$2; shift 2 ;;
            --repository=*) repository=${1#*=}; shift ;;
            --channel) option_value "$@"; channel=$2; shift 2 ;;
            --channel=*) channel=${1#*=}; shift ;;
            --release-branch) option_value "$@"; release_branch=$2; shift 2 ;;
            --release-branch=*) release_branch=${1#*=}; shift ;;
            --release-tag) option_value "$@"; exact_tag=$2; shift 2 ;;
            --release-tag=*) exact_tag=${1#*=}; shift ;;
            --core-manifest-sha256) option_value "$@"; core_manifest_sha256=$2; shift 2 ;;
            --core-manifest-sha256=*) core_manifest_sha256=${1#*=}; shift ;;
            *) shift ;;
        esac
    done
}
parse_bootstrap_options "$@"

channel="$(printf '%s' "$channel" | tr '[:upper:]' '[:lower:]')"
case "$channel" in
    stable) ;;
    dev|development) channel=development ;;
    branch)
        [ -n "$release_branch" ] || { printf '%s\n' 'Branch selection requires --release-branch.' >&2; exit 1; } ;;
    exact)
        [ -n "$exact_tag" ] || { printf '%s\n' 'Exact selection requires --release-tag.' >&2; exit 1; } ;;
    *) printf 'Installer channel must be stable, dev, branch, or exact, got %s\n' "$channel" >&2; exit 1 ;;
esac
if [ "$channel" != exact ] && { [ -n "$exact_tag" ] || [ -n "$core_manifest_sha256" ]; }; then
    printf '%s\n' 'A release tag or core-release.json digest requires --channel exact.' >&2
    exit 1
fi
if [ "$channel" != branch ] && [ -n "$release_branch" ]; then
    printf '%s\n' 'A release branch requires --channel branch.' >&2
    exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
    printf '%s\n' 'Run the YouEye Installer as root on a Proxmox VE host.' >&2
    exit 1
fi
for command in python3 qm pvesm pvesh sgdisk; do
    if ! command -v "$command" >/dev/null 2>&1; then
        printf 'Required Proxmox installer command is missing: %s\n' "$command" >&2
        exit 1
    fi
done

umask 077
install -d -m 0700 "$cache_root"
selection="$(mktemp "$cache_root/.selection.XXXXXX")"
trap 'rm -f "$selection"' EXIT HUP INT TERM

python3 - "$repository" "$channel" "$release_branch" "$exact_tag" "$core_manifest_sha256" "$cache_root" > "$selection" <<'YOUEYE_BOOTSTRAP_PY'
import hashlib
import json
import os
import re
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request

repository, channel, release_branch, exact_tag, pinned, cache_root = sys.argv[1:]
ROLES = {"installer", "media", "appliance", "system-update", "spine", "cp", "ui", "system-root", "system-a-uki",
         "system-b-uki", "system-updater", "internal-recovery", "recovery-uki", "update-bootstrap"}
TAG = re.compile(r"youeye-v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\.([1-9][0-9]*))?")
HASH = re.compile(r"[0-9a-f]{64}")
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}")
GITHUB_HOSTS = {"github.com", "api.github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"}
INSTALLER_LIMIT = 512 << 20


def fail(message):
    print("YouEye Installer bootstrap: " + message, file=sys.stderr)
    sys.exit(1)


if pinned and not HASH.fullmatch(pinned):
    fail("--core-manifest-sha256 must be 64 lowercase hexadecimal characters")
if channel == "branch" and (len(release_branch) > 96 or any(
        part in {"", ".", ".."} or part.startswith(".") or part.endswith(".") or part.endswith(".lock")
        or not re.fullmatch(r"[A-Za-z0-9._-]+", part) for part in release_branch.split("/"))):
    fail("--release-branch must be a safe branch name")
if channel == "exact" and not TAG.fullmatch(exact_tag):
    fail("--release-tag must be a youeye-vX.Y.Z release tag")

parsed = urllib.parse.urlparse(repository.strip())
path = parsed.path.rstrip("/")
if path.endswith(".git"):
    path = path[:-4]
parts = path.split("/")
if (parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password or parsed.query
        or parsed.fragment or len(parts) != 3 or parts[0] != ""
        or any(not re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9._-]*", p) or p.endswith(".") for p in parts[1:])):
    fail("--repository must be an HTTPS repository URL with owner and repository, without credentials, query or fragment")
host = parsed.netloc.lower()
source = "https://" + host + path
github = host == "github.com"
api = ("https://api.github.com/repos" if github else "https://" + host + "/api/v1/repos") + path + "/releases"
page_key, page_size = ("per_page", 100) if github else ("limit", 50)


def allowed(url):
    target = urllib.parse.urlparse(url)
    if target.scheme != "https" or not target.netloc or target.username or target.password or target.fragment:
        return False
    if github:
        return (target.hostname or "").lower() in GITHUB_HOSTS
    return target.netloc.lower() == host


class Redirects(urllib.request.HTTPRedirectHandler):
    max_redirections = 5

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not allowed(newurl):
            raise urllib.error.URLError("redirect to an untrusted location refused")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


# The default HTTPS handler verifies certificates and host names.
opener = urllib.request.build_opener(Redirects)


def open_url(url):
    if not allowed(url):
        fail("refusing a URL outside the selected repository: " + url)
    request = urllib.request.Request(url, headers={"User-Agent": "youeye-installer-bootstrap", "Accept": "application/json, application/octet-stream"})
    try:
        return opener.open(request, timeout=60)
    except urllib.error.HTTPError as error:
        fail("download returned HTTP %d for %s" % (error.code, url))
    except (urllib.error.URLError, OSError) as error:
        fail("download failed for %s: %s" % (url, getattr(error, "reason", error)))


def fetch(url, limit):
    with open_url(url) as response:
        raw = response.read(limit + 1)
    if len(raw) > limit:
        fail("response exceeds %d bytes: %s" % (limit, url))
    return raw


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key " + key)
        result[key] = value
    return result


def version_key(release):
    match = TAG.fullmatch(release["tag_name"])
    numbers = tuple(int(match.group(i)) for i in (1, 2, 3))
    if match.group(4) is None:
        return numbers + (1, "", 0)
    return numbers + (0, match.group(4), int(match.group(5)))


releases, seen = [], set()
for page in range(1, 201):
    rows = json.loads(fetch("%s?%s=%d&page=%d" % (api, page_key, page_size, page), 8 << 20))
    if not isinstance(rows, list):
        fail("releases response is not an array")
    if not rows:
        break
    for row in rows:
        tag = row.get("tag_name") if isinstance(row, dict) else None
        if not isinstance(tag, str) or tag in seen:
            fail("releases response contains a missing or duplicate tag")
        seen.add(tag)
        releases.append(row)
else:
    fail("release discovery exceeded 200 pages; use --channel exact")

branch = {"stable": "main", "development": "dev", "branch": release_branch}.get(channel, "")
candidates = []
for release in releases:
    tag = release["tag_name"]
    if release.get("draft") or not TAG.fullmatch(tag):
        continue
    prerelease = bool(release.get("prerelease"))
    if channel == "stable" and prerelease:
        continue
    if channel == "development" and not (prerelease and "-dev." in tag):
        continue
    if channel == "exact" and tag != exact_tag:
        continue
    candidates.append(release)
candidates.sort(key=lambda r: (version_key(r), str(r.get("published_at") or "")), reverse=True)

for release in candidates:
    tag = release["tag_name"]
    asset = [a for a in release.get("assets") or [] if isinstance(a, dict) and a.get("name") == "core-release.json"]
    if len(asset) != 1:
        if channel == "exact":
            fail("release %s has no single core-release.json" % tag)
        continue
    url = asset[0].get("browser_download_url", "")
    location = urllib.parse.urlparse(url)
    if (not allowed(url) or location.query or (github and location.hostname != "github.com")
            or urllib.parse.unquote(location.path) != path + "/releases/download/" + tag + "/core-release.json"):
        fail("release %s lists core-release.json outside the selected repository" % tag)
    raw = fetch(url, 1 << 20)
    try:
        document = json.loads(raw, object_pairs_hook=unique_object)
    except ValueError as error:
        fail("core-release.json of %s is malformed: %s" % (tag, error))
    if (not isinstance(document, dict) or document.get("schema") != "youeye.core-release.v1"
            or document.get("authority") != "digest" or document.get("tag") != tag or document.get("source") != source):
        fail("core-release.json of %s does not describe this release" % tag)
    if branch and document.get("branch") != branch:
        continue
    digest = hashlib.sha256(raw).hexdigest()
    if pinned and digest != pinned:
        fail("core-release.json of %s has sha256 %s, expected %s" % (tag, digest, pinned))
    members = document.get("members")
    if (not isinstance(members, list) or not all(isinstance(m, dict) for m in members)
            or sorted(str(m.get("role")) for m in members) != sorted(ROLES)):
        fail("core-release.json of %s does not list every System role exactly once" % tag)
    member = next(m for m in members if m.get("role") == "installer")
    blob = member.get("artifact")
    member_source, member_tag = member.get("source"), member.get("tag")
    if (not isinstance(blob, dict) or not NAME.fullmatch(str(blob.get("name", ""))) or not HASH.fullmatch(str(blob.get("sha256", "")))
            or type(blob.get("size_bytes")) is not int or not 0 < blob["size_bytes"] <= INSTALLER_LIMIT
            or not isinstance(member_source, str) or not isinstance(member_tag, str)
            or not str(blob.get("url", "")).startswith(member_source + "/releases/download/" + urllib.parse.quote(member_tag, safe="") + "/")):
        fail("core-release.json of %s has an invalid installer artifact" % tag)
    transport = blob["url"]
    if not transport.startswith(source + "/releases/download/"):
        # Original members built elsewhere are mirrored by digest on this release.
        transport = source + "/releases/download/" + tag + "/blob-" + blob["sha256"]
    directory = os.path.join(cache_root, tag)
    os.makedirs(directory, mode=0o700, exist_ok=True)
    target = os.path.join(directory, "youeye-installer-linux-amd64")
    handle, temporary = tempfile.mkstemp(dir=directory, prefix=".installer.")
    hasher, size = hashlib.sha256(), 0
    try:
        with os.fdopen(handle, "wb") as output, open_url(transport) as response:
            while True:
                chunk = response.read(1 << 20)
                if not chunk:
                    break
                size += len(chunk)
                if size > blob["size_bytes"]:
                    fail("installer download is larger than core-release.json lists")
                hasher.update(chunk)
                output.write(chunk)
        if size != blob["size_bytes"] or hasher.hexdigest() != blob["sha256"]:
            fail("installer checksum mismatch: got sha256 %s (%d bytes), core-release.json lists %s (%d bytes)"
                 % (hasher.hexdigest(), size, blob["sha256"], blob["size_bytes"]))
        os.chmod(temporary, 0o700)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    with open(os.path.join(directory, "core-release.json"), "wb") as output:
        output.write(raw)
    print(tag)
    print(digest)
    print(target)
    sys.exit(0)

if channel == "exact":
    fail("release %s was not found in %s" % (exact_tag, source))
fail("no %s release was found in %s" % ({"branch": "branch " + release_branch}.get(channel, channel), source))
YOUEYE_BOOTSTRAP_PY

selected_tag="$(sed -n '1p' "$selection")"
selected_digest="$(sed -n '2p' "$selection")"
installer="$(sed -n '3p' "$selection")"
rm -f "$selection"
trap - EXIT HUP INT TERM

# Pass through only the options the bootstrap does not own. The Installer
# receives the exact release verified above (tag and core-release.json digest)
# so it cannot resolve a different head; a track still records its track for
# later System updates.
skip_next=
for argument do
    shift
    if [ -n "$skip_next" ]; then
        skip_next=
        continue
    fi
    case "$argument" in
        --repository|--channel|--release-branch|--release-tag|--core-manifest-sha256) skip_next=1; continue ;;
        --repository=*|--channel=*|--release-branch=*|--release-tag=*|--core-manifest-sha256=*) continue ;;
    esac
    set -- "$@" "$argument"
done
set -- "$@" --repository "$repository" --channel "$channel"
if [ "$channel" = branch ]; then
    set -- "$@" --release-branch "$release_branch"
fi

printf 'Launching YouEye Installer from %s (core-release.json sha256 %s)...\n' "$selected_tag" "$selected_digest"
exec "$installer" proxmox "$@" --release-tag "$selected_tag" --core-manifest-sha256 "$selected_digest"

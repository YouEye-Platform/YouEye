#!/bin/sh
# YouEye Installer bootstrap for Proxmox VE.
#
# Latest Stable release from the official repository:
#   curl -fsSL https://releases.youeye.me/install.sh | sh
# Latest dev release of another repository:
#   curl -fsSL https://releases.youeye.me/install.sh |
#     sh -s -- --repository https://code.example.test/example/YouEye --channel dev
#
# The bootstrap reads the channel index of the repository (a small file, never
# a release-listing API), downloads that release's core-release.json and checks
# it against the index digest, checks the Installer binary against the sha256
# and size listed there and runs it with that exact release tag and
# core-release.json digest. Release signing is not used; integrity comes from
# HTTPS and SHA-256. The Installer then verifies every image artifact the same
# way.
#
# Channels: dev, alpha, beta, stable (default). The box keeps following the
# channel after installation. --release-tag with --core-manifest-sha256 installs
# one exact release of the channel instead of its current one.
#
# The booted YouEye ISO runs the same binary as `youeye-installer install`.
set -eu

repository="${INSTALLER_REPOSITORY:-https://github.com/YouEye-Platform/YouEye}"
channel="${INSTALLER_CHANNEL:-stable}"
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
    dev|alpha|beta|stable) ;;
    *) printf 'Installer channel must be dev, alpha, beta or stable, got %s\n' "$channel" >&2; exit 1 ;;
esac
if { [ -n "$exact_tag" ] && [ -z "$core_manifest_sha256" ]; } || { [ -z "$exact_tag" ] && [ -n "$core_manifest_sha256" ]; }; then
    printf '%s\n' '--release-tag and --core-manifest-sha256 go together.' >&2
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

python3 - "$repository" "$channel" "$exact_tag" "$core_manifest_sha256" "$cache_root" > "$selection" <<'YOUEYE_BOOTSTRAP_PY'
import hashlib
import json
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

repository, channel, exact_tag, pinned, cache_root = sys.argv[1:]
OFFICIAL = "https://github.com/YouEye-Platform/YouEye"
INDEX_HOST = "https://releases.youeye.me"
ROLES = {"installer", "media", "appliance", "system-update", "spine", "cp", "ui", "system-root", "system-a-uki",
         "system-b-uki", "system-updater", "internal-recovery", "recovery-uki", "update-bootstrap"}
TAG = re.compile(r"youeye-v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\.([1-9][0-9]*))?")
HASH = re.compile(r"[0-9a-f]{64}")
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}")
GITHUB_ASSET_HOSTS = {"github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"}
INSTALLER_LIMIT = 512 << 20
RETRY_SECONDS = [int(x) for x in os.environ.get("YOUEYE_BOOTSTRAP_RETRY_SECONDS", "30,60,120").split(",") if x]


def fail(message):
    print("YouEye Installer bootstrap: " + message, file=sys.stderr)
    sys.exit(1)


if pinned and not HASH.fullmatch(pinned):
    fail("--core-manifest-sha256 must be 64 lowercase hexadecimal characters")
if exact_tag and not TAG.fullmatch(exact_tag):
    fail("--release-tag must be a youeye-vX.Y.Z-rc.N release tag")

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
repository = "https://" + host + path
github = host == "github.com"


def allowed(url):
    target = urllib.parse.urlparse(url)
    if target.scheme != "https" or not target.netloc or target.username or target.password or target.fragment:
        return False
    name = (target.hostname or "").lower()
    if url.startswith(INDEX_HOST + "/"):
        return True
    if github:
        return name in GITHUB_ASSET_HOSTS
    return target.netloc.lower() == host


class Redirects(urllib.request.HTTPRedirectHandler):
    max_redirections = 5

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not allowed(newurl):
            raise urllib.error.URLError("redirect to an untrusted location refused")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


# The default HTTPS handler verifies certificates and host names.
opener = urllib.request.build_opener(Redirects)


class NotFound(Exception):
    pass


class Unavailable(Exception):
    pass


def open_url(url):
    """Open url. Retries when the host refuses or rate-limits (HTTP 403/429) or the network fails; raises
    NotFound for HTTP 404 and Unavailable when the retries are used up."""
    if not allowed(url):
        fail("refusing a URL outside the selected repository: " + url)
    request = urllib.request.Request(url, headers={"User-Agent": "youeye-installer-bootstrap"})
    for attempt in range(len(RETRY_SECONDS) + 1):
        try:
            return opener.open(request, timeout=60)
        except urllib.error.HTTPError as error:
            if error.code == 404:
                raise NotFound(url)
            if error.code in (403, 429):
                message = "the release host refused or rate-limited the request (HTTP %d) for %s" % (error.code, url)
            elif error.code >= 500:
                message = "the release host returned HTTP %d for %s" % (error.code, url)
            else:
                raise Unavailable("download returned HTTP %d for %s" % (error.code, url))
        except urllib.error.URLError as error:
            if "untrusted location" in str(getattr(error, "reason", "")):
                fail("download refused for %s: %s" % (url, error.reason))
            message = "download failed for %s: %s" % (url, getattr(error, "reason", error))
        except OSError as error:
            message = "download failed for %s: %s" % (url, error)
        if attempt < len(RETRY_SECONDS):
            print("YouEye Installer bootstrap: %s; retrying in %d s..." % (message, RETRY_SECONDS[attempt]), file=sys.stderr)
            time.sleep(RETRY_SECONDS[attempt])
    raise Unavailable(message + "; try again later")


def fetch(url, limit):
    try:
        response = open_url(url)
    except Unavailable as error:
        fail(str(error))
    with response:
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


def download_url(tag, name):
    return repository + "/releases/download/" + urllib.parse.quote(tag, safe="") + "/" + urllib.parse.quote(name, safe="")


if exact_tag:
    tag, expected = exact_tag, pinned
else:
    locations = []
    if repository == OFFICIAL and channel in ("beta", "stable"):
        locations.append(INDEX_HOST + "/v1/channels/" + channel + ".json")
    locations.append(download_url("channel-" + channel, "index.json"))
    index, problems = None, []
    for location in locations:
        # Any failure of one location (missing, refused, unreachable, malformed) moves on to the next one.
        try:
            with open_url(location) as response:
                raw = response.read((256 << 10) + 1)
            if len(raw) > 256 << 10:
                raise ValueError("index is too large")
            index = json.loads(raw, object_pairs_hook=unique_object)
            if not isinstance(index, dict) or index.get("channel") != channel:
                raise ValueError("not the %s channel index" % channel)
            break
        except NotFound:
            problems.append("no index at " + location)
        except (Unavailable, ValueError) as error:
            problems.append("%s: %s" % (location, error))
        index = None
    if not isinstance(index, dict):
        if all(p.startswith("no index at ") for p in problems):
            fail("the %s channel of %s has no channel index yet" % (channel, repository))
        fail("could not read the %s channel index: %s" % (channel, "; ".join(problems)))
    entry = (index.get("products") or {}).get("youeye")
    if (index.get("schema") != "youeye.channel.v1" or index.get("channel") != channel or not isinstance(entry, dict)
            or entry.get("repository") != repository or entry.get("document") != "core-release.json"
            or not TAG.fullmatch(str(entry.get("tag", ""))) or not HASH.fullmatch(str(entry.get("sha256", "")))):
        fail("the %s channel index of %s does not name a YouEye release of this repository" % (channel, repository))
    tag, expected = entry["tag"], entry["sha256"]

try:
    raw = fetch(download_url(tag, "core-release.json"), 1 << 20)
except NotFound:
    fail("release %s of %s has no core-release.json" % (tag, repository))
digest = hashlib.sha256(raw).hexdigest()
if digest != expected:
    fail("core-release.json of %s has sha256 %s, expected %s" % (tag, digest, expected))
try:
    document = json.loads(raw, object_pairs_hook=unique_object)
except ValueError as error:
    fail("core-release.json of %s is malformed: %s" % (tag, error))
if (not isinstance(document, dict) or document.get("schema") != "youeye.core-release.v1"
        or document.get("authority") != "digest" or document.get("tag") != tag):
    fail("core-release.json of %s does not describe this release" % tag)
members = document.get("members")
if (not isinstance(members, list) or not all(isinstance(m, dict) for m in members)
        or sorted(str(m.get("role")) for m in members) != sorted(ROLES)):
    fail("core-release.json of %s does not list every System role exactly once" % tag)
blob = next(m for m in members if m.get("role") == "installer").get("artifact")
if (not isinstance(blob, dict) or not NAME.fullmatch(str(blob.get("name", ""))) or not HASH.fullmatch(str(blob.get("sha256", "")))
        or type(blob.get("size_bytes")) is not int or not 0 < blob["size_bytes"] <= INSTALLER_LIMIT
        or ("release" in blob and not TAG.fullmatch(str(blob["release"])))):
    fail("core-release.json of %s has an invalid installer artifact" % tag)
directory = os.path.join(cache_root, tag)
os.makedirs(directory, mode=0o700, exist_ok=True)
target = os.path.join(directory, "youeye-installer-linux-amd64")
handle, temporary = tempfile.mkstemp(dir=directory, prefix=".installer.")
hasher, size = hashlib.sha256(), 0
try:
    try:
        source = open_url(download_url(blob.get("release", tag), blob["name"]))
    except Unavailable as error:
        fail(str(error))
    with os.fdopen(handle, "wb") as output, source as response:
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
except NotFound:
    fail("release %s has no installer asset %s" % (tag, blob["name"]))
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
with open(os.path.join(directory, "core-release.json"), "wb") as output:
    output.write(raw)
print(tag)
print(digest)
print(target)
print(repository)
YOUEYE_BOOTSTRAP_PY

selected_tag="$(sed -n '1p' "$selection")"
selected_digest="$(sed -n '2p' "$selection")"
installer="$(sed -n '3p' "$selection")"
repository="$(sed -n '4p' "$selection")"
rm -f "$selection"
trap - EXIT HUP INT TERM

# Pass through only the options the bootstrap does not own. The Installer
# receives the exact release verified above (tag and core-release.json digest)
# and records the repository and channel the box follows afterwards.
skip_next=
for argument do
    shift
    if [ -n "$skip_next" ]; then
        skip_next=
        continue
    fi
    case "$argument" in
        --repository|--channel|--release-tag|--core-manifest-sha256) skip_next=1; continue ;;
        --repository=*|--channel=*|--release-tag=*|--core-manifest-sha256=*) continue ;;
    esac
    set -- "$@" "$argument"
done

printf 'Launching YouEye Installer from %s (core-release.json sha256 %s)...\n' "$selected_tag" "$selected_digest"
exec "$installer" proxmox "$@" --repository "$repository" --channel "$channel" --release-tag "$selected_tag" --core-manifest-sha256 "$selected_digest"

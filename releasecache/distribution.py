#!/usr/bin/env python3
"""Source-owned signed metadata reader, also embedded in the public bootstrap."""
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request

REPOSITORIES = {"YouEye", "Market", "Wiki", "Search", "Notes", "Cinema", "Weather", "Translate", "Canvas", "Pointer"}


def distribution_bytes(policy, source, cache):
    url = urllib.parse.urlparse(source)
    parts = url.path.strip("/").split("/")
    if not policy.get("origin") or url.scheme != "https" or url.netloc != "api.github.com" or len(parts) < 4 or parts[:2] != ["repos", "YouEye-Platform"] or parts[2] not in REPOSITORIES:
        return None
    if parts[3] != "releases" or len(parts) != 4:
        return None
    origin = urllib.parse.urlparse(policy["origin"])
    if policy.get("schema") != "youeye.distribution-policy.v1" or origin.scheme != "https" or not origin.hostname or origin.username or origin.password or origin.path or origin.query or origin.fragment or not policy.get("keys"):
        raise ValueError("Invalid distribution policy")
    query = urllib.parse.parse_qs(url.query)
    if set(query) - {"page", "per_page"}:
        return None
    page, size = int(query.get("page", ["1"])[0]), int(query.get("per_page", ["30"])[0])
    if not 1 <= page <= 10000 or not 1 <= size <= 100:
        raise ValueError("Invalid release page")
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            raise ValueError("Distribution redirects are not permitted")
    opener = urllib.request.build_opener(NoRedirect)
    now = datetime.datetime.now(datetime.timezone.utc)
    releases = []
    for channel in ("stable", "beta"):
        key = policy["keys"].get(channel)
        if not key:
            continue
        endpoint = policy["origin"] + "/v1/" + channel + ".json"
        directory = Path(cache)
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        saved = directory / (hashlib.sha256((endpoint + key).encode()).hexdigest() + ".json")
        def verify(raw):
            if len(raw) > 16 * 1024 * 1024:
                raise ValueError("Distribution response is too large")
            envelope = json.loads(raw)
            payload = base64.b64decode(envelope["payload"], validate=True)
            signature = base64.b64decode(envelope["signature"], validate=True)
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                (root / "key").write_text(key)
                (root / "payload").write_bytes(payload)
                (root / "signature").write_bytes(signature)
                result = subprocess.run(["openssl", "pkeyutl", "-verify", "-pubin", "-inkey", str(root / "key"), "-rawin", "-in", str(root / "payload"), "-sigfile", str(root / "signature")], capture_output=True)
                if result.returncode:
                    raise ValueError("Distribution signature rejected")
            catalog = json.loads(payload)
            issued = datetime.datetime.fromisoformat(catalog["issued_at"].replace("Z", "+00:00"))
            expires = datetime.datetime.fromisoformat(catalog["expires_at"].replace("Z", "+00:00"))
            if catalog.get("schema") != "youeye.distribution.v1" or catalog.get("channel") != channel or type(catalog.get("sequence")) is not int or catalog["sequence"] < 1 or issued > now + datetime.timedelta(minutes=5) or expires <= issued or expires - issued > datetime.timedelta(days=31):
                raise ValueError("Invalid distribution metadata")
            for name, repository in catalog["repositories"].items():
                for release in repository["releases"]:
                    if not release.get("tag_name") or release.get("draft") or bool(release.get("prerelease")) != (channel == "beta"):
                        raise ValueError("Distribution release channel mismatch")
                    prefix = "https://github.com/YouEye-Platform/" + name + "/releases/download/" + release["tag_name"] + "/"
                    for asset in release.get("assets", []):
                        target = asset["browser_download_url"]
                        if not target.startswith(prefix) or not re.fullmatch(r"[A-Za-z0-9._-]+", target[len(prefix):]):
                            raise ValueError("Distribution asset source mismatch")
            return catalog, expires, hashlib.sha256(payload).hexdigest()
        previous = None
        if saved.exists():
            st = saved.lstat()
            if saved.is_symlink() or st.st_mode & 0o022 or st.st_size > 16 * 1024 * 1024:
                raise ValueError("Invalid distribution cache")
            previous = verify(saved.read_bytes())
        if previous and now.timestamp() - saved.stat().st_mtime < 900 and previous[1] > now:
            catalog = previous[0]
        else:
            try:
                with opener.open(urllib.request.Request(endpoint, headers={"User-Agent": "youeye-distribution/1"}), timeout=30) as response:
                    raw = response.read(16 * 1024 * 1024 + 1)
            except urllib.error.HTTPError as error:
                if error.code == 404 and not previous:
                    continue
                raise ValueError("Release distribution returned HTTP " + str(error.code)) from None
            catalog, expires, digest = verify(raw)
            if expires <= now:
                raise ValueError("Distribution metadata expired; check the clock or contact the release operator")
            if previous and (catalog["sequence"] < previous[0]["sequence"] or (catalog["sequence"] == previous[0]["sequence"] and digest != previous[2])):
                raise ValueError("Distribution rollback or sequence conflict rejected")
            fd, temporary = tempfile.mkstemp(dir=directory)
            with os.fdopen(fd, "wb") as output:
                output.write(raw)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, saved)
        releases.extend(catalog["repositories"].get(parts[2], {}).get("releases", []))
    releases.sort(key=lambda release: release.get("published_at", ""), reverse=True)
    return json.dumps(releases[(page - 1) * size:page * size], separators=(",", ":")).encode()


def main():
    try:
        policy = json.loads(sys.argv[1])
        result = distribution_bytes(policy, sys.argv[2], sys.argv[4])
        if result is None:
            return 3
        Path(sys.argv[3]).write_bytes(result)
        return 0
    except Exception as error:
        print("Release distribution: " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

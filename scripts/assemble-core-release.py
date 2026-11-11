#!/usr/bin/env python3
"""Write core-release.json (youeye.core-release.v1) and SHA256SUMS for one System release.

The document is unsigned. Its authority is "digest": whoever accepts it records
the exact sha256 of core-release.json, and every member artifact below it is
bound by sha256 and size. Python 3 standard library only.

Usage:
  assemble-core-release.py --version 0.6.0-dev.1 --source https://github.com/OWNER/YouEye \
      --branch dev --source-commit <40 hex> --channel dev --sequence 1 \
      --minimum-release 0.6.0-dev.1 --artifacts DIR [--tag youeye-v0.6.0-dev.1] \
      [--output DIR] [--previous-manifest-sha256 <64 hex>]

DIR must contain every asset listed in ROLES under its exact name. The tool
writes DIR/core-release.json and DIR/SHA256SUMS unless --output names another
directory. SHA256SUMS lists every asset including core-release.json and is for
humans only; nothing verifies it.

Member input_sha256 is sha256 of the UTF-8 text
"youeye.core-member-input.v1\\n<role>\\n<source_commit>\\n<artifact sha256>\\n":
it identifies the inputs of one member by the source commit it was built from
and the exact bytes it produced.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys

SCHEMA = "youeye.core-release.v1"

# Order matters: every dependency must appear earlier (releasecache Validate).
ROLES = [
    ("installer", "youeye-installer-linux-amd64"),
    ("media", "youeye-appliance-amd64.iso"),
    ("appliance", "appliance-manifest.json"),
    ("system-update", "system-update-manifest.json"),
    ("system-root", "system-root.img.zst"),
    ("system-a-uki", "system-a.efi"),
    ("system-b-uki", "system-b.efi"),
    ("system-updater", "youeye-system-updater-linux-amd64"),
    ("internal-recovery", "internal-recovery.img.zst"),
    ("recovery-uki", "recovery.efi"),
    ("update-bootstrap", "youeye-system-update-bootstrap"),
    ("spine", "spine-linux-amd64"),
    ("cp", "cp-standalone.tar"),
    ("ui", "ui-standalone.tar"),
]
BUILD_INPUTS = "build-inputs.json"  # bound to the appliance member
DEPENDS_ON = {"cp": ["spine"], "ui": ["cp"]}
# The persistent State/Data schema range this image line supports; it matches
# state_schema_* and data_schema_* in the appliance manifest.
COMPATIBILITY = {"state_min": 2, "state_max": 2, "data_min": 1, "data_max": 1}

VERSION = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\.([1-9][0-9]*))?$")
COMMIT = re.compile(r"^[0-9a-f]{40}$")
DIGEST = re.compile(r"^[0-9a-f]{64}$")


def fail(message):
    print("assemble-core-release: " + message, file=sys.stderr)
    sys.exit(1)


def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def check_channel(version, channel):
    suffix = VERSION.fullmatch(version).group(4) or ""
    if channel == "stable":
        ok = suffix == ""
    elif channel in ("beta", "alpha", "dev"):
        ok = suffix == channel
    elif channel == "feature":
        ok = suffix not in ("", "beta", "alpha", "dev")
    else:
        ok = False
    if not ok:
        fail(f"version {version} does not match channel {channel}")


def main():
    p = argparse.ArgumentParser(description="Write an unsigned youeye.core-release.v1 document.")
    p.add_argument("--version", required=True)
    p.add_argument("--tag")
    p.add_argument("--source", required=True, help="HTTPS repository URL, e.g. https://github.com/OWNER/YouEye")
    p.add_argument("--branch", required=True)
    p.add_argument("--source-commit", required=True)
    p.add_argument("--channel", required=True, choices=["dev", "alpha", "beta", "stable", "feature"])
    p.add_argument("--sequence", required=True, type=int)
    p.add_argument("--minimum-release", required=True)
    p.add_argument("--previous-manifest-sha256", default="")
    p.add_argument("--artifacts", required=True, type=Path, help="directory with every asset under its exact name")
    p.add_argument("--output", type=Path, help="output directory (default: --artifacts)")
    a = p.parse_args()

    tag = a.tag or "youeye-v" + a.version
    if not VERSION.fullmatch(a.version) or tag != "youeye-v" + a.version:
        fail("version must be X.Y.Z[-token.N] and tag youeye-v<version>")
    if not VERSION.fullmatch(a.minimum_release):
        fail("invalid --minimum-release")
    check_channel(a.version, a.channel)
    source = a.source.rstrip("/")
    if not re.fullmatch(r"https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/[A-Za-z0-9._~-]+/[A-Za-z0-9._~-]+", source):
        fail("--source must be https://host/owner/repository")
    if not COMMIT.fullmatch(a.source_commit):
        fail("--source-commit must be 40 lowercase hex characters")
    if not 1 <= a.sequence <= 9007199254740991:
        fail("--sequence must be a positive integer")
    if a.previous_manifest_sha256 and not DIGEST.fullmatch(a.previous_manifest_sha256):
        fail("invalid --previous-manifest-sha256")

    def blob(name):
        path = a.artifacts / name
        if not path.is_file() or path.is_symlink():
            fail(f"missing artifact {name} in {a.artifacts}")
        size = path.stat().st_size
        if size <= 0:
            fail(f"artifact {name} is empty")
        return {"name": name, "url": f"{source}/releases/download/{tag}/{name}", "sha256": digest(path), "size_bytes": size}

    members = []
    for role, name in ROLES:
        artifact = blob(name)
        text = f"youeye.core-member-input.v1\n{role}\n{a.source_commit}\n{artifact['sha256']}\n"
        member = {
            "role": role,
            "build_version": a.version,
            "source": source,
            "branch": a.branch,
            "source_commit": a.source_commit,
            "tag": tag,
            "input_sha256": hashlib.sha256(text.encode()).hexdigest(),
            "artifact": artifact,
        }
        if DEPENDS_ON.get(role):
            member["depends_on"] = DEPENDS_ON[role]
        if role == "appliance":
            member["build_inputs"] = blob(BUILD_INPUTS)
        members.append(member)

    document = {
        "schema": SCHEMA,
        "version": a.version,
        "tag": tag,
        "source": source,
        "branch": a.branch,
        "source_commit": a.source_commit,
        "channel": a.channel,
        "sequence": a.sequence,
        "minimum_reader": 1,
        "authority": "digest",
        "compatibility": dict(COMPATIBILITY, minimum_release=a.minimum_release, capabilities=["core-release-v1"]),
        "members": members,
    }
    if a.previous_manifest_sha256:
        document["previous_manifest_sha256"] = a.previous_manifest_sha256

    output = a.output or a.artifacts
    output.mkdir(parents=True, exist_ok=True)
    raw = (json.dumps(document, indent=2) + "\n").encode()
    temporary = output / ".core-release.json.partial"
    temporary.write_bytes(raw)
    os.replace(temporary, output / "core-release.json")

    sums = {name: digest(a.artifacts / name) for _, name in ROLES}
    sums[BUILD_INPUTS] = digest(a.artifacts / BUILD_INPUTS)
    sums["core-release.json"] = hashlib.sha256(raw).hexdigest()
    lines = "".join(f"{sums[name]}  {name}\n" for name in sorted(sums))
    (output / "SHA256SUMS").write_text(lines)
    print(f"{sums['core-release.json']}  {output / 'core-release.json'}")


if __name__ == "__main__":
    main()

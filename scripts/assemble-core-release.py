#!/usr/bin/env python3
"""Write core-release.json (youeye.core-release.v1) and SHA256SUMS for one System release.

The document is unsigned. Its authority is "digest": whoever accepts it records
the exact sha256 of core-release.json, and every member artifact below it is
bound by sha256 and size. Python 3 standard library only.

Usage:
  assemble-core-release.py --version 0.6.1-rc.1 --source-tree <40 hex> \
      --minimum-release 0.6.1-rc.1 --artifacts DIR [--sequence N] [--output DIR] \
      [--reuse PREVIOUS-core-release.json=ROLE[,ROLE…]]…

--reuse keeps the named members of an earlier release of the same repository
unchanged: same build version, tree and digests, with the blob's "release"
naming the release that carries the file. "image" stands for every role except
spine, cp and ui. DIR then only needs the files of the roles built fresh.

DIR must contain every asset listed in ROLES under its exact name. The tool
writes DIR/core-release.json and DIR/SHA256SUMS unless --output names another
directory. SHA256SUMS lists every asset including core-release.json and is for
humans only; nothing verifies it.

The document is host-independent: it names assets but never says where they
live, and it carries the git tree (not a commit) the build came from. The same
bytes are published unchanged on every host a release is promoted to.

Member input_sha256 is sha256 of the UTF-8 text
"youeye.core-member-input.v1\\n<role>\\n<source_tree>\\n<artifact sha256>\\n".
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time

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
# Roles built from the service sources; every other role comes from the image build.
SERVICE_ROLES = {"spine", "cp", "ui"}
# The persistent State/Data schema range this image line supports; it matches
# state_schema_* and data_schema_* in the appliance manifest.
COMPATIBILITY = {"state_min": 2, "state_max": 2, "data_min": 1, "data_max": 1}

VERSION = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\.([1-9][0-9]*))?$")
TREE = re.compile(r"^[0-9a-f]{40}$")
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


def main():
    p = argparse.ArgumentParser(description="Write an unsigned youeye.core-release.v1 document.")
    p.add_argument("--version", required=True)
    p.add_argument("--source-tree", required=True, help="git tree id of the built source (git rev-parse <commit>^{tree})")
    p.add_argument("--sequence", type=int, default=int(time.time()), help="default: now, in Unix seconds")
    p.add_argument("--minimum-release", required=True)
    p.add_argument("--artifacts", required=True, type=Path, help="directory with every asset under its exact name")
    p.add_argument("--output", type=Path, help="output directory (default: --artifacts)")
    p.add_argument("--reuse", action="append", default=[], help="PREVIOUS-core-release.json=ROLE[,ROLE…] (image = all image roles)")
    a = p.parse_args()

    tag = "youeye-v" + a.version
    if not VERSION.fullmatch(a.version):
        fail("version must be X.Y.Z-rc.N")
    if not VERSION.fullmatch(a.minimum_release):
        fail("invalid --minimum-release")
    if not TREE.fullmatch(a.source_tree):
        fail("--source-tree must be 40 lowercase hex characters")
    if not 1 <= a.sequence <= 9007199254740991:
        fail("--sequence must be a positive integer")

    def blob(name):
        path = a.artifacts / name
        if not path.is_file() or path.is_symlink():
            fail(f"missing artifact {name} in {a.artifacts}")
        size = path.stat().st_size
        if size <= 0:
            fail(f"artifact {name} is empty")
        return {"name": name, "sha256": digest(path), "size_bytes": size}

    reused = {}
    for spec in a.reuse:
        path, _, roles = spec.partition("=")
        wanted = set()
        for role in roles.split(","):
            wanted |= {r for r, _ in ROLES if r not in SERVICE_ROLES} if role == "image" else {role}
        if not wanted <= {r for r, _ in ROLES}:
            fail("--reuse names an unknown role: " + roles)
        previous = json.loads(Path(path).read_text())
        if previous.get("schema") != SCHEMA:
            fail("--reuse " + path + " is not a core-release.json")
        for member in previous["members"]:
            if member["role"] not in wanted:
                continue
            if member["role"] in reused:
                fail("role " + member["role"] + " is reused twice")
            member = json.loads(json.dumps(member))
            for key in ("artifact", "build_inputs"):
                if key in member:
                    member[key].setdefault("release", previous["tag"])
            reused[member["role"]] = member

    members = []
    for role, name in ROLES:
        if role in reused:
            members.append(reused[role])
            continue
        artifact = blob(name)
        text = f"youeye.core-member-input.v1\n{role}\n{a.source_tree}\n{artifact['sha256']}\n"
        member = {
            "role": role,
            "build_version": a.version,
            "source_tree": a.source_tree,
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
        "source_tree": a.source_tree,
        "sequence": a.sequence,
        "minimum_reader": 1,
        "authority": "digest",
        "compatibility": dict(COMPATIBILITY, minimum_release=a.minimum_release, capabilities=["core-release-v1"]),
        "members": members,
    }

    output = a.output or a.artifacts
    output.mkdir(parents=True, exist_ok=True)
    raw = (json.dumps(document, indent=2) + "\n").encode()
    temporary = output / ".core-release.json.partial"
    temporary.write_bytes(raw)
    os.replace(temporary, output / "core-release.json")

    sums = {name: digest(a.artifacts / name) for role, name in ROLES if role not in reused}
    if "appliance" not in reused:
        sums[BUILD_INPUTS] = digest(a.artifacts / BUILD_INPUTS)
    sums["core-release.json"] = hashlib.sha256(raw).hexdigest()
    lines = "".join(f"{sums[name]}  {name}\n" for name in sorted(sums))
    (output / "SHA256SUMS").write_text(lines)
    print(f"{sums['core-release.json']}  {output / 'core-release.json'}")


if __name__ == "__main__":
    main()

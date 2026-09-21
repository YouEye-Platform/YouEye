#!/usr/bin/env python3
"""Embed reviewed public anchors before committing a public source snapshot.

This consumes the same source-owned policy as Go; it never downloads keys.
--check is the build/release gate and never changes source.
"""
import argparse
import json
from pathlib import Path
import re
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--require", choices=("stable", "beta"))
    args = parser.parse_args()
    policy_path = args.source / "installer/internal/installer/public-release-trust.json"
    policy = json.loads(policy_path.read_text())
    keys = policy.get("keys")
    if policy.get("schema") != "youeye.public-trust.v1" or not isinstance(keys, dict) or set(keys) - {"stable", "beta"}:
        parser.error("invalid public trust policy")
    development = (args.source / "installer/internal/installer/appliance-development.pub").read_bytes()
    def der(raw):
        result = subprocess.run(["openssl", "pkey", "-pubin", "-outform", "DER"], input=raw, capture_output=True, check=True)
        # RFC 8410 SubjectPublicKeyInfo: Ed25519 OID and a 32-byte key.
        if len(result.stdout) != 44 or result.stdout[:12] != bytes.fromhex("302a300506032b6570032100"):
            parser.error("public release anchor must be Ed25519")
        return result.stdout
    development_der = der(development)
    for key in keys.values():
        if not isinstance(key, str) or der(key.encode("ascii")) == development_der:
            parser.error("Development authority cannot be provisioned as public trust")
    if args.require and args.require not in keys:
        parser.error(f"public {args.require} trust is not provisioned")
    script = args.source / "installer/scripts/install.sh"
    original = script.read_text()
    pattern = r"(?m)(^# BEGIN GENERATED PUBLIC TRUST\n).*?(^# END GENERATED PUBLIC TRUST$)"
    generated, count = re.subn(pattern, lambda m: m[1] + json.dumps(policy, separators=(",", ":"), sort_keys=True) + "\n" + m[2], original, flags=re.S)
    if count != 1:
        parser.error("bootstrap must contain exactly one public trust block")
    distribution_path = args.source / "releasecache/distribution-policy.json"
    distribution = json.loads(distribution_path.read_text())
    distribution["keys"] = keys
    distribution_raw = json.dumps(distribution, separators=(",", ":"), sort_keys=True) + "\n"
    if args.check:
        if json.loads(distribution_path.read_text()) != distribution:
            parser.error("distribution anchors differ from the compiled policy")
    else:
        distribution_path.write_text(distribution_raw)
    # JSON public policy has no shell secrets, but quote it as shell data.
    import shlex
    generated, n = re.subn(r"(?m)^distribution_policy=.* # GENERATED DISTRIBUTION POLICY$", lambda _: "distribution_policy=" + shlex.quote(distribution_raw.strip()) + " # GENERATED DISTRIBUTION POLICY", generated)
    if n != 1:
        parser.error("bootstrap must contain one distribution policy")
    reader = (args.source / "releasecache/distribution.py").read_text()
    generated, n = re.subn(r"(?ms)(^# BEGIN GENERATED DISTRIBUTION READER\n).*?(^# END GENERATED DISTRIBUTION READER$)", lambda m: m[1] + reader + m[2], generated)
    if n != 1:
        parser.error("bootstrap must contain one distribution reader")
    network_path = args.source / "appliance/scripts/youeye-bootstrap-network"
    network = network_path.read_text()
    network_generated = re.sub(r"(?m)^distribution_policy=.* # GENERATED DISTRIBUTION POLICY$", lambda _: "distribution_policy=" + shlex.quote(distribution_raw.strip()) + " # GENERATED DISTRIBUTION POLICY", network)
    network_generated = re.sub(r"(?ms)(^# BEGIN GENERATED DISTRIBUTION READER\n).*?(^# END GENERATED DISTRIBUTION READER$)", lambda m: m[1] + reader + m[2], network_generated)
    if args.check:
        if network_generated != network:
            parser.error("network distribution reader differs from source")
    else:
        network_path.write_text(network_generated)
    if args.check:
        if generated != original:
            parser.error("bootstrap public trust differs from compiled policy; run embed-public-trust.py before committing the snapshot")
    elif generated != original:
        script.write_text(generated)


if __name__ == "__main__":
    main()

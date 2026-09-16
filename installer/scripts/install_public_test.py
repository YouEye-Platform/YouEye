#!/usr/bin/env python3
"""Exercise the piped bootstrap with real Ed25519 signatures and fake transport."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SIGNED = ["appliance-development.pub", "appliance-manifest.json", "appliance-manifest.json.sig",
          "internal-recovery.img.zst", "provenance.json", "recovery.efi", "sbom.spdx.json",
          "system-a.efi", "system-b.efi", "system-root.img.zst", "system-update-manifest.json",
          "system-update-manifest.json.sig", "youeye-appliance-amd64.iso",
          "youeye-installer-linux-amd64", "youeye-system-update-bootstrap", "youeye-system-updater-linux-amd64"]


def encoded(value):
    return json.dumps(value, sort_keys=True).encode()


def digest(value):
    return hashlib.sha256(value).hexdigest()


class BootstrapPublicTests(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory(prefix="youeye-public-bootstrap-test-")
        self.addCleanup(self.work.cleanup)
        self.root = Path(self.work.name)
        self.source = self.root / "source"
        self.scripts = self.source / "installer/scripts"
        self.policy = self.source / "installer/internal/installer"
        self.scripts.mkdir(parents=True)
        self.policy.mkdir(parents=True)
        for name in ["install.sh", "embed-public-trust.py"]:
            shutil.copyfile(ROOT / "installer/scripts" / name, self.scripts / name)
        shutil.copyfile(ROOT / "installer/internal/installer/appliance-development.pub", self.policy / "appliance-development.pub")
        self.keys = {}
        for name in ["stable", "beta", "wrong"]:
            key = self.root / (name + ".key")
            subprocess.run(["openssl", "genpkey", "-algorithm", "ED25519", "-out", str(key)], check=True, capture_output=True)
            self.keys[name] = subprocess.check_output(["openssl", "pkey", "-in", str(key), "-pubout"]).decode()
        (self.policy / "public-release-trust.json").write_bytes(encoded({"schema":"youeye.public-trust.v1", "keys":{k:self.keys[k] for k in ["stable", "beta"]}}))
        subprocess.run(["python3", str(self.scripts / "embed-public-trust.py")], check=True)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        for name in ["qm", "pvesm", "pvesh", "sgdisk"]:
            (self.bin / name).write_text("#!/bin/sh\nexit 0\n")
        (self.bin / "id").write_text("#!/bin/sh\nprintf '0\\n'\n")
        (self.bin / "curl").write_text('''#!/usr/bin/env python3
import os, sys
from pathlib import Path
from urllib.parse import urlparse, parse_qs
args = sys.argv[1:]
url = args[-1]
out = Path(args[args.index('-o')+1])
headers = Path(args[args.index('-D')+1])
root = Path(os.environ['FIXTURE_ROOT'])
parsed = urlparse(url)
with (root/'requests').open('a') as log: log.write(url+'\\n')
if parsed.hostname == 'api.github.com':
    name = 'index.json' if parse_qs(parsed.query)['page'] == ['1'] else 'empty.json'
else:
    name = parsed.path.rsplit('/',1)[-1]
out.write_bytes((root/name).read_bytes())
headers.write_bytes(b'HTTP/1.1 200 OK\\r\\n\\r\\n')
print('200',end='')
''')
        for file in self.bin.iterdir():
            file.chmod(0o755)

    def sign(self, data, key):
        (self.root / "sign-input").write_bytes(data)
        return subprocess.check_output(["openssl", "pkeyutl", "-sign", "-rawin", "-inkey", str(self.root / (key + ".key")), "-in", str(self.root / "sign-input")])

    def fixture(self, class_name, fault):
        version, branch = ("0.5.8", "main") if class_name == "stable" else ("0.5.7.1", "beta")
        tag = "appliance-v" + version if branch == "main" else "appliance-beta-v" + version
        source = "https://github.com/YouEye-Platform/YouEye"
        commit = "a" * 40
        components = {name:{"version":"1.0.0", "tag":name+"-v1.0.0", "source_commit":commit, "artifact_sha256":"b"*64} for name in ["spine", "control_panel", "ui"]}
        release = dict(source=source, branch=branch, fallback=[], **components)
        manifest = {"schema":"youeye.appliance.manifest.v1", "image_version":version, "source_commit":commit, "trust":{"class":class_name}, "release_set":release}
        market = {"source":"https://github.com/YouEye-Platform/Market", "branch":"main", "commit":"c"*40}
        lock = {"schema":"youeye.appliance.release-lock.v1", "image":{"version":version, "release_source":source, "release_branch":branch, "debian_snapshot":"20260805T142647Z"}, "components":json.loads(json.dumps(components)), "market":market}
        if fault == "wrong-component": lock["components"]["spine"]["source_commit"] = "d"*40
        if fault == "wrong-source": lock["image"]["release_source"] = "https://wrong.example/YouEye"
        if fault == "development-manifest": manifest["trust"]["class"] = "development"
        files = {name:b"fixture" for name in SIGNED}
        files["youeye-installer-linux-amd64"] = b"#!/bin/sh\nprintf 'VERIFIED-LAUNCH\\n'\n"
        files["appliance-development.pub"] = self.keys[class_name].encode()
        files["appliance-manifest.json"] = encoded(manifest)
        files["appliance-manifest.json.sig"] = self.sign(files["appliance-manifest.json"], class_name)
        files["release-lock.json"] = encoded(lock)
        provenance = {"schema":"youeye.appliance.provenance.v2", "source_commit":commit, "source":{"branch":branch, "commit":commit}, "release_set":release, "resolved_lock_sha256":digest(files["release-lock.json"]), "debian_snapshot":lock["image"]["debian_snapshot"], "market":{"source":market["source"], "branch":market["branch"], "source_commit":market["commit"]}}
        if fault == "wrong-lock-digest": provenance["resolved_lock_sha256"] = "0"*64
        if fault == "wrong-provenance-commit": provenance["source_commit"] = "e"*40
        files["provenance.json"] = encoded(provenance)
        files["SHA256SUMS"] = "".join(digest(files[name])+"  "+name+"\n" for name in SIGNED).encode()
        files["SHA256SUMS.sig"] = self.sign(files["SHA256SUMS"], "wrong" if fault == "wrong-signer" else class_name)
        if fault == "altered-lock": files["release-lock.json"] += b"\n"
        if fault == "altered-provenance": files["provenance.json"] += b"\n"
        if fault == "altered-installer": files["youeye-installer-linux-amd64"] += b"#changed\n"
        if fault == "missing-lock": del files["release-lock.json"]
        if fault == "extra-asset": files["extra.bin"] = b"extra"
        assets = [{"name":name, "browser_download_url":source+"/releases/download/"+tag+"/"+name} for name in files]
        if fault == "duplicate-lock": assets.append(next(a for a in assets if a["name"] == "release-lock.json").copy())
        (self.root / "index.json").write_bytes(encoded([{"tag_name":tag, "published_at":"2026-09-16T01:00:00Z", "prerelease":class_name == "beta", "draft":False, "assets":assets}]))
        (self.root / "empty.json").write_text("[]")
        for name, data in files.items(): (self.root / name).write_bytes(data)

    def test_signed_public_bootstrap(self):
        for class_name in ["stable", "beta"]:
            for fault in ["valid", "missing-lock", "extra-asset", "duplicate-lock", "altered-lock", "altered-provenance", "altered-installer", "wrong-lock-digest", "wrong-signer", "wrong-component", "wrong-source", "wrong-provenance-commit", "development-manifest"]:
                with self.subTest(channel=class_name, fault=fault):
                    self.fixture(class_name, fault)
                    env = dict(os.environ, PATH=str(self.bin)+":"+os.environ["PATH"], FIXTURE_ROOT=str(self.root), YOUEYE_INSTALLER_CACHE=str(self.root / "cache"))
                    args = ["sh", "-s", "--"]
                    if class_name == "beta": args += ["--channel", "branch", "--release-branch", "beta"]
                    result = subprocess.run(args, input=(self.scripts / "install.sh").read_bytes(), env=env, capture_output=True)
                    if fault == "valid":
                        self.assertEqual(result.returncode, 0, result.stderr.decode())
                        self.assertIn(b"VERIFIED-LAUNCH", result.stdout)
                    else:
                        self.assertNotEqual(result.returncode, 0, result.stdout.decode())
                        self.assertNotIn(b"VERIFIED-LAUNCH", result.stdout)

    def test_public_projection_gate(self):
        command = ["python3", str(self.scripts / "embed-public-trust.py"), "--check", "--require", "stable"]
        self.assertEqual(subprocess.run(command, capture_output=True).returncode, 0)
        (self.policy / "public-release-trust.json").write_bytes(encoded({"schema":"youeye.public-trust.v1", "keys":{"stable":self.keys["wrong"]}}))
        self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)
        (self.policy / "public-release-trust.json").write_bytes(encoded({"schema":"youeye.public-trust.v1", "keys":{"stable":(self.policy / "appliance-development.pub").read_text()}}))
        result = subprocess.run(command, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"Development authority", result.stderr)


if __name__ == "__main__":
    unittest.main()

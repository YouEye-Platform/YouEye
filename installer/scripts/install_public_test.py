#!/usr/bin/env python3
"""Exercise the piped bootstrap against a local HTTPS release server.

The server uses a throwaway self-signed certificate that the bootstrap trusts
through SSL_CERT_FILE, so normal certificate verification stays enabled.
"""
import hashlib
import http.server
import json
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import tempfile
import threading
import unittest

SCRIPT = Path(__file__).resolve().parent / "install.sh"
ROLES = ["installer", "media", "appliance", "system-update", "system-root", "system-a-uki", "system-b-uki",
         "system-updater", "internal-recovery", "recovery-uki", "update-bootstrap", "spine", "cp", "ui"]
INSTALLER = b"#!/bin/sh\nprintf '%s\\n' \"$*\" > \"$LAUNCH_LOG\"\n"


class Handler(http.server.BaseHTTPRequestHandler):
    routes = {}

    def do_GET(self):
        route = self.routes.get(self.path)
        if route is None:
            self.send_response(404)
            self.end_headers()
            return
        status, body, headers = route
        self.send_response(status)
        for key, value in headers.items():
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class BootstrapTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.work = tempfile.TemporaryDirectory(prefix="youeye-bootstrap-test-")
        root = Path(cls.work.name)
        cls.cert, key = root / "cert.pem", root / "key.pem"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
                        "-addext", "subjectAltName=DNS:localhost", "-keyout", str(key), "-out", str(cls.cert)],
                       check=True, capture_output=True)
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cls.cert, key)
        cls.server.socket = context.wrap_socket(cls.server.socket, server_side=True)
        cls.port = cls.server.server_address[1]
        cls.source = "https://localhost:%d/owner/YouEye" % cls.port
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.bin = root / "bin"
        cls.bin.mkdir()
        for name in ["qm", "pvesm", "pvesh", "sgdisk"]:
            (cls.bin / name).write_text("#!/bin/sh\nexit 0\n")
        (cls.bin / "id").write_text("#!/bin/sh\nprintf '0\\n'\n")
        for path in cls.bin.iterdir():
            path.chmod(0o755)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.work.cleanup()

    def setUp(self):
        Handler.routes = {}
        self.releases = []
        self.documents = {}
        self.case = Path(tempfile.mkdtemp(prefix="case-", dir=self.work.name))

    def publish(self, version, branch, prerelease=False, draft=False, installer=INSTALLER, served=None):
        tag = "youeye-v" + version
        base = "/owner/YouEye/releases/download/" + tag + "/"
        channel = version.split("-", 1)[1].split(".")[0] if "-" in version else "stable"
        members = []
        for role in ROLES:
            name = "youeye-installer-linux-amd64" if role == "installer" else role + ".bin"
            body = installer if role == "installer" else role.encode()
            member = {"role": role, "build_version": version, "source": self.source, "branch": branch,
                      "source_commit": "a" * 40, "tag": tag, "input_sha256": "c" * 64,
                      "artifact": {"name": name, "url": self.source + "/releases/download/" + tag + "/" + name,
                                   "sha256": hashlib.sha256(body).hexdigest(), "size_bytes": len(body)},
                      "depends_on": {"cp": ["spine"], "ui": ["cp"]}.get(role, [])}
            if role == "appliance":
                member["build_inputs"] = dict(member["artifact"], name="build-inputs.json",
                                              url=self.source + "/releases/download/" + tag + "/build-inputs.json")
            members.append(member)
            Handler.routes[base + name] = (200, served if served is not None and role == "installer" else body, {})
        document = {"schema": "youeye.core-release.v1", "version": version, "tag": tag, "source": self.source,
                    "branch": branch, "source_commit": "a" * 40, "channel": channel, "sequence": 1,
                    "minimum_reader": 1, "authority": "digest",
                    "compatibility": {"state_min": 1, "state_max": 1, "data_min": 1, "data_max": 1,
                                      "minimum_release": "0.5.37", "capabilities": ["core-release-v1"]},
                    "members": members}
        raw = json.dumps(document, indent=2).encode() + b"\n"
        self.documents[tag] = raw
        Handler.routes[base + "core-release.json"] = (200, raw, {})
        self.releases.append({"tag_name": tag, "draft": draft, "prerelease": prerelease,
                              "published_at": "2026-11-11T00:00:00Z",
                              "assets": [{"name": "core-release.json", "size": len(raw),
                                          "browser_download_url": self.source + "/releases/download/" + tag + "/core-release.json"}]})
        return tag

    def run_bootstrap(self, *args):
        api = "/api/v1/repos/owner/YouEye/releases"
        Handler.routes[api + "?limit=50&page=1"] = (200, json.dumps(self.releases).encode(), {})
        Handler.routes[api + "?limit=50&page=2"] = (200, b"[]", {})
        log = self.case / "launch.log"
        if log.exists():
            log.unlink()
        env = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ["PATH"], SSL_CERT_FILE=str(self.cert),
                   YOUEYE_INSTALLER_CACHE=str(self.case / "cache"), LAUNCH_LOG=str(log))
        for name in ["INSTALLER_REPOSITORY", "INSTALLER_CHANNEL", "INSTALLER_TAG", "INSTALLER_RELEASE_BRANCH"]:
            env.pop(name, None)
        result = subprocess.run(["sh", str(SCRIPT), "--repository", self.source, *args], env=env, capture_output=True, text=True, timeout=60)
        launched = log.read_text().strip() if log.exists() else None
        return result, launched

    def pinned(self, channel, tag, branch=None):
        """The Installer arguments for exactly the verified release."""
        digest = hashlib.sha256(self.documents[tag]).hexdigest()
        selection = "--repository %s --channel %s" % (self.source, channel)
        if branch:
            selection += " --release-branch " + branch
        return selection + " --release-tag %s --core-manifest-sha256 %s" % (tag, digest)

    def test_static_contract(self):
        text = SCRIPT.read_text()
        subprocess.run(["sh", "-n", str(SCRIPT)], check=True)
        self.assertIn('INSTALLER_REPOSITORY:-https://github.com/YouEye-Platform/YouEye', text)
        self.assertIn('INSTALLER_CHANNEL:-stable', text)
        self.assertIn("https://api.github.com/repos", text)
        self.assertIn("/api/v1/repos", text)
        self.assertIn("objects.githubusercontent.com", text)
        # Retired signing vocabulary, spelled in pieces so repository greps stay clean.
        for retired in ["git.potemk" + ".in", "openssl", "pkey" + "utl", "." + "sig", "SHA256SUMS", "GENERATED", "distribution", "trust_key"]:
            self.assertNotIn(retired, text)

    def test_stable_selects_newest_release_on_main(self):
        self.publish("0.6.0", "main")
        self.publish("0.6.2", "main")
        self.publish("0.7.0-dev.1", "dev", prerelease=True)
        self.publish("0.9.0", "main", draft=True)
        self.publish("0.8.0", "other")
        result, launched = self.run_bootstrap("--vmid", "166")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("youeye-v0.6.2", result.stdout)
        self.assertEqual(launched, "proxmox --vmid 166 " + self.pinned("stable", "youeye-v0.6.2"))

    def test_dev_selects_newest_dev_prerelease(self):
        self.publish("0.6.0", "main")
        self.publish("0.7.0-dev.2", "dev", prerelease=True)
        self.publish("0.7.0-dev.10", "dev", prerelease=True)
        self.publish("0.7.0-beta.1", "dev", prerelease=True)
        result, launched = self.run_bootstrap("--channel", "dev")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("youeye-v0.7.0-dev.10", result.stdout)
        self.assertEqual(launched, "proxmox " + self.pinned("development", "youeye-v0.7.0-dev.10"))

    def test_branch_selects_named_branch(self):
        self.publish("0.6.0", "main")
        self.publish("0.7.0-feature.3", "team/fix", prerelease=True)
        result, launched = self.run_bootstrap("--channel=branch", "--silent", "--release-branch", "team/fix")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(launched, "proxmox --silent " + self.pinned("branch", "youeye-v0.7.0-feature.3", "team/fix"))

    def test_exact_passes_tag_and_document_digest(self):
        tag = self.publish("0.6.0-dev.4", "dev", prerelease=True)
        digest = hashlib.sha256(self.documents[tag]).hexdigest()
        result, launched = self.run_bootstrap("--channel", "exact", "--release-tag", tag)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(launched, "proxmox --repository %s --channel exact --release-tag %s --core-manifest-sha256 %s" % (self.source, tag, digest))
        result, launched = self.run_bootstrap("--channel", "exact", "--release-tag", tag, "--core-manifest-sha256", "0" * 64)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("expected " + "0" * 64, result.stderr)
        self.assertIsNone(launched)

    def test_tampered_installer_is_refused(self):
        self.publish("0.6.0", "main", served=INSTALLER.replace(b"printf", b"PRINTF"))
        result, launched = self.run_bootstrap()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("installer checksum mismatch", result.stderr)
        self.assertIsNone(launched)
        self.assertFalse(list((self.case / "cache").rglob("youeye-installer-linux-amd64")))

    def test_redirect_to_another_host_is_refused(self):
        tag = self.publish("0.6.0", "main")
        path = "/owner/YouEye/releases/download/%s/youeye-installer-linux-amd64" % tag
        Handler.routes[path] = (302, b"", {"Location": "https://127.0.0.1:%d%s" % (self.port, path)})
        result, launched = self.run_bootstrap()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("untrusted location", result.stderr)
        self.assertIsNone(launched)

    def test_malformed_document_is_refused(self):
        tag = self.publish("0.6.0", "main")
        base = "/owner/YouEye/releases/download/%s/core-release.json" % tag
        Handler.routes[base] = (200, self.documents[tag].replace(b'"authority": "digest"', b'"authority": "ed25519"'), {})
        result, launched = self.run_bootstrap()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not describe this release", result.stderr)
        self.assertIsNone(launched)

    def test_option_errors(self):
        for args in (["--channel", "exact"], ["--channel", "nightly"], ["--release-tag", "youeye-v1.0.0"],
                     ["--channel", "branch"], ["--release-branch", "main"]):
            result, launched = self.run_bootstrap(*args)
            self.assertNotEqual(result.returncode, 0, args)
            self.assertIsNone(launched)


if __name__ == "__main__":
    if shutil.which("openssl") is None:
        raise SystemExit("openssl is required to create the throwaway test certificate")
    unittest.main()

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
         "system-updater", "internal-recovery", "recovery-uki", "spine", "cp", "ui"]
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
        self.documents = {}
        self.case = Path(tempfile.mkdtemp(prefix="case-", dir=self.work.name))

    def publish(self, version, installer=INSTALLER, served=None):
        tag = "youeye-v" + version
        base = "/owner/YouEye/releases/download/" + tag + "/"
        members = []
        for role in ROLES:
            name = "youeye-installer-linux-amd64" if role == "installer" else role + ".bin"
            body = installer if role == "installer" else role.encode()
            member = {"role": role, "build_version": version, "source_tree": "a" * 40, "input_sha256": "c" * 64,
                      "artifact": {"name": name, "sha256": hashlib.sha256(body).hexdigest(), "size_bytes": len(body)}}
            if role in ("cp", "ui"):
                member["depends_on"] = {"cp": ["spine"], "ui": ["cp"]}[role]
            if role == "appliance":
                member["build_inputs"] = dict(member["artifact"], name="build-inputs.json")
            members.append(member)
            Handler.routes[base + name] = (200, served if served is not None and role == "installer" else body, {})
        document = {"schema": "youeye.core-release.v1", "version": version, "build": version, "tag": tag, "source_tree": "a" * 40,
                    "sequence": 1, "minimum_reader": 1, "authority": "digest",
                    "compatibility": {"state_min": 1, "state_max": 1, "data_min": 1, "data_max": 1,
                                      "minimum_release": version, "capabilities": ["core-release-v1"]},
                    "members": members}
        raw = json.dumps(document, indent=2).encode() + b"\n"
        self.documents[tag] = raw
        Handler.routes[base + "core-release.json"] = (200, raw, {})
        return tag

    def index(self, channel, tag, repository=None):
        """Point channel's index at tag."""
        entry = {"repository": repository or self.source, "tag": tag, "version": tag[len("youeye-v"):], "build": tag[len("youeye-v"):],
                 "document": "core-release.json", "sha256": hashlib.sha256(self.documents[tag]).hexdigest()}
        body = json.dumps({"schema": "youeye.channel.v1", "channel": channel, "published_at": "2026-11-12T00:00:00Z",
                           "products": {"youeye": entry}}).encode()
        Handler.routes["/owner/YouEye/releases/download/channel-%s/index.json" % channel] = (200, body, {})

    def run_bootstrap(self, *args):
        log = self.case / "launch.log"
        if log.exists():
            log.unlink()
        env = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ["PATH"], SSL_CERT_FILE=str(self.cert),
                   YOUEYE_INSTALLER_CACHE=str(self.case / "cache"), LAUNCH_LOG=str(log), YOUEYE_BOOTSTRAP_RETRY_SECONDS="0")
        for name in ["INSTALLER_REPOSITORY", "INSTALLER_CHANNEL", "INSTALLER_TAG", "INSTALLER_CORE_MANIFEST_SHA256"]:
            env.pop(name, None)
        result = subprocess.run(["sh", str(SCRIPT), "--repository", self.source, *args], env=env, capture_output=True, text=True, timeout=60)
        launched = log.read_text().strip() if log.exists() else None
        return result, launched

    def pinned(self, channel, tag):
        """The Installer arguments for exactly the verified release."""
        digest = hashlib.sha256(self.documents[tag]).hexdigest()
        return "--repository %s --channel %s --release-tag %s --core-manifest-sha256 %s" % (self.source, channel, tag, digest)

    def test_static_contract(self):
        text = SCRIPT.read_text()
        subprocess.run(["sh", "-n", str(SCRIPT)], check=True)
        self.assertIn('INSTALLER_REPOSITORY:-https://github.com/YouEye-Platform/YouEye', text)
        self.assertIn('INSTALLER_CHANNEL:-stable', text)
        self.assertIn("https://releases.youeye.me", text)
        self.assertIn("channel-", text)
        # No release-listing API, no private hosts, no retired signing vocabulary
        # (spelled in pieces so repository greps stay clean).
        for retired in ["api.github" + ".com", "/api/v1/" + "repos", "per_page", "git.potemk" + ".in", "potem" + "sla",
                        "openssl", "pkey" + "utl", "." + "sig", "SHA256SUMS", "trust_key", "--release-branch"]:
            self.assertNotIn(retired, text)

    def test_channel_index_selects_its_release(self):
        old, new = self.publish("0.6.1-dev.1"), self.publish("0.6.1-dev.2")
        self.index("dev", new)
        self.index("alpha", old)
        result, launched = self.run_bootstrap("--channel", "dev", "--vmid", "166")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(new, result.stdout)
        self.assertEqual(launched, "proxmox --vmid 166 " + self.pinned("dev", new))
        result, launched = self.run_bootstrap("--channel=alpha", "--silent")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(launched, "proxmox --silent " + self.pinned("alpha", old))

    def test_missing_channel_index_is_reported(self):
        self.publish("0.6.1-dev.1")
        result, launched = self.run_bootstrap("--channel", "beta")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no channel index yet", result.stderr)
        self.assertIsNone(launched)

    def test_index_of_another_repository_is_refused(self):
        tag = self.publish("0.6.1-dev.1")
        self.index("dev", tag, repository="https://localhost:%d/other/YouEye" % self.port)
        result, launched = self.run_bootstrap("--channel", "dev")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not name a YouEye release of this repository", result.stderr)
        self.assertIsNone(launched)

    def test_document_must_match_index_digest(self):
        tag = self.publish("0.6.1-dev.1")
        self.index("dev", tag)
        Handler.routes["/owner/YouEye/releases/download/%s/core-release.json" % tag] = (200, self.documents[tag] + b" ", {})
        result, launched = self.run_bootstrap("--channel", "dev")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("expected", result.stderr)
        self.assertIsNone(launched)

    def test_rate_limit_is_reported_as_such(self):
        tag = self.publish("0.6.1-dev.1")
        Handler.routes["/owner/YouEye/releases/download/channel-dev/index.json"] = (429, b"", {})
        result, launched = self.run_bootstrap("--channel", "dev")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("rate-limited", result.stderr)
        self.assertNotIn("download failed", result.stderr)
        self.assertIsNone(launched)
        self.assertTrue(tag)

    def test_exact_release_passes_tag_and_document_digest(self):
        tag = self.publish("0.6.1-dev.4")
        digest = hashlib.sha256(self.documents[tag]).hexdigest()
        result, launched = self.run_bootstrap("--channel", "beta", "--release-tag", tag, "--core-manifest-sha256", digest)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(launched, "proxmox " + self.pinned("beta", tag))
        result, launched = self.run_bootstrap("--release-tag", tag, "--core-manifest-sha256", "0" * 64)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("expected " + "0" * 64, result.stderr)
        self.assertIsNone(launched)

    def test_tampered_installer_is_refused(self):
        tag = self.publish("0.6.1-dev.1", served=INSTALLER.replace(b"printf", b"PRINTF"))
        self.index("stable", tag)
        result, launched = self.run_bootstrap()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("installer checksum mismatch", result.stderr)
        self.assertIsNone(launched)
        self.assertFalse(list((self.case / "cache").rglob("youeye-installer-linux-amd64")))

    def test_redirect_leaving_https_or_to_a_listing_api_is_refused(self):
        # Any HTTPS host may serve a file (it is checked by SHA-256); plain HTTP
        # and release-listing APIs never.
        tag = self.publish("0.6.1-dev.1")
        self.index("stable", tag)
        path = "/owner/YouEye/releases/download/%s/youeye-installer-linux-amd64" % tag
        for location in ("http://localhost:%d%s" % (self.port, path), "https://api.github.com/repos/o/r/releases"):
            Handler.routes[path] = (302, b"", {"Location": location})
            result, launched = self.run_bootstrap()
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("untrusted location", result.stderr)
            self.assertIsNone(launched)

    def test_download_base_is_used_and_handed_to_the_installer(self):
        tag = self.publish("0.6.1-dev.1")
        self.index("stable", tag)
        mirror = "https://localhost:%d/mirror" % self.port
        prefix = "/owner/YouEye/releases/download/%s/" % tag
        for route in [r for r in Handler.routes if r.startswith(prefix)]:
            Handler.routes["/mirror/%s/%s" % (tag, route[len(prefix):])] = Handler.routes.pop(route)
        Handler.routes["/mirror/%s/core-release.json" % tag] = (200, self.documents[tag], {})
        index = json.loads(Handler.routes["/owner/YouEye/releases/download/channel-stable/index.json"][1])
        index["products"]["youeye"]["download_base"] = mirror
        index["products"]["youeye"]["future_field"] = True
        Handler.routes["/owner/YouEye/releases/download/channel-stable/index.json"] = (200, json.dumps(index).encode(), {})
        result, launched = self.run_bootstrap()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--download-base " + mirror, launched)

    def test_malformed_document_is_refused(self):
        tag = self.publish("0.6.1-dev.1")
        raw = self.documents[tag].replace(b'"authority": "digest"', b'"authority": "ed25519"')
        self.documents[tag] = raw
        Handler.routes["/owner/YouEye/releases/download/%s/core-release.json" % tag] = (200, raw, {})
        self.index("stable", tag)
        result, launched = self.run_bootstrap()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not describe this release", result.stderr)
        self.assertIsNone(launched)

    def test_option_errors(self):
        for args in (["--channel", "exact"], ["--channel", "nightly"], ["--channel", "branch"],
                     ["--release-tag", "youeye-v1.0.0-dev.1"], ["--core-manifest-sha256", "a" * 64]):
            result, launched = self.run_bootstrap(*args)
            self.assertNotEqual(result.returncode, 0, args)
            self.assertIsNone(launched)


if __name__ == "__main__":
    if shutil.which("openssl") is None:
        raise SystemExit("openssl is required to create the throwaway test certificate")
    unittest.main()

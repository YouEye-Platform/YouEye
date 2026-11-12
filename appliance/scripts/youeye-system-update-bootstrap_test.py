#!/usr/bin/env python3
"""Execute the bootstrap's real URL/transport helpers without guest mutation."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).with_name("youeye-system-update-bootstrap").read_text()
HELPERS = SOURCE[:SOURCE.index("# The Core bridge")]

class BootstrapTransport(unittest.TestCase):
    def shell(self, body, *args, env=None):
        return subprocess.run(["sh", "-c", HELPERS + body, "test", *args], env=env,
                              capture_output=True, text=True)

    def test_member_url_remains_bound_to_source_tag_and_name(self):
        source = "https://github.com/YouEye-Platform/YouEye"
        base = source + "/releases/download/youeye-v1.2.3/"
        self.assertEqual(self.shell('core_spine_url_valid "$1" "$2" "$3" "$4"',
            base+"spine-linux-amd64", source, "youeye-v1.2.3", "spine-linux-amd64").returncode, 0)
        for url in [base+"cp-spine-linux-amd64", base+"spine-linux-amd64?token=x",
                    base.replace("github.com", "foreign.test")+"spine-linux-amd64",
                    base.replace("1.2.3", "1.2.4")+"spine-linux-amd64"]:
            self.assertNotEqual(self.shell('core_spine_url_valid "$1" "$2" "$3" "$4"',
                url, source, "youeye-v1.2.3", "spine-linux-amd64").returncode, 0)

    def test_only_not_found_uses_selected_mirror(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            curl=root/"curl"
            curl.write_text("""#!/bin/sh
for argument do last=$argument; done
printf '%s\n' "$last" >> "$CALLS"
case "$last" in
  origin) printf '%s' "$STATUS"; [ "$STATUS" = 200 ] ;;
  mirror) exit 0 ;;
  *) exit 99 ;;
esac
""")
            curl.chmod(0o700)
            for status, expected, calls in [("200",0,["origin"]),("404",0,["origin","mirror"]),
                                            ("403",1,["origin"]),("500",1,["origin"]),
                                            ("000",1,["origin"])]:
                log=root/"calls"; log.write_text("")
                env=dict(os.environ,PATH=str(root)+":"+os.environ["PATH"],STATUS=status,CALLS=str(log))
                result=self.shell('core_fetch_file origin "$1" 100 mirror',str(root/"out"),env=env)
                self.assertEqual(result.returncode,expected,result.stderr)
                self.assertEqual(log.read_text().splitlines(),calls)
            log.write_text("")
            env["STATUS"]="404"
            self.assertNotEqual(self.shell('core_fetch_file origin "$1" 100',str(root/"out"),env=env).returncode,0)
            self.assertEqual(log.read_text().splitlines(),["origin"])

    def test_core_mode_requires_exact_release_url_and_digest_shape(self):
        script = Path(__file__).with_name("youeye-system-update-bootstrap")
        for args in [[], ["https://example.test/a.json"], ["--core", "http://forge.test/o/r/releases/download/youeye-v1.2.3/core-release.json"],
                     ["--core", "https://forge.test/o/r/releases/latest/download/core-release.json"]]:
            result = subprocess.run(["sh", str(script), *args], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
        # A valid release URL without the exact document digest is refused
        # before anything is fetched.
        url = "https://forge.test/o/r/releases/download/youeye-v1.2.3/core-release.json"
        def run(*args):
            return subprocess.run(["sh", "-c", 'id() { echo 0; }; curl() { echo fetched >&2; exit 99; }; . "$0"', str(script), *args],
                                  capture_output=True, text=True)
        missing = run("--core", url)
        self.assertEqual(missing.returncode, 2, missing.stderr)
        self.assertIn("requires --sha256", missing.stderr)
        for digest in ["a" * 63, "A" * 64]:
            result = run("--core", url, "--sha256", digest)
            self.assertEqual(result.returncode, 2, (digest, result.stderr))
            self.assertNotIn("fetched", result.stderr)
        # Control: a well-formed digest proceeds to the fetch.
        self.assertIn("fetched", run("--core", url, "--sha256", "a" * 64).stderr)
        self.assertNotIn("openssl", SOURCE)
        self.assertNotIn("signature", SOURCE)
        self.assertIn('.authority == "digest"', SOURCE)

if __name__ == "__main__": unittest.main()

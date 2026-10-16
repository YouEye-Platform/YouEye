#!/usr/bin/env python3
"""Execute the bootstrap's real URL/transport helpers without guest mutation."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).with_name("youeye-system-update-bootstrap").read_text()
HELPERS = SOURCE[:SOURCE.index("# The public Core bridge")]

class BootstrapTransport(unittest.TestCase):
    def shell(self, body, *args, env=None):
        return subprocess.run(["sh", "-c", HELPERS + body, "test", *args], env=env,
                              capture_output=True, text=True)

    def test_member_names_remain_bound_to_signed_tag_and_component(self):
        base = "https://github.com/YouEye-Platform/YouEye/releases/download/youeye-v1.2.3/"
        for suffix in ["spine-linux-amd64", "spine-spine-linux-amd64"]:
            self.assertEqual(self.shell('core_spine_url_valid "$1" "$2" "$3"',
                base+suffix, "youeye-v1.2.3", "spine-linux-amd64").returncode, 0)
        for url in [base+"cp-spine-linux-amd64", base+"spine-linux-amd64?token=x",
                    base.replace("github.com", "foreign.test")+"spine-linux-amd64",
                    base.replace("1.2.3", "1.2.4")+"spine-linux-amd64"]:
            self.assertNotEqual(self.shell('core_spine_url_valid "$1" "$2" "$3"',
                url, "youeye-v1.2.3", "spine-linux-amd64").returncode, 0)

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

if __name__ == "__main__": unittest.main()

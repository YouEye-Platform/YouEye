"""Exercise persistent identity and signing against OpenSSL's verifier."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('publisher.py')


class PublisherTest(unittest.TestCase):
    def test_identity_and_signed_outputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state = root / 'private'
            def run(*args, ok=True):
                result = subprocess.run([sys.executable, str(SCRIPT), '--state-dir', str(state), *map(str, args)], capture_output=True, text=True)
                self.assertEqual(result.returncode == 0, ok, result.stderr)
                return json.loads(result.stdout) if ok else None
            identity = run('init')
            self.assertEqual(identity, run('init'))
            public = root / 'public.pem'
            public.write_text(identity['public_key'])
            output = root / 'component'
            output.mkdir()
            for name in ['standalone.tar', 'provenance.json', 'sbom.spdx.json']:
                (output / name).write_bytes(name.encode())
            run('sign-component', '--directory', output)
            subprocess.run(['openssl','pkeyutl','-verify','-rawin','-pubin','-inkey',str(public),'-in',str(output/'SHA256SUMS'),'-sigfile',str(output/'SHA256SUMS.sig')], check=True, capture_output=True)
            run('sign-component','--directory',output,ok=False)
            system = root / 'system'
            system.mkdir()
            artifacts = []
            for role in ['system-root','system-a-uki','system-b-uki','system-updater']:
                data = role.encode()
                (system / role).write_bytes(data)
                artifacts.append({'role':role,'path':role,'size_bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
            manifest = system / 'system-update-manifest.json'
            manifest.write_text(json.dumps({'schema':'youeye.system-update.v1','trust':{'class':'development','key_id':identity['fingerprint'][:16]},'artifacts':artifacts}))
            (system/'system-root').write_bytes(b'tampered')
            run('sign-system-update','--directory',system,ok=False)
            self.assertFalse((system/'system-update-manifest.json.sig').exists())
            (system/'system-root').write_bytes(b'system-root')
            run('sign-system-update','--directory',system)
            subprocess.run(['openssl','pkeyutl','-verify','-rawin','-pubin','-inkey',str(public),'-in',str(manifest),'-sigfile',str(manifest)+'.sig'],check=True,capture_output=True)
            run('sign-system-update','--directory',system,ok=False)
            (state/'publisher.key').unlink()
            run('init',ok=False)
            self.assertFalse((state/'publisher.key').exists())


if __name__ == '__main__':
    unittest.main()

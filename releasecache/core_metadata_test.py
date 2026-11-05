#!/usr/bin/env python3
"""Consume the independent signed Go vector with the piped Installer verifier."""
import base64
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('core_bootstrap', ROOT/'core_bootstrap.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
VECTOR = json.loads((ROOT/'testdata/core-metadata-v2-vector.json').read_text())


class MetadataVector(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.key = self.root/'key.der'
        self.key.write_bytes(bytes.fromhex('302e020100300506032b657004220420')+bytes([19])*32)
        self.execution = base64.b64decode(VECTOR['execution'])
        self.signature = base64.b64decode(VECTOR['execution_signature'])
        self.proof = copy.deepcopy(VECTOR['proof'])

    def tearDown(self): self.temporary.cleanup()

    def sign(self, value):
        raw = self.root/'raw'; signature = self.root/'signature'
        raw.write_bytes(value)
        subprocess.run(['openssl','pkeyutl','-sign','-keyform','DER','-inkey',str(self.key),'-rawin','-in',str(raw),'-out',str(signature)],check=True,capture_output=True)
        return signature.read_bytes()

    def verify(self, execution=None, signature=None, proof=None, role_key=None):
        return core.verify_metadata_proof(execution or self.execution, signature or self.signature, proof if proof is not None else self.proof,
                                         VECTOR['public_key'], role_key or (lambda member:VECTOR['public_key']))

    def update_spine(self, marker):
        release=core.decode(self.execution)
        member=next(member for member in release['members'] if member['role']=='spine')
        provenance=core.metadata_json(marker)
        member['provenance'].update(sha256=hashlib.sha256(provenance).hexdigest(),size_bytes=len(provenance))
        sums=''.join(blob['sha256']+'  '+blob['name']+'\n' for blob in [member['artifact'],member['provenance'],member['sbom']]).encode()
        signature=self.sign(sums)
        member['checksums'].update(sha256=hashlib.sha256(sums).hexdigest(),size_bytes=len(sums))
        member['signature'].update(sha256=hashlib.sha256(signature).hexdigest(),size_bytes=len(signature))
        execution=core.metadata_json(release)
        proof=copy.deepcopy(self.proof)
        proof.update(execution_manifest_sha256=hashlib.sha256(execution).hexdigest(),spine_checksums=base64.b64encode(sums).decode(),spine_signature=base64.b64encode(signature).decode(),spine_provenance=base64.b64encode(provenance).decode())
        proof['documents']={field:None for field in proof['documents']}
        proof['bindings']=None; proof['advertised']=False
        return execution,self.sign(execution),proof

    def test_signed_go_vector_and_exact_normalized_digest(self):
        self.assertEqual(self.verify(),VECTOR['facts'])
        canonical=base64.b64decode(self.proof['documents']['canonical'])
        self.assertNotIn(b'://',canonical)
        self.assertEqual(hashlib.sha256(core.metadata_json(core.metadata_from_execution(core.decode(self.execution)))).hexdigest(),VECTOR['facts']['normalized_identity_sha256'])
        self.assertNotEqual(VECTOR['facts']['execution_manifest_sha256'],VECTOR['facts']['canonical_manifest_sha256'])
        self.assertEqual(core.metadata_json({'text':'<>&\u2028\u2029'}),b'{"text":"\\u003c\\u003e\\u0026\\u2028\\u2029"}\n')

    def test_stripping_advertisement_cannot_remove_required_pair(self):
        proof=copy.deepcopy(self.proof)
        proof['documents']={field:None for field in proof['documents']}; proof['advertised']=False; proof['bindings']=None
        with self.assertRaisesRegex(ValueError,'Required or partial'): self.verify(proof=proof)
        proof=copy.deepcopy(self.proof); proof['documents']['pair_signature']=None
        with self.assertRaisesRegex(ValueError,'Required or partial'): self.verify(proof=proof)

    def test_source_registry_and_current_role_authority_are_independent(self):
        proof=copy.deepcopy(self.proof); proof['bindings'][12]['original_source']='https://other.example.test/team/YouEye'
        with self.assertRaisesRegex(ValueError,'registry'): self.verify(proof=proof)
        wrong=self.root/'other.key'
        subprocess.run(['openssl','genpkey','-algorithm','Ed25519','-out',str(wrong)],check=True,capture_output=True)
        public=subprocess.check_output(['openssl','pkey','-in',str(wrong),'-pubout'],stderr=subprocess.DEVNULL).decode()
        with self.assertRaisesRegex(ValueError,'role authority'): self.verify(role_key=lambda member:public if member['role']=='cp' else VECTOR['public_key'])

    def test_genuine_legacy_proof_remains_readable_and_unknown_marker_rejects(self):
        execution,signature,proof=self.update_spine({'schema':'legacy'})
        self.assertEqual(self.verify(execution,signature,proof)['schema'],'youeye.core-release.v1')
        proof['bindings']={}
        with self.assertRaises(ValueError): self.verify(execution,signature,proof)
        execution,signature,proof=self.update_spine({'core_metadata':'future-v3'})
        with self.assertRaisesRegex(ValueError,'Unsupported'): self.verify(execution,signature,proof)

    def test_canonical_signature_rejects_changed_bytes_and_integer_shape(self):
        for change in [lambda raw:raw+b' ', lambda raw:raw.replace(b'"minimum_metadata_reader":2',b'"minimum_metadata_reader":2.0')]:
            proof=copy.deepcopy(self.proof); proof['documents']['canonical']=base64.b64encode(change(base64.b64decode(proof['documents']['canonical']))).decode()
            with self.assertRaises(ValueError): self.verify(proof=proof)
        with self.assertRaises(ValueError): core.decode('{"duplicate":1,"duplicate":2}')
        with self.assertRaises(ValueError): core.decode('{"number":NaN}')


if __name__ == '__main__': unittest.main()

#!/usr/bin/env python3
"""Persistent personal Ed25519 identity and detached release signing.

Run after the unsigned build in a separate trusted process. Private key bytes
are never printed or copied into release output. Requires OpenSSL.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile


def openssl(*args):
    return subprocess.check_output(['openssl', *map(str, args)], stderr=subprocess.PIPE)


def regular(path):
    if not stat.S_ISREG(path.lstat().st_mode):
        raise ValueError(f'Expected a regular, non-symlink file: {path.name}')


def identity(state):
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    if state.is_symlink() or state.stat().st_mode & 0o077:
        raise ValueError('Publisher state directory must be private (0700)')
    key = state / 'publisher.key'
    marker = state / 'identity.json'
    if marker.exists() and not key.exists():
        raise ValueError('Established signing key is missing; restore it instead of silently replacing trust')
    if not key.exists():
        # O_EXCL prevents a second initializer from replacing an established key.
        # Generate in a private temporary file; hard-link only a complete key.
        with tempfile.TemporaryDirectory(dir=state) as temp:
            generated = Path(temp) / 'key'
            openssl('genpkey', '-algorithm', 'ED25519', '-out', generated)
            generated.chmod(0o600)
            try:
                os.link(generated, key)
            except FileExistsError:
                pass
    regular(key)
    if key.stat().st_mode & 0o077:
        raise ValueError('Publisher private key must have mode 0600')
    public = openssl('pkey', '-in', key, '-pubout')
    der = openssl('pkey', '-in', key, '-pubout', '-outform', 'DER')
    if len(der) != 44 or not der.startswith(bytes.fromhex('302a300506032b6570032100')):
        raise ValueError('Persistent identity must use Ed25519')
    fingerprint = hashlib.sha256(der).hexdigest()
    if marker.exists():
        regular(marker)
        if json.loads(marker.read_text())['fingerprint'] != fingerprint:
            raise ValueError('Persistent publisher key changed; explicit trust enrollment is required')
    else:
        with marker.open('x') as stream:
            json.dump({'fingerprint': fingerprint}, stream)
    return key, public, fingerprint


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state-dir', type=Path, required=True, help='Persistent private publisher directory; keep it across builds')
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('init', help='Create an identity once and print only its public enrollment data')
    signing = sub.add_parser('sign-component', help='Sign a built component/app with existing provenance and SBOM')
    signing.add_argument('--directory', type=Path, required=True)
    signing.add_argument('--artifact', default='standalone.tar')
    system = sub.add_parser('sign-system-update', help='Sign an unsigned custom development update manifest and verify all its payload hashes')
    system.add_argument('--directory', type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    key, public, fingerprint = identity(args.state_dir.resolve())
    if args.command == 'init':
        print(json.dumps({'public_key': public.decode(), 'fingerprint': fingerprint}, indent=2))
        return
    root = args.directory.resolve()
    if root == args.state_dir.resolve() or args.state_dir.resolve().is_relative_to(root):
        raise ValueError('Release output must not contain the publisher private directory')
    if args.command == 'sign-system-update':
        manifest_path = root / 'system-update-manifest.json'
        regular(manifest_path)
        manifest = json.loads(manifest_path.read_text())
        if manifest.get('schema') != 'youeye.system-update.v1' or manifest.get('trust') != {'class': 'development', 'key_id': fingerprint[:16]}:
            raise ValueError('Unsigned system manifest must name this personal development signing identity')
        required = {'system-root', 'system-a-uki', 'system-b-uki', 'system-updater'}
        seen = set()
        for artifact in manifest.get('artifacts', []):
            name = artifact['path']
            if Path(name).name != name or name in {'.', '..'} or artifact['role'] not in required or artifact['role'] in seen:
                raise ValueError('Invalid system payload identity')
            seen.add(artifact['role'])
            path = root / name
            regular(path)
            with path.open('rb') as stream:
                digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            if digest != artifact['sha256'] or path.stat().st_size != artifact['size_bytes']:
                raise ValueError('System payload differs from its manifest')
        if seen != required:
            raise ValueError('Incomplete system update payload')
        signature = openssl('pkeyutl', '-sign', '-rawin', '-inkey', key, '-in', manifest_path)
        with (root / 'system-update-manifest.json.sig').open('xb') as stream:
            stream.write(signature)
        print(json.dumps({'publisher_fingerprint': fingerprint, 'origin': 'custom', 'signed_manifest': manifest_path.name}))
        return
    if Path(args.artifact).name != args.artifact or args.artifact in {'.', '..'}:
        raise ValueError('Artifact must be a plain filename')
    names = [args.artifact, 'provenance.json', 'sbom.spdx.json']
    for name in names:
        regular(root / name)
    # Never follow attacker-controlled output symlinks or overwrite published signatures.
    outputs = ['release-development.pub', 'SHA256SUMS', 'SHA256SUMS.sig']
    if any((root / name).exists() or (root / name).is_symlink() for name in outputs):
        raise ValueError('Signing outputs already exist; use a fresh unpublished output directory')
    names.append('release-development.pub')
    with tempfile.TemporaryDirectory(dir=args.state_dir) as staging:
        stage = Path(staging)
        (stage / 'release-development.pub').write_bytes(public)
        sums = []
        for name in sorted(names):
            path = stage / name if name == 'release-development.pub' else root / name
            with path.open('rb') as stream:
                digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            sums.append(f'{digest}  {name}\n')
        (stage / 'SHA256SUMS').write_text(''.join(sums))
        openssl('pkeyutl', '-sign', '-rawin', '-inkey', key, '-in', stage / 'SHA256SUMS', '-out', stage / 'SHA256SUMS.sig')
        openssl('pkeyutl', '-verify', '-pubin', '-inkey', stage / 'release-development.pub', '-rawin', '-in', stage / 'SHA256SUMS', '-sigfile', stage / 'SHA256SUMS.sig')
        for name in outputs:
            with (root / name).open('xb') as stream:
                stream.write((stage / name).read_bytes())
            (root / name).chmod(0o644)
    print(json.dumps({'publisher_fingerprint': fingerprint, 'signed_files': names, 'origin': 'custom'}))


if __name__ == '__main__':
    main()

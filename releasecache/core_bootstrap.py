#!/usr/bin/env python3
"""Select the signed Installer member of a complete release for piped bootstrap.

This reader only bootstraps the native Installer. The native reader independently
verifies the complete assembly and every selected artifact before installation.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from urllib.parse import urlparse, urljoin

VERSION = re.compile(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\.([1-9][0-9]*))?')
HASH = re.compile(r'[a-f0-9]{64}')
COMMIT = re.compile(r'[a-f0-9]{40}')
ROLES = {'installer', 'media', 'appliance', 'system-update', 'spine', 'cp', 'ui', 'system-root', 'system-a-uki', 'system-b-uki', 'system-updater', 'internal-recovery', 'recovery-uki', 'update-bootstrap'}
OFFICIAL = 'https://github.com/YouEye-Platform/YouEye'


def version(value):
    match = VERSION.fullmatch(value or '')
    return bool(match and len(match.group(4) or '') <= 63 and all(int(n) <= 9007199254740991 for n in [*match.group(1, 2, 3), match.group(5) or '0']))


def branch(value):
    return isinstance(value, str) and 0 < len(value) <= 96 and all(re.fullmatch(r'[A-Za-z0-9._-]+', p) and p not in {'.', '..'} and not p.startswith('.') and not p.endswith(('.', '.lock')) for p in value.split('/'))


def decode(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result: raise ValueError('Duplicate signed metadata field')
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs)


def verify(raw, signature, key):
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        (root/'key').write_text(key)
        (root/'raw').write_bytes(raw)
        (root/'sig').write_bytes(signature)
        result = subprocess.run(['openssl', 'pkeyutl', '-verify', '-pubin', '-inkey', str(root/'key'), '-rawin', '-in', str(root/'raw'), '-sigfile', str(root/'sig')], capture_output=True)
        if result.returncode: raise ValueError('Complete release signature rejected')
        der = subprocess.check_output(['openssl', 'pkey', '-pubin', '-in', str(root/'key'), '-outform', 'DER'], stderr=subprocess.DEVNULL)
        if len(der) != 44 or der[:12] != bytes.fromhex('302a300506032b6570032100'): raise ValueError('Ed25519 authority required')
        return hashlib.sha256(der).hexdigest()


def fetch(url, limit):
    origin = urlparse(url)
    current = url
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        for _ in range(11):
            parsed = urlparse(current)
            if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.fragment: raise ValueError('Invalid metadata transport')
            if origin.hostname == 'github.com':
                if parsed.hostname not in {'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'}: raise ValueError('Untrusted release redirect')
            elif parsed.netloc != origin.netloc: raise ValueError('Cross-origin release redirect')
            result = subprocess.run(['curl', '-sS', '--proto', '=https', '--max-redirs', '0', '--connect-timeout', '15', '--max-time', '120', '--max-filesize', str(limit), '-D', str(root/'headers'), '-o', str(root/'body'), '-w', '%{http_code}', current], check=True, capture_output=True)
            status = result.stdout.decode()
            if status in {'301', '302', '303', '307', '308'}:
                locations = [line.split(':', 1)[1].strip() for line in (root/'headers').read_text().splitlines() if line.lower().startswith('location:')]
                if len(locations) != 1: raise ValueError('Ambiguous metadata redirect')
                current = urljoin(current, locations[0]); continue
            raw = (root/'body').read_bytes()
            if status != '200' or not 0 < len(raw) <= limit: raise ValueError('Complete release metadata unavailable or oversized')
            return raw
    raise ValueError('Too many release redirects')


def scoped_url(url, source, tag, name, exact_name=True):
    prefix = source + '/releases/download/' + tag + '/'
    return bool(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,199}', name or '') and isinstance(url, str) and url.startswith(prefix) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,199}', url[len(prefix):]) and (not exact_name or url == prefix + name))


def select_core(provider, api, channel, selected_branch, exact, pages, destination, cache, policy, development_key):
    parsed = urlparse(api)
    parts = parsed.path.strip('/').split('/')
    source = ('https://github.com/' + '/'.join(parts[1:3])) if provider == 'github' else parsed.scheme + '://' + parsed.netloc + '/' + '/'.join(parts[3:5])
    wanted = 'main' if channel == 'stable' else 'dev' if channel == 'development' else selected_branch if channel == 'branch' else ''
    def key_for(raw_branch):
        if source != OFFICIAL:
            if provider == 'github': raise ValueError('Public repository authority is not provisioned')
            return development_key, 'development'
        scope = {'main':'stable', 'beta':'beta'}.get(raw_branch)
        key = policy.get('keys', {}).get(scope)
        if not key: raise ValueError('Public release authority is not provisioned')
        return key, scope
    releases = []
    seen = set()
    for page in pages:
        for release in decode(Path(page).read_bytes()):
            tag = release.get('tag_name', '')
            if tag in seen: raise ValueError('Duplicate provider release identity')
            seen.add(tag)
            if release.get('draft') or not tag.startswith('youeye-v') or not version(tag[8:]) or exact and tag != exact: continue
            # Reserved branch tokens are unambiguous; features use signed raw branches.
            token = VERSION.fullmatch(tag[8:]).group(4)
            expected = {'main':None if provider == 'github' else 'alpha', 'dev':'dev', 'beta':'beta', 'alpha':'alpha'}
            if wanted in expected and token != expected[wanted]: continue
            releases.append(release)
    if not releases: return False
    selected = None
    sequences = {}
    for release in releases:
        tag = release['tag_name']
        assets = {}
        for asset in release.get('assets', []):
            name = asset.get('name')
            if name in assets: raise ValueError('Duplicate release asset')
            assets[name] = asset
        raw_parts = []
        for name, limit in [('core-release.json', 1 << 20), ('core-release.json.sig', 64)]:
            url = assets.get(name, {}).get('browser_download_url')
            if not scoped_url(url, source, tag, name): raise ValueError('Complete metadata is not release scoped')
            raw_parts.append(fetch(url, limit))
        raw, signature = raw_parts
        manifest = decode(raw)
        raw_branch = manifest.get('branch')
        if not branch(raw_branch): raise ValueError('Invalid signed source branch')
        if wanted and raw_branch != wanted: continue
        key, trust = key_for(raw_branch)
        signer = verify(raw, signature, key)
        token = VERSION.fullmatch(tag[8:]).group(4)
        expected_channel = {'main':'stable' if provider == 'github' else 'alpha', 'dev':'dev', 'beta':'beta', 'alpha':'alpha'}.get(raw_branch, 'feature')
        if (manifest.get('schema') != 'youeye.core-release.v1' or manifest.get('minimum_reader') != 1 or manifest.get('source') != source or manifest.get('tag') != tag or manifest.get('version') != tag[8:] or manifest.get('signer_sha256') != signer or not COMMIT.fullmatch(manifest.get('source_commit', '')) or type(manifest.get('sequence')) is not int or not 0 < manifest['sequence'] <= 9007199254740991 or manifest.get('channel') != expected_channel or expected_channel != 'feature' and token != (None if expected_channel == 'stable' else expected_channel) or expected_channel == 'stable' and release.get('prerelease')): raise ValueError('Complete release identity or capability rejected')
        members = manifest.get('members', [])
        if len(members) != len(ROLES) or {m.get('role') for m in members} != ROLES: raise ValueError('Incomplete release membership')
        by_role = {m['role']:m for m in members}
        for m in members:
            if m.get('source') != source or not branch(m.get('branch')) or not version(m.get('build_version')) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,199}', m.get('tag', '')) or not COMMIT.fullmatch(m.get('source_commit', '')) or not HASH.fullmatch(m.get('key_id', '')): raise ValueError('Invalid original member identity')
            for field in ['artifact', 'checksums', 'signature', 'provenance', 'sbom', *[f for f in ['document_signature', 'release_lock'] if f in m]]:
                blob = m.get(field, {})
                if not scoped_url(blob.get('url'), source, m['tag'], blob.get('name'), False) or not HASH.fullmatch(blob.get('sha256', '')) or type(blob.get('size_bytes')) is not int or not 0 < blob['size_bytes'] <= 1 << 50: raise ValueError('Invalid signed member blob')
        host = by_role['appliance']
        member_key, member_trust = key_for(host['branch'])
        # The host's original member authority may be Stable inside a Beta assembly.
        if hashlib.sha256(subprocess.check_output(['openssl','pkey','-pubin','-outform','DER'], input=member_key.encode(), stderr=subprocess.DEVNULL)).hexdigest() != host['key_id']: raise ValueError('Original host authority changed')
        for role in ['installer', 'media', 'system-update', 'system-root', 'system-a-uki', 'system-b-uki', 'system-updater', 'internal-recovery', 'recovery-uki', 'update-bootstrap']:
            if any(by_role[role].get(k) != host.get(k) for k in ['build_version', 'tag', 'source_commit', 'source', 'branch', 'key_id', 'checksums', 'signature', 'provenance', 'sbom']): raise ValueError('Host members differ from their original signed build')
        digest = hashlib.sha256(raw).hexdigest()
        sequence = manifest['sequence']
        if sequence in sequences and sequences[sequence] != digest: raise ValueError('Conflicting complete release sequence')
        sequences[sequence] = digest
        if selected is None or sequence > selected[0]['sequence']: selected = (manifest, raw, signature, by_role, member_trust)
    if selected is None: return False
    manifest, raw, signature, members, trust = selected
    floor = Path(cache) / ('core-track-' + hashlib.sha256((source + '\0' + manifest['branch']).encode()).hexdigest() + '.json')
    if floor.exists() or floor.is_symlink():
        st = floor.lstat()
        if floor.is_symlink() or st.st_mode & 0o022 or st.st_size > 2 << 20: raise ValueError('Unsafe retained core sequence')
        previous = decode(floor.read_bytes())
        old_raw, old_sig = base64.b64decode(previous['manifest'], validate=True), base64.b64decode(previous['signature'], validate=True)
        verify(old_raw, old_sig, key_for(manifest['branch'])[0])
        old = decode(old_raw)
        if old['source'] != source or old['branch'] != manifest['branch']: raise ValueError('Retained track identity changed')
        if (not exact and manifest['sequence'] < old['sequence']) or (manifest['sequence'] == old['sequence'] and raw != old_raw): raise ValueError('Signed track moved backwards or equivocated')
    else: old = None
    if old is None or manifest['sequence'] > old['sequence']:
        with tempfile.NamedTemporaryFile(mode='w', prefix='.core-floor-', dir=floor.parent, delete=False) as output:
            temp = Path(output.name)
            json.dump({'manifest':base64.b64encode(raw).decode(), 'signature':base64.b64encode(signature).decode()}, output)
            output.flush(); os.fsync(output.fileno())
        os.replace(temp, floor)
        fd = os.open(floor.parent, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(fd)
        finally: os.close(fd)
    host = members['appliance']
    selection = [host['tag'], host['checksums']['url'], host['signature']['url'], members['installer']['artifact']['url'], trust, host['artifact']['url'], host['provenance']['url'], host.get('release_lock', {}).get('url', '-'), source if trust == 'development' and host['branch'] == 'main' else '-']
    Path(destination).write_text('\n'.join(selection) + '\n')
    Path(destination + '.core').write_text(json.dumps({'manifest':manifest, 'members':members, 'manifest_sha256':hashlib.sha256(raw).hexdigest()}))
    return True


if __name__ == '__main__':
    try:
        provider, api, channel, selected_branch, exact, destination, cache, policy, development_key, *pages = sys.argv[1:]
        public = decode('\n'.join(line for line in policy.splitlines() if not line.startswith('#')))
        if not select_core(provider, api, channel, selected_branch, exact, pages, destination, cache, public, development_key): sys.exit(3)
    except Exception as error:
        print('Complete release bootstrap rejected: ' + str(error), file=sys.stderr)
        sys.exit(1)

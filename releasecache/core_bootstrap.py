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
from urllib.parse import urlparse, urljoin, quote, unquote

VERSION = re.compile(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\.([1-9][0-9]*))?')
HASH = re.compile(r'[a-f0-9]{64}')
COMMIT = re.compile(r'[a-f0-9]{40}')
ROLES = {'installer', 'media', 'appliance', 'system-update', 'spine', 'cp', 'ui', 'system-root', 'system-a-uki', 'system-b-uki', 'system-updater', 'internal-recovery', 'recovery-uki', 'update-bootstrap'}
OFFICIAL = 'https://github.com/YouEye-Platform/YouEye'
METADATA_ASSETS = ('core-release-v2.json', 'core-release-v2.json.sig', 'core-compatibility.json', 'core-compatibility.json.sig')


def metadata_json(value):
    # encoding/json struct order, compact form, HTML escaping and final newline.
    text = json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
    for character in '<>&\u2028\u2029':
        text = text.replace(character, '\\u%04x' % ord(character))
    return (text + '\n').encode()


def metadata_equal(left, right):
    if type(left) is not type(right): return False
    if isinstance(left, dict): return left.keys() == right.keys() and all(metadata_equal(left[k], right[k]) for k in left)
    if isinstance(left, list): return len(left) == len(right) and all(metadata_equal(a, b) for a, b in zip(left, right))
    return left == right


def metadata_execution_valid(release):
    allowed = {'schema','version','tag','source','branch','source_commit','channel','sequence','previous_manifest_sha256','minimum_reader','signer_sha256','compatibility','members'}
    if type(release) is not dict or set(release) - allowed or release.get('schema') != 'youeye.core-release.v1' or type(release.get('minimum_reader')) is not int or release['minimum_reader'] != 1 or not version(release.get('version')) or release.get('tag') != 'youeye-v'+release['version'] or not repository(release.get('source')) or not branch(release.get('branch')) or not COMMIT.fullmatch(release.get('source_commit','')) or not HASH.fullmatch(release.get('signer_sha256','')) or type(release.get('sequence')) is not int or not 0 < release['sequence'] <= 9007199254740991: raise ValueError('Invalid execution identity')
    if release.get('previous_manifest_sha256') and not HASH.fullmatch(release['previous_manifest_sha256']): raise ValueError('Invalid execution lineage')
    token = VERSION.fullmatch(release['version']).group(4)
    channel = release.get('channel')
    if channel == 'stable': valid = token is None
    elif channel in ('alpha','beta','dev'): valid = token == channel
    else: valid = channel == 'feature' and token is not None and token not in ('alpha','beta','dev')
    if not valid: raise ValueError('Execution version/channel differs')
    c = release.get('compatibility')
    if type(c) is not dict or set(c) != {'state_min','state_max','data_min','data_max','minimum_release','capabilities'}: raise ValueError('Invalid execution compatibility')
    if any(type(c.get(field)) is not int or not 0 < c[field] <= 9007199254740991 for field in ('state_min','state_max','data_min','data_max')) or c['state_max'] < c['state_min'] or c['data_max'] < c['data_min'] or not version(c.get('minimum_release')): raise ValueError('Invalid execution compatibility range')
    caps = c.get('capabilities')
    if type(caps) is not list or any(not isinstance(value,str) or not value for value in caps) or len(set(caps)) != len(caps) or 'core-release-v1' not in caps: raise ValueError('Invalid execution capabilities')
    members = release.get('members')
    if type(members) is not list or len(members) != len(ROLES): raise ValueError('Incomplete execution roles')
    seen = set()
    for member in members:
        fields = {'role','build_version','source','branch','source_commit','tag','input_sha256','key_id','depends_on','artifact','checksums','signature','provenance','sbom','document_signature','release_lock'}
        if type(member) is not dict or set(member) - fields or member.get('role') not in ROLES or member['role'] in seen or not version(member.get('build_version')) or not repository(member.get('source')) or not branch(member.get('branch')) or not COMMIT.fullmatch(member.get('source_commit','')) or not HASH.fullmatch(member.get('input_sha256','')) or not HASH.fullmatch(member.get('key_id','')) or not isinstance(member.get('tag'),str) or not member['tag']: raise ValueError('Invalid original execution role')
        if channel in ('stable','beta'): metadata_member_channel(member, channel)
        deps = member.get('depends_on')
        if deps is None: deps = []
        if type(deps) is not list or any(not isinstance(value,str) or value not in seen for value in deps) or len(set(deps)) != len(deps) or member['role'] == 'cp' and 'spine' not in deps or member['role'] == 'ui' and 'cp' not in deps: raise ValueError('Invalid execution dependency graph')
        for field in ('artifact','checksums','signature','provenance','sbom','document_signature','release_lock'):
            blob = member.get(field)
            optional = field in ('document_signature','release_lock')
            expected = member['role'] in ('appliance','system-update') if field == 'document_signature' else member['role'] == 'appliance'
            if optional and not expected:
                if blob is not None: raise ValueError('Unexpected host evidence')
                continue
            if type(blob) is not dict or set(blob) != {'name','url','sha256','size_bytes'} or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,199}',blob.get('name','')) or not HASH.fullmatch(blob.get('sha256','')) or type(blob.get('size_bytes')) is not int or not 0 < blob['size_bytes'] <= 9007199254740991: raise ValueError('Invalid execution content')
            prefix = member['source']+'/releases/download/'+quote(member['tag'],safe='')+'/'
            address = blob.get('url')
            if not isinstance(address,str) or not address.startswith(prefix): raise ValueError('Unscoped execution content')
            suffix = unquote(address[len(prefix):]); parsed = urlparse(address)
            if not suffix or suffix in ('.','..') or any(character in suffix for character in '/\\\0') or parsed.username or parsed.password or parsed.query or parsed.fragment: raise ValueError('Unsafe execution content')
        seen.add(member['role'])


def metadata_identity(source, raw_branch, channel):
    if not repository(source): raise ValueError('Invalid original metadata repository')
    authority = 'development'
    if urlparse(source).hostname.lower() == 'github.com':
        authority = 'owner'
        if source == OFFICIAL:
            if raw_branch == 'main' and channel == 'stable': authority = 'official-stable'
            elif raw_branch == 'beta' and channel == 'beta': authority = 'official-beta'
            else: raise ValueError('Unsupported official metadata authority')
    return {'id': hashlib.sha256(source.encode()).hexdigest(), 'authority': authority, 'repository': urlparse(source).path.split('/')[-1]}


def metadata_member_channel(member, channel):
    if member['source'] != OFFICIAL: return channel
    match = VERSION.fullmatch(member['build_version'])
    if not match: raise ValueError('Invalid original member version')
    if member['branch'] == 'main' and match.group(4) is None: return 'stable'
    if member['branch'] == 'beta' and match.group(4) == 'beta': return 'beta'
    raise ValueError('Original public member branch/version differs')


def metadata_from_execution(release):
    compatibility = release['compatibility']
    for field in ('state_min', 'state_max', 'data_min', 'data_max'):
        if type(compatibility[field]) is not int or not 0 < compatibility[field] <= 9007199254740991: raise ValueError('Invalid compatibility integer')
    result = {'schema': 'youeye.core-metadata.v2', 'version': release['version'], 'tag': release['tag'],
              'publisher': metadata_identity(release['source'], release['branch'], release['channel']),
              'branch': release['branch'], 'source_commit': release['source_commit'], 'channel': release['channel'], 'sequence': release['sequence']}
    if release.get('previous_manifest_sha256'): result['previous_execution_manifest_sha256'] = release['previous_manifest_sha256']
    result.update({'minimum_metadata_reader': 2, 'minimum_execution_reader': 1, 'execution_schema': release['schema'],
                   'signer_sha256': release['signer_sha256'], 'required_capabilities': ['paired-v2'],
                   'compatibility': {field: compatibility[field] for field in ('state_min', 'state_max', 'data_min', 'data_max', 'minimum_release', 'capabilities')}, 'members': []})
    def content(blob):
        if type(blob['size_bytes']) is not int or not 0 < blob['size_bytes'] <= 9007199254740991: raise ValueError('Invalid content size')
        return {field: blob[field] for field in ('name', 'sha256', 'size_bytes')}
    for member in release['members']:
        value = {'role': member['role'], 'publisher': metadata_identity(member['source'], member['branch'], metadata_member_channel(member, release['channel'])),
                 'branch': member['branch'], 'build_origin': {'version': member['build_version'], 'tag': member['tag'], 'source_commit': member['source_commit'],
                 'input_sha256': member['input_sha256'], 'provenance_sha256': member['provenance']['sha256']}, 'key_id': member['key_id'], 'depends_on': member.get('depends_on') or [],
                 'artifact': content(member['artifact']), 'checksums': content(member['checksums']), 'signature': content(member['signature'])}
        for field in ('document_signature', 'release_lock'):
            if member.get(field) is not None: value[field] = content(member[field])
        value['provenance'] = content(member['provenance']); value['sbom'] = content(member['sbom'])
        result['members'].append(value)
    return result


def metadata_spine_required(member, key, checksums, signature, provenance):
    if member['role'] != 'spine' or len(checksums) > 1 << 20 or len(provenance) > 1 << 20 or len(signature) != 64: raise ValueError('Bounded Spine metadata required')
    for field, raw in [('checksums', checksums), ('signature', signature), ('provenance', provenance)]:
        if len(raw) != member[field]['size_bytes'] or hashlib.sha256(raw).hexdigest() != member[field]['sha256']: raise ValueError('Original Spine metadata differs')
    if verify(checksums, signature, key) != member['key_id']: raise ValueError('Original Spine authority changed')
    entries = {}
    for line in checksums.decode().removesuffix('\n').split('\n'):
        match = re.fullmatch(r'([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._-]{0,199})', line)
        if not match or match[2] in entries: raise ValueError('Malformed original Spine checksums')
        entries[match[2]] = match[1]
    for field in ('artifact', 'provenance', 'sbom'):
        if entries.get(member[field]['name']) != member[field]['sha256']: raise ValueError('Original Spine checksum coverage differs')
    parsed = decode(provenance)
    if type(parsed) is not dict: raise ValueError('Original Spine provenance must be an object')
    if 'core_metadata' not in parsed: return False
    if parsed['core_metadata'] != 'paired-v2': raise ValueError('Unsupported original Spine metadata capability')
    return True


def verify_metadata_proof(execution, execution_signature, proof, assembly_key, role_key):
    if not 0 < len(execution) <= 1 << 20 or len(execution_signature) != 64: raise ValueError('Bounded signed execution required')
    release = decode(execution)
    metadata_execution_valid(release)
    digest = hashlib.sha256(execution).hexdigest()
    if verify(execution, execution_signature, assembly_key) != release['signer_sha256']: raise ValueError('Execution authority differs')
    if type(proof) is not dict or set(proof) - {'schema', 'execution_manifest_sha256', 'advertised', 'spine_checksums', 'spine_signature', 'spine_provenance', 'documents', 'bindings'} or proof.get('schema') != 'youeye.core-metadata-proof.v1' or proof.get('execution_manifest_sha256') != digest or type(proof.get('advertised')) is not bool: raise ValueError('Metadata proof differs from execution')
    def unpack(value, limit):
        if value is None: return b''
        if not isinstance(value, str) or len(value) > ((limit + 2) // 3) * 4: raise ValueError('Metadata encoding exceeds bound')
        raw = base64.b64decode(value, validate=True)
        if len(raw) > limit or base64.b64encode(raw).decode() != value: raise ValueError('Invalid metadata encoding')
        return raw
    bindings = []
    for member in release['members']:
        key = role_key(member)
        der = subprocess.check_output(['openssl', 'pkey', '-pubin', '-outform', 'DER'], input=key.encode(), stderr=subprocess.DEVNULL)
        if len(der) != 44 or der[:12] != bytes.fromhex('302a300506032b6570032100') or hashlib.sha256(der).hexdigest() != member['key_id']: raise ValueError('Current original role authority differs')
        bindings.append({'identity': metadata_identity(member['source'], member['branch'], metadata_member_channel(member, release['channel'])),
                         'original_source': member['source'], 'branch': member['branch'], 'role': member['role'], 'key_id': member['key_id']})
    spine = next(member for member in release['members'] if member['role'] == 'spine')
    required = metadata_spine_required(spine, role_key(spine), unpack(proof['spine_checksums'], 1 << 20), unpack(proof['spine_signature'], 64), unpack(proof['spine_provenance'], 1 << 20))
    documents = proof['documents']
    if type(documents) is not dict or set(documents) - {'canonical', 'canonical_signature', 'pair', 'pair_signature'}: raise ValueError('Unsupported metadata documents')
    parts = [unpack(documents.get(name), limit) for name, limit in [('canonical', 1 << 20), ('canonical_signature', 64), ('pair', 1 << 20), ('pair_signature', 64)]]
    present = sum(bool(part) for part in parts)
    if present not in (0, 4) or (required or proof['advertised']) and present != 4: raise ValueError('Required or partial canonical metadata')
    facts = {'schema': 'youeye.core-release.v1', 'execution_manifest_sha256': digest}
    if not present:
        if proof.get('bindings') not in (None, []): raise ValueError('Legacy proof cannot enroll source identities')
        return facts
    canonical, canonical_signature, pair, pair_signature = parts
    expected = metadata_from_execution(release)
    parsed = decode(canonical)
    if '://' in json.dumps(parsed, ensure_ascii=False) or not metadata_equal(parsed, expected): raise ValueError('Canonical metadata identity differs')
    if verify(canonical, canonical_signature, assembly_key) != release['signer_sha256']: raise ValueError('Canonical metadata signer differs')
    expected_pair = {'schema': 'youeye.core-metadata-pair.v1', 'source_id': expected['publisher']['id'], 'branch': release['branch'], 'sequence': release['sequence'],
                     'execution_manifest_sha256': digest, 'canonical_manifest_sha256': hashlib.sha256(canonical).hexdigest(),
                     'normalized_identity_sha256': hashlib.sha256(metadata_json(expected)).hexdigest(), 'signer_sha256': release['signer_sha256']}
    if not metadata_equal(decode(pair), expected_pair) or verify(pair, pair_signature, assembly_key) != release['signer_sha256']: raise ValueError('Signed compatibility pair differs')
    if not metadata_equal(proof.get('bindings'), bindings): raise ValueError('Protected current source registry differs')
    facts.update({'schema': 'youeye.core-metadata.v2', 'canonical_manifest_sha256': expected_pair['canonical_manifest_sha256'],
                  'normalized_identity_sha256': expected_pair['normalized_identity_sha256'], 'bindings': bindings})
    return facts


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
    def nonfinite(_value): raise ValueError('Non-finite signed metadata number')
    if isinstance(raw, bytes): raw = raw.decode('utf-8')
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=nonfinite)


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


def repository(value):
    if not isinstance(value, str): return False
    parsed = urlparse(value)
    parts = parsed.path.lstrip('/').split('/')
    return bool(parsed.scheme == 'https' and parsed.hostname and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment and len(parts) == 2 and parsed.path == '/' + '/'.join(parts) and all(re.fullmatch(r'[A-Za-z0-9_.-]+', p) and p not in {'.', '..'} for p in parts))


def select_core(provider, api, channel, selected_branch, exact, pages, destination, cache, policy, development_key):
    parsed = urlparse(api)
    parts = parsed.path.strip('/').split('/')
    source = ('https://github.com/' + '/'.join(parts[1:3])) if provider == 'github' else parsed.scheme + '://' + parsed.netloc + '/' + '/'.join(parts[3:5])
    wanted = 'main' if channel == 'stable' else 'dev' if channel == 'development' else selected_branch if channel == 'branch' else ''
    def key_for(raw_branch, authority_source=source):
        if authority_source != OFFICIAL:
            if urlparse(authority_source).hostname == 'github.com': raise ValueError('Public repository authority is not provisioned')
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
            if not repository(m.get('source')) or not branch(m.get('branch')) or not version(m.get('build_version')) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,199}', m.get('tag', '')) or not COMMIT.fullmatch(m.get('source_commit', '')) or not HASH.fullmatch(m.get('key_id', '')): raise ValueError('Invalid original member identity')
            for field in ['artifact', 'checksums', 'signature', 'provenance', 'sbom', *[f for f in ['document_signature', 'release_lock'] if f in m]]:
                blob = m.get(field, {})
                if not scoped_url(blob.get('url'), m['source'], m['tag'], blob.get('name'), False) or not HASH.fullmatch(blob.get('sha256', '')) or type(blob.get('size_bytes')) is not int or not 0 < blob['size_bytes'] <= 1 << 50: raise ValueError('Invalid signed member blob')
        host = by_role['appliance']
        member_key, member_trust = key_for(host['branch'], host['source'])
        # The host's original member authority may be Stable inside a Beta assembly.
        if hashlib.sha256(subprocess.check_output(['openssl','pkey','-pubin','-outform','DER'], input=member_key.encode(), stderr=subprocess.DEVNULL)).hexdigest() != host['key_id']: raise ValueError('Original host authority changed')
        for role in ['installer', 'media', 'system-update', 'system-root', 'system-a-uki', 'system-b-uki', 'system-updater', 'internal-recovery', 'recovery-uki', 'update-bootstrap']:
            if any(by_role[role].get(k) != host.get(k) for k in ['build_version', 'tag', 'source_commit', 'source', 'branch', 'key_id', 'checksums', 'signature', 'provenance', 'sbom']): raise ValueError('Host members differ from their original signed build')
        digest = hashlib.sha256(raw).hexdigest()
        sequence = manifest['sequence']
        if sequence in sequences and sequences[sequence] != digest: raise ValueError('Conflicting complete release sequence')
        sequences[sequence] = digest
        if selected is None or sequence > selected[0]['sequence']: selected = (manifest, raw, signature, by_role, member_trust, assets)
    if selected is None: return False
    manifest, raw, signature, members, trust, selected_assets = selected
    # Authenticate original role authority and signed capability before writing
    # sequence state or selecting executable Installer bytes. A stripped asset
    # listing cannot downgrade a Spine which requires paired-v2.
    spine = members['spine']
    def read_blob(blob, limit):
        if not 0 < blob['size_bytes'] <= limit: raise ValueError('Original metadata exceeds bound')
        mirror_name = 'blob-' + blob['sha256']
        mirror = selected_assets.get(mirror_name, {}).get('browser_download_url')
        if scoped_url(mirror, source, manifest['tag'], mirror_name): address = mirror
        elif spine['source'] == source: address = blob['url']
        else: raise ValueError('Promoted metadata has no exact authenticated mirror')
        value = fetch(address, limit)
        if len(value) != blob['size_bytes'] or hashlib.sha256(value).hexdigest() != blob['sha256']: raise ValueError('Original metadata digest differs')
        return value
    spine_sums, spine_sig, spine_provenance = [read_blob(spine[field], limit) for field, limit in [('checksums',1 << 20), ('signature',64), ('provenance',1 << 20)]]
    required = metadata_spine_required(spine, key_for(spine['branch'], spine['source'])[0], spine_sums, spine_sig, spine_provenance)
    advertised = any(name in selected_assets for name in METADATA_ASSETS)
    documents = {name: None for name in ['canonical','canonical_signature','pair','pair_signature']}
    if required or advertised:
        for index, name in enumerate(METADATA_ASSETS):
            address = selected_assets.get(name, {}).get('browser_download_url')
            if not scoped_url(address, source, manifest['tag'], name): raise ValueError('Required canonical document unavailable or unscoped')
            value = fetch(address, 64 if index % 2 else 1 << 20)
            documents[list(documents)[index]] = base64.b64encode(value).decode()
    bindings = [{'identity': metadata_identity(member['source'], member['branch'], metadata_member_channel(member, manifest['channel'])),
                 'original_source': member['source'], 'branch': member['branch'], 'role': member['role'], 'key_id': member['key_id']} for member in manifest['members']]
    proof = {'schema':'youeye.core-metadata-proof.v1', 'execution_manifest_sha256':hashlib.sha256(raw).hexdigest(), 'advertised':advertised,
             'spine_checksums':base64.b64encode(spine_sums).decode(), 'spine_signature':base64.b64encode(spine_sig).decode(), 'spine_provenance':base64.b64encode(spine_provenance).decode(),
             'documents':documents, 'bindings':bindings if required or advertised else None}
    facts = verify_metadata_proof(raw, signature, proof, key_for(manifest['branch'])[0], lambda member:key_for(member['branch'],member['source'])[0])
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
    def transport(blob):
        if not blob: return '-'
        name = 'blob-' + blob['sha256']
        mirror = selected_assets.get(name, {}).get('browser_download_url')
        if scoped_url(mirror, source, manifest['tag'], name): return mirror
        if host['source'] != source: raise ValueError('Promoted release is missing its original payload mirror')
        return blob['url']
    selection = [host['tag'], transport(host['checksums']), transport(host['signature']), transport(members['installer']['artifact']), trust, transport(host['artifact']), transport(host['provenance']), transport(host.get('release_lock')), host['source'] if trust == 'development' and host['branch'] == 'main' else '-']
    Path(destination).write_text('\n'.join(selection) + '\n')
    Path(destination + '.core').write_text(json.dumps({'manifest':manifest, 'members':members, 'manifest_sha256':hashlib.sha256(raw).hexdigest(), 'metadata_proof':proof, 'metadata_schema':facts['schema']}))
    return True


if __name__ == '__main__':
    try:
        provider, api, channel, selected_branch, exact, destination, cache, policy, development_key, *pages = sys.argv[1:]
        public = decode('\n'.join(line for line in policy.splitlines() if not line.startswith('#')))
        if not select_core(provider, api, channel, selected_branch, exact, pages, destination, cache, public, development_key): sys.exit(3)
    except Exception as error:
        print('Complete release bootstrap rejected: ' + str(error), file=sys.stderr)
        sys.exit(1)

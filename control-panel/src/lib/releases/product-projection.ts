import { execShell, incusRequest } from '../incus/server';
import { installedProductProjection, parseProductRelease, verifyInstalledProductReceipt, type InstalledProductReceipt } from './product-release';

/** Platform-owned metadata outside the immutable application tree. */
export function productProjection(receipt: InstalledProductReceipt) {
  // Parse only to identify the separately scoped trust lookup, then authenticate.
  const { release } = parseProductRelease(Buffer.from(receipt.manifestBase64,'base64'));
  return installedProductProjection(verifyInstalledProductReceipt(receipt,
    {product:release.product,source:release.source,tag:release.tag}));
}
export async function productRuntimeIdentity(container: string): Promise<string> {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(container)) throw new Error('Invalid product runtime identity');
  const result = await incusRequest<{config:Record<string,string>}>('GET',`/1.0/instances/${encodeURIComponent(container)}`);
  const uuid = result.metadata?.config?.['volatile.uuid'];
  if (result.type === 'error' || !uuid || !/^[a-f0-9-]{36}$/i.test(uuid)) throw new Error('Product runtime identity is unavailable');
  return uuid;
}
export async function publishProductProjection(container: string, receipt: InstalledProductReceipt): Promise<string> {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(container)) throw new Error('Invalid product runtime identity');
  const runtimeUUID = await productRuntimeIdentity(container);
  const raw = Buffer.from(JSON.stringify({...productProjection(receipt),runtime_uuid:runtimeUUID})+'\n');
  const encoded = raw.toString('base64');
  const result = await execShell(container, `set -eu
p=/etc/youeye
if [ ! -e "$p" ]; then install -d -o root -g root -m 0755 "$p"; fi
test -d "$p" && test ! -L "$p"
test "$(stat -c %u "$p")" = 0
test $((0$(stat -c %a "$p") & 0022)) = 0
stage=$(mktemp "$p/.installed-release.XXXXXX")
trap 'rm -f -- "$stage"' EXIT
printf %s '${encoded}' | base64 -d > "$stage"
chown root:root "$stage"
chmod 0644 "$stage"
sync -f "$stage"
mv -T -- "$stage" "$p/installed-release.json"
sync -f "$p"
test "$(base64 -w0 "$p/installed-release.json")" = '${encoded}'
trap - EXIT`, {timeout:15_000});
  if (result.exitCode !== 0) throw new Error('Installed product projection did not converge');
  if (await productRuntimeIdentity(container) !== runtimeUUID) throw new Error('Product runtime changed during projection publication');
  return runtimeUUID;
}

export async function verifyProductProjection(container: string, receipt: InstalledProductReceipt, runtimeUUID: string): Promise<void> {
  if (await productRuntimeIdentity(container) !== runtimeUUID) throw new Error('Installed product runtime was replaced');
  const expected = Buffer.from(JSON.stringify({...productProjection(receipt),runtime_uuid:runtimeUUID})+'\n').toString('base64');
  const result = await execShell(container,`set -eu
p=/etc/youeye/installed-release.json
test -f "$p" && test ! -L "$p"
test "$(stat -c %u "$p")" = 0
test $((0$(stat -c %a "$p") & 0022)) = 0
test "$(stat -c %s "$p")" -lt 16384
test "$(base64 -w0 "$p")" = '${expected}'`,{timeout:10_000});
  if (result.exitCode !== 0) throw new Error('Installed product receipt does not match runtime projection');
}

import {createHash} from 'node:crypto';
import {z} from 'zod';
import {COPY_NATIVE_APPS,CopyInventoryError,inspectCopyClients} from './inventory';

const digest=z.string().regex(/^[a-f0-9]{64}$/);
const inventorySchema=z.object({
 schema:z.literal('youeye.copy-platform-inventory.v1'),
 sourceDomain:z.string().min(1).max(253),
 apps:z.array(z.object({
  appId:z.enum(COPY_NATIVE_APPS),installationId:z.string().uuid(),
  clientId:z.string().min(1).max(128),manifestSHA256:digest,
  containers:z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/)).min(1).max(16),
  desiredState:z.enum(['running','stopped']),
  database:z.object({name:z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/),role:z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/)}).strict().optional(),
  serviceCredential:z.object({installationId:z.string().uuid(),revision:z.number().int().positive()}).strict(),
 }).strict()).max(6),
 clientIds:z.array(z.string().min(1).max(128)).max(8),
 pointer:z.literal('local-data-without-provider-authority'),
 names:z.object({fingerprint:z.string().min(1).max(128),fqdn:z.string().max(253).nullable()}).strict().nullable(),
 sha256:digest,
}).strict();
export type CopyPlatformInventory=z.infer<typeof inventorySchema>;

/** Stable across native JSON object decoding/re-encoding. No private authority
 * belongs in this inventory; fingerprints bind its independently read source. */
function canonical(value:unknown):string{
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value!==null&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}';
 const encoded=JSON.stringify(value);if(encoded===undefined)throw new CopyInventoryError('Unsupported copy inventory value');return encoded;
}
export function copyPlatformDigest(value:unknown){return createHash('sha256').update(canonical(value)).digest('hex');}
export function readCopyPlatformInventory(value:unknown):CopyPlatformInventory{
 const parsed=inventorySchema.safeParse(value);if(!parsed.success)throw new CopyInventoryError('Exact native platform copy inventory required');
 const {sha256,...body}=parsed.data;
 if(copyPlatformDigest(body)!==sha256||new Set(body.apps.map(a=>a.appId)).size!==body.apps.length||body.apps.some(a=>a.clientId!==`youeye-app-${a.appId}`))throw new CopyInventoryError('Copy platform inventory binding changed');
 inspectCopyClients(body.apps,body.clientIds);
 return parsed.data;
}

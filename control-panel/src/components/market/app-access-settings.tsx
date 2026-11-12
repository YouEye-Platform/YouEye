'use client';



import { useTranslations as useInterfaceTranslations } from "next-intl";
import { useEffect, useState } from 'react';
import { authenticatedFetch } from '@/lib/api-client';
import type { AdmissionPolicy, ResourceOwnership } from '../../../../shared/admission';

interface AccessData {
  policy: AdmissionPolicy | null;
  reconciliation: 'applied' | 'pending';
  users: Array<{ id: string; label: string; username: string; active: boolean }>;
  groups: Array<{ id: string; label: string; key: string }>;
  resources: Array<{ resourceId: string; declaration: ResourceOwnership; state: string }>;
}
export function AppAccessSettings({ appId }: { appId: string }) {
  const translateInterface = useInterfaceTranslations("interface");

  const [data, setData] = useState<AccessData | null>(null);
  const [draft, setDraft] = useState<AdmissionPolicy | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const url = `/api/market/apps/${encodeURIComponent(appId)}/access`;
  useEffect(() => {
    let mounted = true;
    authenticatedFetch(url).then(async response => {
      if (!response.ok) throw new Error(response.status === 403 ? translateInterface("mf1e67275e7de") : translateInterface("m2c7d5f3825cc"));
      const current: AccessData = await response.json();
      if (mounted) { setData(current); setDraft(current.policy); }
    }).catch(err => { if (mounted) setError(err.message); });
    return () => { mounted = false; };
  }, [url]);
  const save = async (disposition?: string) => {
    if (!draft || !data?.policy) return;
    setSaving(true); setError('');
    try {
      const response = await authenticatedFetch(url, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(disposition
          ? { action: 'retain_quarantined', principalId: disposition, expectedRevision: data.policy.revision }
          : { policy: draft, expectedRevision: data.policy.revision }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || translateInterface("m9c6efb45910a"));
      setData(result); setDraft(result.policy);
    } catch (err) { setError(translateInterface("m9c6efb45910a")); }
    finally { setSaving(false); }
  };
  const toggle = (field: 'userIds' | 'groupIds', id: string) => {
    if (draft) setDraft({ ...draft, [field]: draft[field].includes(id)
      ? draft[field].filter(value => value !== id) : [...draft[field], id] });
  };
  return <section className="space-y-3 rounded-lg border p-4">
    <h3 className="font-medium">{translateInterface("maf0974a57d3f")}</h3>
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    {!error && !data && <p className="text-sm">{translateInterface("me660622f8a04")}</p>}
    {data && !draft && <p>{translateInterface("m0a2c07dac954")}</p>}
    {draft && data && <>
      <label className="block text-sm">{translateInterface("m7e00070b3601")}<select className="mt-1 w-full rounded border bg-background p-2" value={draft.ownerId}
          disabled={saving} onChange={event => setDraft({ ...draft, ownerId: event.target.value })}>
          {data.users.filter(user => user.active).map(user => <option key={user.id} value={user.id}>{user.label} ({user.username})</option>)}
        </select>
      </label>
      <p className="text-xs text-muted-foreground">{translateInterface("m71443c79e466")}</p>
      <label className="block text-sm">{translateInterface("m62fcd34b0c77")}<select className="mt-1 w-full rounded border bg-background p-2" value={draft.mode}
          disabled={saving} onChange={event => setDraft({ ...draft, mode: event.target.value as AdmissionPolicy['mode'] })}>
          <option value="owner">{translateInterface("m55a834c80aa9")}</option><option value="all_users">{translateInterface("m25198fab2c0e")}</option>
          <option value="groups">{translateInterface("m060a3e3bd53a")}</option><option value="users">{translateInterface("m682e39d68f55")}</option>
        </select>
      </label>
      {draft.mode === 'users' && <fieldset><legend>{translateInterface("m6b0cc904d081")}</legend>
        {data.users.filter(user => user.active).map(user => <label key={user.id} className="flex gap-2 text-sm">
          <input type="checkbox" checked={draft.userIds.includes(user.id)} disabled={saving}
            onChange={() => toggle('userIds', user.id)} />{user.label} ({user.username})
        </label>)}
      </fieldset>}
      {draft.mode === 'groups' && <fieldset><legend>{translateInterface("m39bbb719fa2b")}</legend>
        {data.groups.map(group => <label key={group.id} className="flex gap-2 text-sm">
          <input type="checkbox" checked={draft.groupIds.includes(group.id)} disabled={saving}
            onChange={() => toggle('groupIds', group.id)} />{group.label}
        </label>)}
      </fieldset>}
      <p className="text-xs text-muted-foreground">{translateInterface("m60939096be4b")}</p>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={draft.publicAccess} disabled={saving}
        onChange={event => setDraft({ ...draft, publicAccess: event.target.checked })} />
        {translateInterface("me8886dba5eee")}</label>
      <p className="text-xs text-muted-foreground">{translateInterface("m235d80077e2c")}</p>
      <p className="text-sm">{translateInterface("m6e5b0237b1e9", {state: draft.state, projection: data.reconciliation})}</p>
      {data.reconciliation === 'pending' && <p role="status">{translateInterface("mda07da60a224")}</p>}
      <p className="text-sm font-medium">{translateInterface("mc8337dc29bed")}</p>
      {data.resources.length ? <ul className="list-inside list-disc text-sm">
        {data.resources.map(resource => <li key={resource.resourceId}>{resource.resourceId}: {
          resource.declaration.scope.replaceAll('_', ' ')}; {
          resource.declaration.enforcement === 'app_native' ? translateInterface("mffbf105d59ad")
          : resource.declaration.enforcement === 'platform' ? translateInterface("m4552adbd0475") : translateInterface("m48b31282fcdf")
        }; {resource.state}</li>)}
      </ul> : <p className="text-sm">{translateInterface("m0e2352ed721c")}</p>}
      {[...new Set(data.resources.filter(r => r.state === 'active' || r.state === 'retained')
        .map(r => r.declaration.identityUserId || r.declaration.ownerId))].map(id =>
        <div key={id} className="text-sm">
          <button type="button" className="rounded border px-2 py-1" disabled={saving}
            onClick={() => save(id)}>{translateInterface("m29c4d5bf895a", {user: (() => { const user = data.users.find(u => u.id === id); return user ? `${user.label} (${user.username})` : id; })()})}</button>
          <p className="text-xs text-muted-foreground">{translateInterface("me81dccf553c2")}</p>
        </div>)}
      <p className="text-xs text-muted-foreground">{translateInterface("m126bc29c343c")}</p>
      <button type="button" className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground"
        disabled={saving || !['ready','quarantined'].includes(draft.state)} onClick={() => save()}>{saving ? translateInterface("m23e39291d613") : translateInterface("mbccae47f9f31")}</button>
    </>}
  </section>;
}

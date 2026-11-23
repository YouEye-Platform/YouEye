'use client';



import { useTranslations as useInterfaceTranslations } from "next-intl";
import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { groupClass, selectClass } from '@/components/settings-shell/app-section';
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
  const person = (id: string) => {
    const user = data?.users.find(u => u.id === id);
    return user ? `${user.label} (${user.username})` : id;
  };
  const checkRow = "flex min-h-9 items-start gap-2.5 py-1.5 text-sm pointer-coarse:min-h-11 pointer-coarse:py-2.5";
  const hint = "text-[13px] leading-relaxed text-muted-foreground";
  // No heading or frame of its own: the app's page gives this its "Who can use it" section.
  return <div className="min-w-0 space-y-3">
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!error && !data && <p className="text-sm text-muted-foreground">{translateInterface("me660622f8a04")}</p>}
    {data && !draft && <p className="text-sm text-muted-foreground">{translateInterface("m0a2c07dac954")}</p>}
    {draft && data && <div className={groupClass}>
      <div className="space-y-5 p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block min-w-0 space-y-1.5 text-sm">
            <span className="font-medium">{translateInterface("m62fcd34b0c77")}</span>
            <select className={selectClass} value={draft.mode}
              disabled={saving} onChange={event => setDraft({ ...draft, mode: event.target.value as AdmissionPolicy['mode'] })}>
              <option value="owner">{translateInterface("m55a834c80aa9")}</option><option value="all_users">{translateInterface("m25198fab2c0e")}</option>
              <option value="groups">{translateInterface("m060a3e3bd53a")}</option><option value="users">{translateInterface("m682e39d68f55")}</option>
            </select>
          </label>
          <label className="block min-w-0 space-y-1.5 text-sm">
            <span className="font-medium">{translateInterface("m7e00070b3601")}</span>
            <select className={selectClass} value={draft.ownerId}
              disabled={saving} onChange={event => setDraft({ ...draft, ownerId: event.target.value })}>
              {data.users.filter(user => user.active).map(user => <option key={user.id} value={user.id}>{user.label} ({user.username})</option>)}
            </select>
          </label>
        </div>
        {draft.mode === 'users' && <fieldset className="min-w-0"><legend className="text-sm font-medium">{translateInterface("m6b0cc904d081")}</legend>
          {data.users.filter(user => user.active).map(user => <label key={user.id} className={checkRow}>
            <input type="checkbox" className="mt-0.5 size-4 shrink-0" checked={draft.userIds.includes(user.id)} disabled={saving}
              onChange={() => toggle('userIds', user.id)} /><span className="min-w-0 [overflow-wrap:anywhere]">{user.label} ({user.username})</span>
          </label>)}
        </fieldset>}
        {draft.mode === 'groups' && <fieldset className="min-w-0"><legend className="text-sm font-medium">{translateInterface("m39bbb719fa2b")}</legend>
          {data.groups.map(group => <label key={group.id} className={checkRow}>
            <input type="checkbox" className="mt-0.5 size-4 shrink-0" checked={draft.groupIds.includes(group.id)} disabled={saving}
              onChange={() => toggle('groupIds', group.id)} /><span className="min-w-0 [overflow-wrap:anywhere]">{group.label}</span>
          </label>)}
        </fieldset>}
        <p className={hint}>{translateInterface("m60939096be4b")} {translateInterface("m71443c79e466")}</p>
        <div>
          <label className={checkRow}><input type="checkbox" className="mt-0.5 size-4 shrink-0" checked={draft.publicAccess} disabled={saving}
            onChange={event => setDraft({ ...draft, publicAccess: event.target.checked })} />
            <span className="min-w-0">{translateInterface("me8886dba5eee")}</span></label>
          <p className={`${hint} pl-[1.625rem]`}>{translateInterface("m235d80077e2c")}</p>
        </div>
        {/* The state line only when something is not settled yet. */}
        {(draft.state !== 'ready' || data.reconciliation !== 'applied') && (
          <p role="status" className="text-sm">{translateInterface("m6e5b0237b1e9", {state: draft.state, projection: data.reconciliation})}</p>
        )}
        {data.reconciliation === 'pending' && <p role="status" className="text-sm">{translateInterface("mda07da60a224")}</p>}
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center">
          <Button type="button" className="shrink-0"
            disabled={saving || !['ready','quarantined'].includes(draft.state)} onClick={() => save()}>{saving ? translateInterface("m23e39291d613") : translateInterface("mbccae47f9f31")}</Button>
          <p className={`${hint} min-w-0`}>{translateInterface("m126bc29c343c")}</p>
        </div>
      </div>
      {/* What the app keeps, per person or shared, and keeping a person's data aside: details, opened on request. */}
      <details className="group min-w-0">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 text-sm font-medium focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
          <span className="min-w-0 flex-1">{translateInterface("mc8337dc29bed")}</span>
          <span className="text-xs font-normal text-muted-foreground tabular-nums">{data.resources.length}</span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none" aria-hidden />
        </summary>
        <div className="space-y-3 px-4 pb-4">
          {data.resources.length ? <ul className="divide-y text-sm">
            {data.resources.map(resource => {
              const owner = data.users.find(u => u.id === (resource.declaration.identityUserId || ''));
              return <li key={resource.resourceId} className="min-w-0 py-2">
                <p className="font-medium [overflow-wrap:anywhere]">{owner ? `${owner.label} (${owner.username})` : resource.resourceId}</p>
                <p className="text-xs text-muted-foreground">{resource.declaration.scope.replaceAll('_', ' ')} · {
                  resource.declaration.enforcement === 'app_native' ? translateInterface("mffbf105d59ad")
                  : resource.declaration.enforcement === 'platform' ? translateInterface("m4552adbd0475") : translateInterface("m48b31282fcdf")
                } · {resource.state}</p>
              </li>;
            })}
          </ul> : <p className="text-sm text-muted-foreground">{translateInterface("m0e2352ed721c")}</p>}
          {(() => {
            const owners = [...new Set(data.resources.filter(r => r.state === 'active' || r.state === 'retained')
              .map(r => r.declaration.identityUserId || r.declaration.ownerId))];
            return owners.length > 0 && <div className="space-y-2">
              <p className={hint}>{translateInterface("me81dccf553c2")}</p>
              <div className="flex flex-wrap gap-2">
                {owners.map(id => <Button key={id} type="button" variant="outline" size="sm" className="h-auto min-h-8 whitespace-normal py-1.5 text-left" disabled={saving}
                  onClick={() => save(id)}>{translateInterface("m29c4d5bf895a", {user: person(id)})}</Button>)}
              </div>
            </div>;
          })()}
        </div>
      </details>
    </div>}
  </div>;
}

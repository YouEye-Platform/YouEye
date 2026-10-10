'use client';
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
  const [data, setData] = useState<AccessData | null>(null);
  const [draft, setDraft] = useState<AdmissionPolicy | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const url = `/api/market/apps/${encodeURIComponent(appId)}/access`;
  useEffect(() => {
    let mounted = true;
    authenticatedFetch(url).then(async response => {
      if (!response.ok) throw new Error(response.status === 403 ? 'Only an active administrator can manage app access.' : 'App access settings could not be loaded.');
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
      if (!response.ok) throw new Error(result.error || 'App access could not be saved.');
      setData(result); setDraft(result.policy);
    } catch (err) { setError(err instanceof Error ? err.message : 'App access could not be saved.'); }
    finally { setSaving(false); }
  };
  const toggle = (field: 'userIds' | 'groupIds', id: string) => {
    if (draft) setDraft({ ...draft, [field]: draft[field].includes(id)
      ? draft[field].filter(value => value !== id) : [...draft[field], id] });
  };
  return <section className="space-y-3 rounded-lg border p-4">
    <h3 className="font-medium">Household app access</h3>
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    {!error && !data && <p className="text-sm">Loading app access…</p>}
    {data && !draft && <p>This app needs owner resolution before anyone can enter. Resolve the appliance owner and retry installation reconciliation.</p>}
    {draft && data && <>
      <label className="block text-sm">Application owner
        <select className="mt-1 w-full rounded border bg-background p-2" value={draft.ownerId}
          disabled={saving} onChange={event => setDraft({ ...draft, ownerId: event.target.value })}>
          {data.users.filter(user => user.active).map(user => <option key={user.id} value={user.id}>{user.label} ({user.username})</option>)}
        </select>
      </label>
      <p className="text-xs text-muted-foreground">Changing ownership transfers app administration. It does not transfer another person’s private rows or files.</p>
      <label className="block text-sm">Who may enter
        <select className="mt-1 w-full rounded border bg-background p-2" value={draft.mode}
          disabled={saving} onChange={event => setDraft({ ...draft, mode: event.target.value as AdmissionPolicy['mode'] })}>
          <option value="owner">Owner only</option><option value="all_users">All active household users</option>
          <option value="groups">Selected groups</option><option value="users">Selected users</option>
        </select>
      </label>
      {draft.mode === 'users' && <fieldset><legend>Users</legend>
        {data.users.filter(user => user.active).map(user => <label key={user.id} className="flex gap-2 text-sm">
          <input type="checkbox" checked={draft.userIds.includes(user.id)} disabled={saving}
            onChange={() => toggle('userIds', user.id)} />{user.label} ({user.username})
        </label>)}
      </fieldset>}
      {draft.mode === 'groups' && <fieldset><legend>Groups</legend>
        {data.groups.map(group => <label key={group.id} className="flex gap-2 text-sm">
          <input type="checkbox" checked={draft.groupIds.includes(group.id)} disabled={saving}
            onChange={() => toggle('groupIds', group.id)} />{group.label}
        </label>)}
      </fieldset>}
      <p className="text-xs text-muted-foreground">The active owner is always included. Empty selections admit only the owner. Administrators have no automatic private-app access.</p>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={draft.publicAccess} disabled={saving}
        onChange={event => setDraft({ ...draft, publicAccess: event.target.checked })} />
        Make this app publicly reachable without household sign-in</label>
      <p className="text-xs text-muted-foreground">Public exposure bypasses the household gate for this app’s URLs. Protected UI services still require a granted active user.</p>
      <p className="text-sm">Policy: {draft.state}; household projection: {data.reconciliation}</p>
      {data.reconciliation === 'pending' && <p role="status">Saved; access remains pending. Existing protected UI access expires within 60 seconds if synchronization is unavailable.</p>}
      <p className="text-sm font-medium">Persistent data</p>
      {data.resources.length ? <ul className="list-inside list-disc text-sm">
        {data.resources.map(resource => <li key={resource.resourceId}>{resource.resourceId}: {
          resource.declaration.scope.replaceAll('_', ' ')}; {
          resource.declaration.enforcement === 'app_native' ? 'privacy enforced by the application'
          : resource.declaration.enforcement === 'platform' ? 'ownership enforced by the platform' : 'application-owned; privacy declaration needs review'
        }; {resource.state}</li>)}
      </ul> : <p className="text-sm">Application-owned data; privacy declaration needs review.</p>}
      {[...new Set(data.resources.filter(r => r.state === 'active' || r.state === 'retained')
        .map(r => r.declaration.identityUserId || r.declaration.ownerId))].map(id =>
        <div key={id} className="text-sm">
          <button type="button" className="rounded border px-2 py-1" disabled={saving}
            onClick={() => save(id)}>Retain {(() => {
              const user = data.users.find(u => u.id === id);
              return user ? `${user.label} (${user.username})` : 'this principal';
            })()}’s data in quarantine</button>
          <p className="text-xs text-muted-foreground">This retains the original data owner. Global or shared data quarantines the app. Transfer app administration separately before deleting its owner.</p>
        </div>)}
      <p className="text-xs text-muted-foreground">Changes reject future YouEye authorization and participating native sessions. An external app may retain its own cached session until logout or expiry.</p>
      <button type="button" className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground"
        disabled={saving || !['ready','quarantined'].includes(draft.state)} onClick={() => save()}>{saving ? 'Saving…' : 'Save app access'}</button>
    </>}
  </section>;
}

'use client';



import { useTranslations as useInterfaceTranslations } from "next-intl";
import { useEffect, useState } from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { groupClass, selectClass } from '@/components/settings-shell/app-section';
import { authenticatedFetch } from '@/lib/api-client';
import { accessSwitchState, putOnlyUsers } from '@/lib/market/public-access';
import type { AdmissionPolicy, ResourceOwnership } from '../../../../shared/admission';

interface AccessData {
  policy: AdmissionPolicy | null;
  reconciliation: 'applied' | 'pending';
  /** Set when "Only <site> users" must stay on, with the reason (YE-154). */
  gateOnly?: 'no-sign-in' | 'login-header' | null;
  host?: string | null;
  youEyeSignIn?: boolean;
  siteName?: string;
  users: Array<{ id: string; label: string; username: string; active: boolean }>;
  groups: Array<{ id: string; label: string; key: string }>;
  resources: Array<{ resourceId: string; declaration: ResourceOwnership; state: string }>;
}

/** How long the switch waits for public access to be applied before it offers to try again. */
const OPENING_WAIT_MS = 30_000;

export function AppAccessSettings({ appId, appName }: { appId: string; appName?: string }) {
  const translateInterface = useInterfaceTranslations("interface");
  const marketStore = useInterfaceTranslations("marketStore");
  const settingsApps = useInterfaceTranslations("settingsApps");

  const [data, setData] = useState<AccessData | null>(null);
  const [draft, setDraft] = useState<AdmissionPolicy | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [pendingPublic, setPendingPublic] = useState<boolean | null>(null);
  const [switchError, setSwitchError] = useState('');
  // The switch's last request, so "Try again" repeats it (opening, or closing).
  const [lastOnlyUsers, setLastOnlyUsers] = useState<boolean | null>(null);
  const [attempt, setAttempt] = useState(0);
  const url = `/api/market/apps/${encodeURIComponent(appId)}/access`;
  const load = async () => {
    const response = await authenticatedFetch(url);
    if (!response.ok) throw new Error(response.status === 403 ? translateInterface("mf1e67275e7de") : translateInterface("m2c7d5f3825cc"));
    return await response.json() as AccessData;
  };
  useEffect(() => {
    let mounted = true;
    load().then(current => { if (mounted) { setData(current); setDraft(current.policy); } })
      .catch(err => { if (mounted) setError(err.message); });
    return () => { mounted = false; };
  }, [url]);
  // While public access is saved but not applied, ask again until it is (or offer to try again).
  const waitingForOpen = data?.policy?.publicAccess === true && data.reconciliation !== 'applied';
  useEffect(() => {
    if (!waitingForOpen) return;
    let stopped = false;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > OPENING_WAIT_MS) {
        clearInterval(timer);
        if (!stopped) setSwitchError(settingsApps("access.stillPending"));
        return;
      }
      load().then(current => {
        if (stopped) return;
        setData(current);
        setDraft(previous => previous && current.policy ? { ...previous, publicAccess: current.policy.publicAccess, revision: current.policy.revision, state: current.policy.state } : current.policy);
      }).catch(() => {});
    }, 2000);
    return () => { stopped = true; clearInterval(timer); };
  }, [waitingForOpen, url, attempt]);
  const save = async (disposition?: string) => {
    if (!draft || !data?.policy) return;
    setSaving(true); setError('');
    try {
      const response = await authenticatedFetch(url, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(disposition
          ? { action: 'retain_quarantined', principalId: disposition, expectedRevision: data.policy.revision }
          // The switch alone opens or closes the app; saving who may enter keeps it as it is.
          : { policy: { ...draft, publicAccess: data.policy.publicAccess }, expectedRevision: data.policy.revision }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || translateInterface("m9c6efb45910a"));
      setData(result); setDraft(result.policy);
    } catch (err) { setError(translateInterface("m9c6efb45910a")); }
    finally { setSaving(false); }
  };
  // The switch saves at once: off asks for public access, on closes the app to the policy's people again. A retry
  // reads the policy again first, so a revision conflict resolves instead of repeating (YE-168).
  const setOnlyUsers = async (onlyUsers: boolean, retry = false) => {
    if (!data?.policy) return;
    setPendingPublic(!onlyUsers); setSwitchError(''); setLastOnlyUsers(onlyUsers); setAttempt(count => count + 1);
    try {
      const result = await putOnlyUsers({
        load,
        put: async (body) => {
          const response = await authenticatedFetch(url, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
          });
          const answer = await response.json();
          if (!response.ok) throw new Error(answer.error || translateInterface("m9c6efb45910a"));
          return answer as AccessData;
        },
      }, data, onlyUsers, retry);
      setData(result);
      setDraft(previous => previous && result.policy ? { ...previous, publicAccess: result.policy.publicAccess, revision: result.policy.revision, state: result.policy.state } : result.policy);
    } catch (err) {
      setSwitchError(err instanceof Error ? err.message : translateInterface("m9c6efb45910a"));
    } finally { setPendingPublic(null); }
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
        {(() => {
          const state = accessSwitchState(data, pendingPublic);
          const site = data.siteName || 'YouEye';
          const app = appName || appId;
          const hintText = state.locked
            ? marketStore(data.gateOnly === 'login-header' ? 'install.onlyUsersLockedHeader' : 'install.onlyUsersLockedNoSignIn', { app, site })
            : state.onlyUsers
              ? settingsApps("access.onlyUsersOn")
              : `${marketStore('install.onlyUsersOff', { app, host: data.host || app })}${data.youEyeSignIn ? ` ${marketStore('install.onlyUsersOffSignIn', { site })}` : ''}`;
          const label = translateInterface("mc664ff9c2740", { site });
          return <div className="flex min-w-0 items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{label}</p>
              <p className={`${hint} mt-0.5`}>{hintText}</p>
              {state.opening && !switchError && <p role="status" className="mt-1 inline-flex items-center gap-1.5 text-[13px]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />{settingsApps("access.opening")}</p>}
              {switchError && <div role="alert" className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-destructive">
                <span className="min-w-0">{lastOnlyUsers === true
                  ? `${translateInterface("m9c6efb45910a")} ${switchError}` : settingsApps("access.notOpen", { app, error: switchError })}</span>
                {pendingPublic === null && <Button type="button" variant="outline" size="sm" className="h-7"
                  onClick={() => void setOnlyUsers(lastOnlyUsers ?? false, true)}>{settingsApps("access.retry")}</Button>}
              </div>}
            </div>
            <Switch className="shrink-0" checked={state.onlyUsers} aria-label={label}
              disabled={saving || pendingPublic !== null || state.locked || !['ready','quarantined'].includes(draft.state)}
              onCheckedChange={(checked) => void setOnlyUsers(checked)} />
          </div>;
        })()}
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block min-w-0 space-y-1.5 text-sm">
            <span className="font-medium">{translateInterface("m62fcd34b0c77")}</span>
            <select className={selectClass} value={draft.mode}
              disabled={saving} onChange={event => setDraft({ ...draft, mode: event.target.value as AdmissionPolicy['mode'] })}>
              <option value="owner">{translateInterface("m55a834c80aa9")}</option><option value="all_users">{translateInterface("m25198fab2c0e")}</option>
              <option value="groups">{translateInterface("m060a3e3bd53a")}</option><option value="users">{translateInterface("m682e39d68f55")}</option>
            </select>
            {accessSwitchState(data, pendingPublic).publicWhoHint && <span className={`${hint} block`}>{settingsApps('access.whoPublic', { app: appName || appId, site: data.siteName || 'YouEye' })}</span>}
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
        {/* The state line only when something is not settled yet. */}
        {(draft.state !== 'ready' || data.reconciliation !== 'applied') && (
          <p role="status" className="text-sm">{translateInterface("m6e5b0237b1e9", {state: draft.state, projection: data.reconciliation})}</p>
        )}
        {data.reconciliation === 'pending' && !accessSwitchState(data, pendingPublic).opening && <p role="status" className="text-sm">{translateInterface("mda07da60a224")}</p>}
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

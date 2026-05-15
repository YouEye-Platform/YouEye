'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import {
  Shield,
  Users,
  Loader2,
  AlertCircle,
  ArrowLeft,
  RefreshCw,
  Plus,
  Trash2,
  KeyRound,
  UserCheck,
  UserX,
  Search,
  FolderOpen,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useTranslations } from 'next-intl';

interface AuthentikUser {
  pk: number;
  username: string;
  name: string;
  email: string;
  is_active: boolean;
  is_superuser: boolean;
  type: string;
  last_login?: string;
}

interface AuthentikGroup {
  pk: string;
  name: string;
  is_superuser: boolean;
  num_pk: number;
  users_obj?: Array<{ pk: number; username: string }>;
}

interface Stats {
  version: string;
  build_hash: string;
  internal_url: string;
}

type TabType = 'overview' | 'users' | 'groups';

export default function AuthentikPage() {
  const t = useTranslations('authentik');
  const tc = useTranslations('common');
  const [tab, setTab] = useState<TabType>('overview');
  const [stats, setStats] = useState<Stats | null>(null);
  const [users, setUsers] = useState<AuthentikUser[]>([]);
  const [groups, setGroups] = useState<AuthentikGroup[]>([]);
  const [userCount, setUserCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Create user state
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [actionLoading, setActionLoading] = useState(false);

  // Create group state
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupSuperuser, setNewGroupSuperuser] = useState(false);

  // Set password state
  const [passwordUserId, setPasswordUserId] = useState<number | null>(null);
  const [passwordValue, setPasswordValue] = useState('');

  const fetchCsrf = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/csrf');
      if (res.ok) {
        const data = await res.json();
        setCsrfToken(data.csrfToken);
      }
    } catch { /* ignore */ }
  }, []);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch('/api/apps/authentik/stats');
      if (!res.ok) throw new Error('Failed to fetch stats');
      setStats(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    }
  }, []);

  const fetchUsers = useCallback(async (search?: string) => {
    try {
      const qs = search ? `?search=${encodeURIComponent(search)}` : '';
      const res = await fetch(`/api/apps/authentik/users${qs}`);
      if (!res.ok) throw new Error('Failed to fetch users');
      const data = await res.json();
      setUsers(data.results);
      setUserCount(data.pagination.count);
    } catch (err) {
      console.error('Failed to fetch users:', err);
    }
  }, []);

  const fetchGroups = useCallback(async () => {
    try {
      const res = await fetch('/api/apps/authentik/groups');
      if (!res.ok) throw new Error('Failed to fetch groups');
      const data = await res.json();
      setGroups(data.results);
    } catch (err) {
      console.error('Failed to fetch groups:', err);
    }
  }, []);

  useEffect(() => {
    const init = async () => {
      setLoading(true);
      await fetchCsrf();
      await fetchStats();
      await fetchUsers();
      setLoading(false);
    };
    init();
  }, [fetchCsrf, fetchStats, fetchUsers]);

  useEffect(() => {
    if (tab === 'groups') fetchGroups();
    if (tab === 'users') fetchUsers(searchQuery || undefined);
  }, [tab, fetchGroups, fetchUsers, searchQuery]);

  const handleCreateUser = async () => {
    if (!csrfToken || !newUsername || !newName) return;
    setActionLoading(true);
    try {
      const res = await fetch('/api/apps/authentik/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ username: newUsername, name: newName, email: newEmail }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create');
      }
      const user = await res.json();

      // Set password if provided
      if (newPassword) {
        await fetch(`/api/apps/authentik/users/${user.pk}/password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
          body: JSON.stringify({ password: newPassword }),
        });
      }

      setShowCreateUser(false);
      setNewUsername('');
      setNewName('');
      setNewEmail('');
      setNewPassword('');
      await fetchUsers();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed');
    } finally {
      setActionLoading(false);
    }
  };

  const handleDeleteUser = async (pk: number, username: string) => {
    if (!csrfToken || !confirm(`Delete user "${username}"? This cannot be undone.`)) return;
    setActionLoading(true);
    try {
      const res = await fetch(`/api/apps/authentik/users/${pk}`, {
        method: 'DELETE',
        headers: { 'X-CSRF-Token': csrfToken },
      });
      if (!res.ok) throw new Error('Failed to delete user');
      await fetchUsers();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed');
    } finally {
      setActionLoading(false);
    }
  };

  const handleToggleActive = async (pk: number, currentlyActive: boolean) => {
    if (!csrfToken) return;
    setActionLoading(true);
    try {
      const res = await fetch(`/api/apps/authentik/users/${pk}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ is_active: !currentlyActive }),
      });
      if (!res.ok) throw new Error('Failed to update user');
      await fetchUsers();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed');
    } finally {
      setActionLoading(false);
    }
  };

  const handleSetPassword = async () => {
    if (!csrfToken || !passwordUserId || !passwordValue) return;
    setActionLoading(true);
    try {
      const res = await fetch(`/api/apps/authentik/users/${passwordUserId}/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ password: passwordValue }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed');
      }
      setPasswordUserId(null);
      setPasswordValue('');
      alert('Password updated');
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed');
    } finally {
      setActionLoading(false);
    }
  };

  const handleCreateGroup = async () => {
    if (!csrfToken || !newGroupName) return;
    setActionLoading(true);
    try {
      const res = await fetch('/api/apps/authentik/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ name: newGroupName, is_superuser: newGroupSuperuser }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed');
      }
      setShowCreateGroup(false);
      setNewGroupName('');
      setNewGroupSuperuser(false);
      await fetchGroups();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed');
    } finally {
      setActionLoading(false);
    }
  };

  const handleDeleteGroup = async (pk: string, name: string) => {
    if (!csrfToken || !confirm(`Delete group "${name}"?`)) return;
    setActionLoading(true);
    try {
      const res = await fetch(`/api/apps/authentik/groups?id=${pk}`, {
        method: 'DELETE',
        headers: { 'X-CSRF-Token': csrfToken },
      });
      if (!res.ok) throw new Error('Failed to delete group');
      await fetchGroups();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed');
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
      </div>
    );
  }

  if (error && !stats) {
    return (
      <div className="space-y-4">
        <Link href="/apps" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
          <ArrowLeft className="h-4 w-4" /> {t('backToApps')}
        </Link>
        <Card className="border-red-200 bg-red-50">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-red-600">
              <AlertCircle className="h-5 w-5" />
              <span>{error}</span>
            </div>
            <p className="text-sm text-gray-500 mt-2">
              {t('deployHint')}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const tabs: { id: TabType; label: string; icon: typeof Shield }[] = [
    { id: 'overview', label: t('overview'), icon: Shield },
    { id: 'users', label: t('users'), icon: Users },
    { id: 'groups', label: t('groups'), icon: FolderOpen },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/apps" className="text-gray-400 hover:text-gray-600">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div className="p-2 bg-orange-100 rounded-lg">
            <Shield className="h-6 w-6 text-orange-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
            <p className="text-sm text-gray-500">{t('subtitle')}</p>
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={() => {
          fetchStats();
          if (tab === 'users') fetchUsers(searchQuery || undefined);
          if (tab === 'groups') fetchGroups();
        }}>
          <RefreshCw className="h-4 w-4 mr-1" /> {tc('refresh')}
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b">
        {tabs.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                tab === t.id
                  ? 'border-orange-500 text-orange-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              <Icon className="h-4 w-4" />
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Overview Tab */}
      {tab === 'overview' && stats && (
        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <Card>
              <CardContent className="pt-4 pb-3">
                <div className="flex items-center gap-2 text-sm text-gray-500">
                  <Shield className="h-4 w-4" />
                  {t('version')}
                </div>
                <p className="text-lg font-bold mt-1">{stats.version}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-3">
                <div className="flex items-center gap-2 text-sm text-gray-500">
                  <Users className="h-4 w-4" />
                  {t('totalUsers')}
                </div>
                <p className="text-2xl font-bold mt-1">{userCount}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-3">
                <div className="flex items-center gap-2 text-sm text-gray-500">
                  <FolderOpen className="h-4 w-4" />
                  Groups
                </div>
                <p className="text-2xl font-bold mt-1">{groups.length || '—'}</p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{t('serverInfo')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">{t('internalUrl')}</span>
                <span className="font-mono">{stats.internal_url}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">{t('buildHash')}</span>
                <span className="font-mono text-xs">{stats.build_hash}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">{t('externalUrl')}</span>
                <span className="font-mono">auth.youeye.local (via Caddy)</span>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Users Tab */}
      {tab === 'users' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <Input
                placeholder={t('searchUsers')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <Button size="sm" onClick={() => setShowCreateUser(!showCreateUser)}>
              <Plus className="h-4 w-4 mr-1" />
              {t('createUser')}
            </Button>
          </div>

          {showCreateUser && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{t('createUser')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <label className="text-sm text-gray-500">{t('username')}</label>
                    <Input value={newUsername} onChange={(e) => setNewUsername(e.target.value)} placeholder="john.doe" />
                  </div>
                  <div>
                    <label className="text-sm text-gray-500">{t('fullName')}</label>
                    <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="John Doe" />
                  </div>
                  <div>
                    <label className="text-sm text-gray-500">{t('email')}</label>
                    <Input value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="john@example.com" />
                  </div>
                  <div>
                    <label className="text-sm text-gray-500">{t('password')}</label>
                    <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="min 8 characters" />
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleCreateUser} disabled={actionLoading || !newUsername || !newName}>
                    {actionLoading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Plus className="h-4 w-4 mr-1" />}
                    {t('create')}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setShowCreateUser(false)}>{tc('cancel')}</Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Set Password Dialog */}
          {passwordUserId !== null && (
            <Card className="border-blue-200">
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <KeyRound className="h-4 w-4" />
                  {t('setPasswordFor', { id: String(passwordUserId) })}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <Input
                  type="password"
                  value={passwordValue}
                  onChange={(e) => setPasswordValue(e.target.value)}
                  placeholder={t('newPasswordPlaceholder')}
                />
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleSetPassword} disabled={actionLoading || passwordValue.length < 8}>
                    {actionLoading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <KeyRound className="h-4 w-4 mr-1" />}
                    {t('setPassword')}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => { setPasswordUserId(null); setPasswordValue(''); }}>{tc('cancel')}</Button>
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent className="p-0">
              {users.length === 0 ? (
                <p className="text-gray-500 text-sm p-4">{t('noUsersFound')}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-gray-500 bg-gray-50">
                        <th className="px-4 py-2 font-medium">{t('username')}</th>
                        <th className="px-4 py-2 font-medium">{t('name')}</th>
                        <th className="px-4 py-2 font-medium">{t('email')}</th>
                        <th className="px-4 py-2 font-medium">{t('status')}</th>
                        <th className="px-4 py-2 font-medium">{t('type')}</th>
                        <th className="px-4 py-2 font-medium text-right">{t('actions')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {users.map((user) => (
                        <tr key={user.pk} className="hover:bg-gray-50">
                          <td className="px-4 py-2 font-mono flex items-center gap-2">
                            <Users className="h-4 w-4 text-gray-400" />
                            {user.username}
                            {user.is_superuser && (
                              <span className="text-xs bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded">{t('admin')}</span>
                            )}
                          </td>
                          <td className="px-4 py-2">{user.name}</td>
                          <td className="px-4 py-2 text-gray-500">{user.email || '—'}</td>
                          <td className="px-4 py-2">
                            {user.is_active ? (
                              <span className="inline-flex items-center gap-1 text-green-600">
                                <UserCheck className="h-3 w-3" /> {t('active')}
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-gray-400">
                                <UserX className="h-3 w-3" /> {t('inactive')}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2 text-gray-500 text-xs">{user.type}</td>
                          <td className="px-4 py-2 text-right">
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => handleToggleActive(user.pk, user.is_active)}
                                disabled={actionLoading}
                                title={user.is_active ? 'Deactivate' : 'Activate'}
                              >
                                {user.is_active ? <UserX className="h-4 w-4" /> : <UserCheck className="h-4 w-4" />}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => { setPasswordUserId(user.pk); setPasswordValue(''); }}
                                title="Set password"
                              >
                                <KeyRound className="h-4 w-4" />
                              </Button>
                              {user.type !== 'internal_service_account' && user.username !== 'akadmin' && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => handleDeleteUser(user.pk, user.username)}
                                  disabled={actionLoading}
                                  className="text-red-500 hover:text-red-700 hover:bg-red-50"
                                  title="Delete user"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
          <p className="text-xs text-gray-400">{t('totalUsersCount', { count: userCount })}</p>
        </div>
      )}

      {/* Groups Tab */}
      {tab === 'groups' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">{t('groups')}</h2>
            <Button size="sm" onClick={() => setShowCreateGroup(!showCreateGroup)}>
              <Plus className="h-4 w-4 mr-1" />
              {t('createGroup')}
            </Button>
          </div>

          {showCreateGroup && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{t('createGroup')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <label className="text-sm text-gray-500">{t('groupName')}</label>
                  <Input value={newGroupName} onChange={(e) => setNewGroupName(e.target.value)} placeholder="e.g. editors" />
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={newGroupSuperuser}
                    onChange={(e) => setNewGroupSuperuser(e.target.checked)}
                  />
                  {t('superuserGroup')}
                </label>
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleCreateGroup} disabled={actionLoading || !newGroupName}>
                    {actionLoading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Plus className="h-4 w-4 mr-1" />}
                    {t('create')}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setShowCreateGroup(false)}>{tc('cancel')}</Button>
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent className="p-0">
              {groups.length === 0 ? (
                <p className="text-gray-500 text-sm p-4">{t('noGroupsFound')}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-gray-500 bg-gray-50">
                        <th className="px-4 py-2 font-medium">{t('name')}</th>
                        <th className="px-4 py-2 font-medium">{t('superuser')}</th>
                        <th className="px-4 py-2 font-medium">{t('members')}</th>
                        <th className="px-4 py-2 font-medium text-right">{t('actions')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {groups.map((group) => (
                        <tr key={group.pk} className="hover:bg-gray-50">
                          <td className="px-4 py-2 font-mono flex items-center gap-2">
                            <FolderOpen className="h-4 w-4 text-gray-400" />
                            {group.name}
                          </td>
                          <td className="px-4 py-2">
                            <span className={group.is_superuser ? 'text-orange-600 font-medium' : 'text-gray-400'}>
                              {group.is_superuser ? 'Yes' : 'No'}
                            </span>
                          </td>
                          <td className="px-4 py-2 text-gray-600">
                            {group.users_obj?.length ?? group.num_pk} members
                          </td>
                          <td className="px-4 py-2 text-right">
                            {group.name !== 'authentik Admins' && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => handleDeleteGroup(group.pk, group.name)}
                                disabled={actionLoading}
                                className="text-red-500 hover:text-red-700 hover:bg-red-50"
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

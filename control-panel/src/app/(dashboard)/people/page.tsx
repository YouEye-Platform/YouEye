'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Users,
  Plus,
  ShieldCheck,
  Eye,
  EyeOff,
  Loader2,
  UserX,
  KeyRound,
  Trash2,
  X,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { authenticatedJson, authenticatedFetch } from '@/lib/api-client';

interface PeopleUser {
  pk: number;
  username: string;
  name: string;
  email: string;
  isActive: boolean;
  isAdmin: boolean;
  type: string;
  lastLogin: string | null;
  hidden: boolean;
}

export default function PeoplePage() {
  const t = useTranslations('people');
  const tc = useTranslations('common');
  const [users, setUsers] = useState<PeopleUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [actionLoading, setActionLoading] = useState<number | null>(null);

  // Create form state
  const [newUsername, setNewUsername] = useState('');
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newIsAdmin, setNewIsAdmin] = useState(false);
  const [createLoading, setCreateLoading] = useState(false);

  // Password dialog state
  const [passwordDialog, setPasswordDialog] = useState<{ pk: number; username: string } | null>(null);
  const [newPwd, setNewPwd] = useState('');

  const fetchUsers = useCallback(async () => {
    try {
      setLoading(true);
      const data = await authenticatedJson<{ users: PeopleUser[] }>(
        `/api/people?showHidden=${showHidden}`,
      );
      setUsers(data.users);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }, [showHidden]);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateLoading(true);
    try {
      await authenticatedJson('/api/people', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: newUsername,
          name: newName,
          email: newEmail || undefined,
          password: newPassword || undefined,
          isAdmin: newIsAdmin,
        }),
      });
      setShowCreateForm(false);
      setNewUsername(''); setNewName(''); setNewEmail(''); setNewPassword(''); setNewIsAdmin(false);
      await fetchUsers();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create user');
    } finally {
      setCreateLoading(false);
    }
  }

  async function toggleAdmin(user: PeopleUser) {
    setActionLoading(user.pk);
    try {
      await authenticatedJson(`/api/people/${user.pk}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isAdmin: !user.isAdmin }),
      });
      await fetchUsers();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to toggle admin');
    } finally {
      setActionLoading(null);
    }
  }

  async function toggleActive(user: PeopleUser) {
    setActionLoading(user.pk);
    try {
      await authenticatedJson(`/api/people/${user.pk}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !user.isActive }),
      });
      await fetchUsers();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to toggle user');
    } finally {
      setActionLoading(null);
    }
  }

  async function handleSetPassword() {
    if (!passwordDialog || !newPwd) return;
    setActionLoading(passwordDialog.pk);
    try {
      await authenticatedJson(`/api/people/${passwordDialog.pk}/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: newPwd }),
      });
      setPasswordDialog(null);
      setNewPwd('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to set password');
    } finally {
      setActionLoading(null);
    }
  }

  async function handleDelete(user: PeopleUser) {
    if (!confirm(`Delete user "${user.username}"? This cannot be undone.`)) return;
    setActionLoading(user.pk);
    try {
      await authenticatedFetch(`/api/people/${user.pk}`, { method: 'DELETE' });
      await fetchUsers();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete user');
    } finally {
      setActionLoading(null);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-purple-100 rounded-lg">
            <Users className="h-6 w-6 text-purple-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
            <p className="text-sm text-gray-500">{t('description')}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowHidden(!showHidden)}
            className="flex items-center gap-2 px-3 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            {showHidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            {showHidden ? t('hideSystem') : t('showHidden')}
          </button>
          <button
            onClick={() => setShowCreateForm(!showCreateForm)}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-purple-600 rounded-lg hover:bg-purple-700"
          >
            <Plus className="h-4 w-4" />
            {t('addUser')}
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm flex justify-between">
          {error}
          <button onClick={() => setError(null)}><X className="h-4 w-4" /></button>
        </div>
      )}

      {/* Create Form */}
      {showCreateForm && (
        <div className="bg-white border border-gray-200 rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-4">{t('createUser')}</h2>
          <form onSubmit={handleCreate} className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{t('username')} *</label>
              <input
                type="text" required value={newUsername} onChange={e => setNewUsername(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                placeholder="jdoe"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{t('fullName')} *</label>
              <input
                type="text" required value={newName} onChange={e => setNewName(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                placeholder="Jane Doe"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{t('email')}</label>
              <input
                type="email" value={newEmail} onChange={e => setNewEmail(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                placeholder="jane@example.com"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{t('password')}</label>
              <input
                type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                placeholder="Min 8 characters"
              />
            </div>
            <div className="col-span-2 flex items-center gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={newIsAdmin} onChange={e => setNewIsAdmin(e.target.checked)} className="rounded" />
                {t('admin')}
              </label>
              <div className="flex-1" />
              <button
                type="button" onClick={() => setShowCreateForm(false)}
                className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50"
              >{tc('cancel')}</button>
              <button
                type="submit" disabled={createLoading}
                className="px-4 py-2 text-sm font-medium text-white bg-purple-600 rounded-lg hover:bg-purple-700 disabled:opacity-50 flex items-center gap-2"
              >
                {createLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('create')}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Password Dialog */}
      {passwordDialog && (
        <div className="bg-white border border-gray-200 rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-4">{t('setPasswordFor', { username: passwordDialog.username })}</h2>
          <div className="flex gap-3">
            <input
              type="password" value={newPwd} onChange={e => setNewPwd(e.target.value)}
              className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500 focus:border-transparent"
              placeholder="New password (min 8 characters)"
            />
            <button
              onClick={() => { setPasswordDialog(null); setNewPwd(''); }}
              className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50"
            >{tc('cancel')}</button>
            <button
              onClick={handleSetPassword} disabled={newPwd.length < 8}
              className="px-4 py-2 text-sm font-medium text-white bg-purple-600 rounded-lg hover:bg-purple-700 disabled:opacity-50"
            >{t('changePassword')}</button>
          </div>
        </div>
      )}

      {/* Users Table */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">{t('username')}</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">{tc('name')}</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">{t('email')}</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">{tc('status')}</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">{t('role')}</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">{tc('actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {users.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400 text-sm">{t('noUsers')}</td></tr>
              ) : users.map(user => (
                <tr key={user.pk} className={user.hidden ? 'bg-gray-50/50' : ''}>
                  <td className="px-4 py-3 text-sm font-medium text-gray-900">
                    {user.username}
                    {user.hidden && <span className="ml-2 text-xs text-gray-400">(hidden)</span>}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">{user.name}</td>
                  <td className="px-4 py-3 text-sm text-gray-600">{user.email || '-'}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                      user.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                    }`}>
                      {user.isActive ? tc('active') : tc('inactive')}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {user.isAdmin && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-700">
                        <ShieldCheck className="h-3 w-3" />
                        {t('admin')}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {actionLoading === user.pk ? (
                        <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
                      ) : (
                        <>
                          <button
                            onClick={() => toggleAdmin(user)}
                            title={user.isAdmin ? 'Remove admin' : 'Make admin'}
                            className="p-1.5 text-gray-400 hover:text-purple-600 rounded-lg hover:bg-purple-50"
                          >
                            <ShieldCheck className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => toggleActive(user)}
                            title={user.isActive ? 'Deactivate' : 'Activate'}
                            className="p-1.5 text-gray-400 hover:text-amber-600 rounded-lg hover:bg-amber-50"
                          >
                            <UserX className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => setPasswordDialog({ pk: user.pk, username: user.username })}
                            title="Set password"
                            className="p-1.5 text-gray-400 hover:text-blue-600 rounded-lg hover:bg-blue-50"
                          >
                            <KeyRound className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => handleDelete(user)}
                            title="Delete user"
                            className="p-1.5 text-gray-400 hover:text-red-600 rounded-lg hover:bg-red-50"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import {
  Database,
  Activity,
  Terminal,
  Users,
  Loader2,
  AlertCircle,
  ArrowLeft,
  Play,
  RefreshCw,
  HardDrive,
  Clock,
  Plus,
  Trash2,
  KeyRound,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useTranslations } from 'next-intl';

interface PgStats {
  version: string;
  uptime: string;
  activeConnections: number;
  maxConnections: number;
  databaseCount: number;
  totalSize: string;
  databases: Array<{ name: string; size: string; connections: number }>;
}

interface PgDatabase {
  name: string;
  owner: string;
  encoding: string;
  size: string;
  tablespace: string;
}

interface PgUser {
  name: string;
  superuser: boolean;
  createdb: boolean;
  createrole: boolean;
  login: boolean;
}

interface QueryResult {
  columns: Array<{ name: string }>;
  rows: string[][];
  rowCount: number;
  truncated: boolean;
  duration: number;
}

type TabType = 'overview' | 'databases' | 'console' | 'users';

export default function PostgresPage() {
  const t = useTranslations('postgres');
  const tc = useTranslations('common');
  const [tab, setTab] = useState<TabType>('overview');
  const [stats, setStats] = useState<PgStats | null>(null);
  const [databases, setDatabases] = useState<PgDatabase[]>([]);
  const [users, setUsers] = useState<PgUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [csrfToken, setCsrfToken] = useState<string | null>(null);

  // SQL Console state
  const [sql, setSql] = useState('SELECT version();');
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [queryLoading, setQueryLoading] = useState(false);

  // User creation state
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [newUserName, setNewUserName] = useState('');
  const [newUserPassword, setNewUserPassword] = useState('');
  const [newUserSuperuser, setNewUserSuperuser] = useState(false);
  const [userActionLoading, setUserActionLoading] = useState(false);

  const fetchCsrf = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/csrf');
      if (res.ok) {
        const data = await res.json();
        setCsrfToken(data.csrfToken);
      }
    } catch {
      // ignore
    }
  }, []);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch('/api/apps/postgres/stats');
      if (!res.ok) throw new Error('Failed to fetch stats');
      setStats(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load stats');
    }
  }, []);

  const fetchDatabases = useCallback(async () => {
    try {
      const res = await fetch('/api/apps/postgres/databases');
      if (!res.ok) throw new Error('Failed to fetch databases');
      const data = await res.json();
      setDatabases(data.databases);
    } catch (err) {
      console.error('Failed to fetch databases:', err);
    }
  }, []);

  const fetchUsers = useCallback(async () => {
    try {
      const res = await fetch('/api/apps/postgres/users');
      if (!res.ok) throw new Error('Failed to fetch users');
      const data = await res.json();
      setUsers(data.users);
    } catch (err) {
      console.error('Failed to fetch users:', err);
    }
  }, []);

  useEffect(() => {
    const init = async () => {
      setLoading(true);
      await fetchCsrf();
      await fetchStats();
      setLoading(false);
    };
    init();
  }, [fetchCsrf, fetchStats]);

  useEffect(() => {
    if (tab === 'databases') fetchDatabases();
    if (tab === 'users') fetchUsers();
  }, [tab, fetchDatabases, fetchUsers]);

  const executeQuery = async () => {
    if (!csrfToken || !sql.trim()) return;
    setQueryLoading(true);
    setQueryError(null);
    setQueryResult(null);
    try {
      const res = await fetch('/api/apps/postgres/query', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ sql: sql.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setQueryError(data.error || 'Query failed');
      } else {
        setQueryResult(data);
      }
    } catch (err) {
      setQueryError(err instanceof Error ? err.message : 'Query failed');
    } finally {
      setQueryLoading(false);
    }
  };

  const createUser = async () => {
    if (!csrfToken || !newUserName || !newUserPassword) return;
    setUserActionLoading(true);
    try {
      const res = await fetch('/api/apps/postgres/users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({
          name: newUserName,
          password: newUserPassword,
          superuser: newUserSuperuser,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create user');
      }
      setShowCreateUser(false);
      setNewUserName('');
      setNewUserPassword('');
      setNewUserSuperuser(false);
      await fetchUsers();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to create user');
    } finally {
      setUserActionLoading(false);
    }
  };

  const deleteUser = async (name: string) => {
    if (!csrfToken || !confirm(`Delete user "${name}"?`)) return;
    setUserActionLoading(true);
    try {
      const res = await fetch('/api/apps/postgres/users', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to delete user');
      }
      await fetchUsers();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete user');
    } finally {
      setUserActionLoading(false);
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
              Make sure PostgreSQL is deployed. Run <code className="bg-gray-100 px-1 rounded">spine deploy</code> to install all services.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const tabs: { id: TabType; label: string; icon: typeof Database }[] = [
    { id: 'overview', label: t('overview'), icon: Activity },
    { id: 'databases', label: t('databases'), icon: HardDrive },
    { id: 'console', label: t('sqlConsole'), icon: Terminal },
    { id: 'users', label: t('users'), icon: Users },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/apps" className="text-gray-400 hover:text-gray-600">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div className="p-2 bg-blue-100 rounded-lg">
            <Database className="h-6 w-6 text-blue-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
            <p className="text-sm text-gray-500">{t('subtitle')}</p>
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={() => { fetchStats(); if (tab === 'databases') fetchDatabases(); if (tab === 'users') fetchUsers(); }}>
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
                  ? 'border-blue-500 text-blue-600'
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
          {/* Stats Grid */}
          <div className="grid gap-4 md:grid-cols-4">
            <Card>
              <CardContent className="pt-4 pb-3">
                <div className="flex items-center gap-2 text-sm text-gray-500">
                  <Activity className="h-4 w-4" />
                  Connections
                </div>
                <p className="text-2xl font-bold mt-1">
                  {stats.activeConnections}
                  <span className="text-sm font-normal text-gray-400">/{stats.maxConnections}</span>
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-3">
                <div className="flex items-center gap-2 text-sm text-gray-500">
                  <HardDrive className="h-4 w-4" />
                  Total Size
                </div>
                <p className="text-2xl font-bold mt-1">{stats.totalSize}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-3">
                <div className="flex items-center gap-2 text-sm text-gray-500">
                  <Database className="h-4 w-4" />
                  Databases
                </div>
                <p className="text-2xl font-bold mt-1">{stats.databaseCount}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-3">
                <div className="flex items-center gap-2 text-sm text-gray-500">
                  <Clock className="h-4 w-4" />
                  Uptime
                </div>
                <p className="text-lg font-bold mt-1 truncate">{stats.uptime}</p>
              </CardContent>
            </Card>
          </div>

          {/* Version */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Server Info</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-gray-600 font-mono break-all">{stats.version}</p>
            </CardContent>
          </Card>

          {/* Database list */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Databases</CardTitle>
              <CardDescription>Size and active connections per database</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="divide-y">
                {stats.databases.map((db) => (
                  <div key={db.name} className="flex items-center justify-between py-2">
                    <div className="flex items-center gap-2">
                      <Database className="h-4 w-4 text-gray-400" />
                      <span className="font-mono text-sm">{db.name}</span>
                    </div>
                    <div className="flex items-center gap-4 text-sm text-gray-500">
                      <span>{db.size}</span>
                      <span>{db.connections} conn</span>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Databases Tab */}
      {tab === 'databases' && (
        <Card>
          <CardHeader>
            <CardTitle>Databases</CardTitle>
            <CardDescription>All non-template databases on this server</CardDescription>
          </CardHeader>
          <CardContent>
            {databases.length === 0 ? (
              <p className="text-gray-500 text-sm">Loading databases...</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-gray-500">
                      <th className="pb-2 font-medium">Name</th>
                      <th className="pb-2 font-medium">Owner</th>
                      <th className="pb-2 font-medium">Encoding</th>
                      <th className="pb-2 font-medium">Size</th>
                      <th className="pb-2 font-medium">Tablespace</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {databases.map((db) => (
                      <tr key={db.name}>
                        <td className="py-2 font-mono">{db.name}</td>
                        <td className="py-2">{db.owner}</td>
                        <td className="py-2">{db.encoding}</td>
                        <td className="py-2">{db.size}</td>
                        <td className="py-2">{db.tablespace}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* SQL Console Tab */}
      {tab === 'console' && (
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Terminal className="h-5 w-5" />
                SQL Console
              </CardTitle>
              <CardDescription>Execute read-only queries against the database</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <textarea
                value={sql}
                onChange={(e) => setSql(e.target.value)}
                className="w-full h-32 font-mono text-sm p-3 border rounded-lg bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
                placeholder="SELECT * FROM pg_stat_activity;"
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault();
                    executeQuery();
                  }
                }}
              />
              <div className="flex items-center gap-2">
                <Button
                  onClick={executeQuery}
                  disabled={queryLoading || !sql.trim()}
                  size="sm"
                >
                  {queryLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-1" />
                  ) : (
                    <Play className="h-4 w-4 mr-1" />
                  )}
                  Execute
                </Button>
                <span className="text-xs text-gray-400">Ctrl+Enter to run</span>
                {queryResult && (
                  <span className="text-xs text-gray-500 ml-auto">
                    {queryResult.rowCount} rows in {queryResult.duration}ms
                    {queryResult.truncated && ' (truncated)'}
                  </span>
                )}
              </div>
            </CardContent>
          </Card>

          {queryError && (
            <Card className="border-red-200 bg-red-50">
              <CardContent className="pt-4">
                <div className="flex items-start gap-2 text-red-600">
                  <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                  <pre className="text-sm whitespace-pre-wrap break-all">{queryError}</pre>
                </div>
              </CardContent>
            </Card>
          )}

          {queryResult && queryResult.rows.length > 0 && (
            <Card>
              <CardContent className="p-0">
                <div className="overflow-x-auto max-h-96">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-gray-50">
                      <tr className="border-b">
                        {queryResult.columns.map((col, i) => (
                          <th key={i} className="px-3 py-2 text-left font-medium text-gray-600 whitespace-nowrap">
                            {col.name}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {queryResult.rows.map((row, i) => (
                        <tr key={i} className="hover:bg-gray-50">
                          {row.map((cell, j) => (
                            <td key={j} className="px-3 py-1.5 font-mono text-xs whitespace-nowrap max-w-xs truncate">
                              {cell === '' ? (
                                <span className="text-gray-300 italic">NULL</span>
                              ) : (
                                cell
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}

          {queryResult && queryResult.rows.length === 0 && !queryError && (
            <Card>
              <CardContent className="pt-4">
                <p className="text-sm text-gray-500">Query executed successfully. No rows returned.</p>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Users Tab */}
      {tab === 'users' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Database Users</h2>
            <Button size="sm" onClick={() => setShowCreateUser(!showCreateUser)}>
              <Plus className="h-4 w-4 mr-1" />
              Create User
            </Button>
          </div>

          {showCreateUser && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Create User</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <label className="text-sm text-gray-500">Username</label>
                    <Input
                      value={newUserName}
                      onChange={(e) => setNewUserName(e.target.value)}
                      placeholder="myuser"
                    />
                  </div>
                  <div>
                    <label className="text-sm text-gray-500">Password</label>
                    <Input
                      type="password"
                      value={newUserPassword}
                      onChange={(e) => setNewUserPassword(e.target.value)}
                      placeholder="min 8 characters"
                    />
                  </div>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={newUserSuperuser}
                    onChange={(e) => setNewUserSuperuser(e.target.checked)}
                  />
                  Superuser privileges
                </label>
                <div className="flex gap-2">
                  <Button size="sm" onClick={createUser} disabled={userActionLoading || !newUserName || !newUserPassword}>
                    {userActionLoading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Plus className="h-4 w-4 mr-1" />}
                    Create
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setShowCreateUser(false)}>
                    Cancel
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent className="p-0">
              {users.length === 0 ? (
                <p className="text-gray-500 text-sm p-4">Loading users...</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-gray-500 bg-gray-50">
                        <th className="px-4 py-2 font-medium">Name</th>
                        <th className="px-4 py-2 font-medium">Superuser</th>
                        <th className="px-4 py-2 font-medium">Create DB</th>
                        <th className="px-4 py-2 font-medium">Login</th>
                        <th className="px-4 py-2 font-medium text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {users.map((user) => (
                        <tr key={user.name} className="hover:bg-gray-50">
                          <td className="px-4 py-2 font-mono flex items-center gap-2">
                            <KeyRound className="h-4 w-4 text-gray-400" />
                            {user.name}
                          </td>
                          <td className="px-4 py-2">
                            <span className={user.superuser ? 'text-orange-600 font-medium' : 'text-gray-400'}>
                              {user.superuser ? 'Yes' : 'No'}
                            </span>
                          </td>
                          <td className="px-4 py-2 text-gray-600">{user.createdb ? 'Yes' : 'No'}</td>
                          <td className="px-4 py-2 text-gray-600">{user.login ? 'Yes' : 'No'}</td>
                          <td className="px-4 py-2 text-right">
                            {user.name !== 'postgres' && user.name !== 'youeye' && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => deleteUser(user.name)}
                                disabled={userActionLoading}
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

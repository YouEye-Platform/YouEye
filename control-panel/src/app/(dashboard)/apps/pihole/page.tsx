'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import {
  Globe2,
  Shield,
  ShieldOff,
  Activity,
  List,
  Plus,
  Trash2,
  Loader2,
  AlertCircle,
  CheckCircle2,
  RefreshCw,
  ArrowLeft,
  Clock,
  Ban,
  Check,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useTranslations } from 'next-intl';

interface PiholeStats {
  domainsBlocked: number;
  queriesToday: number;
  adsBlockedToday: number;
  adsPercentage: number;
  uniqueDomains: number;
  queriesForwarded: number;
  queriesCached: number;
  clientsSeenEver: number;
  uniqueClients: number;
  status: string;
}

interface QueryData {
  timestamp: number;
  type: string;
  domain: string;
  client: string;
  status: number;
  reply: string;
  replyTime?: number;
}

type TabType = 'overview' | 'queries' | 'lists';

export default function PiholePage() {
  const t = useTranslations('pihole');
  const tc = useTranslations('common');
  const [activeTab, setActiveTab] = useState<TabType>('overview');
  const [stats, setStats] = useState<PiholeStats | null>(null);
  const [queries, setQueries] = useState<QueryData[]>([]);
  const [whitelist, setWhitelist] = useState<string[]>([]);
  const [blacklist, setBlacklist] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  // Form states
  const [newDomain, setNewDomain] = useState('');
  const [newDomainType, setNewDomainType] = useState<'white' | 'black'>('black');
  const [queryFilter, setQueryFilter] = useState('');

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      // Get CSRF token
      const tokenRes = await fetch('/api/auth/csrf');
      if (tokenRes.ok) {
        const tokenData = await tokenRes.json();
        setCsrfToken(tokenData.csrfToken);
      }

      // Fetch all data in parallel
      const [statsRes, domainsRes, queriesRes] = await Promise.all([
        fetch('/api/apps/pihole/stats'),
        fetch('/api/apps/pihole/domains'),
        fetch('/api/apps/pihole/queries?limit=100'),
      ]);

      if (statsRes.ok) {
        const statsData = await statsRes.json();
        setStats(statsData);
      }

      if (domainsRes.ok) {
        const domainsData = await domainsRes.json();
        setWhitelist(domainsData.whitelist || []);
        setBlacklist(domainsData.blacklist || []);
      }

      if (queriesRes.ok) {
        const queriesData = await queriesRes.json();
        setQueries(queriesData.queries || []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const authenticatedFetch = async (url: string, options: RequestInit = {}) => {
    if (!csrfToken) {
      throw new Error('No CSRF token');
    }

    const res = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
        ...options.headers,
      },
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Request failed');
    }

    return res.json();
  };

  const handleToggleBlocking = async (enable: boolean) => {
    setActionLoading(true);
    setError(null);
    setSuccess(null);

    try {
      await authenticatedFetch('/api/apps/pihole/control', {
        method: 'POST',
        body: JSON.stringify({ action: enable ? 'enable' : 'disable' }),
      });

      setSuccess(`Pi-Hole blocking ${enable ? 'enabled' : 'disabled'}`);
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to toggle blocking');
    } finally {
      setActionLoading(false);
    }
  };

  const handleAddDomain = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDomain.trim()) return;

    setActionLoading(true);
    setError(null);
    setSuccess(null);

    try {
      await authenticatedFetch('/api/apps/pihole/domains', {
        method: 'POST',
        body: JSON.stringify({ domain: newDomain.trim(), type: newDomainType }),
      });

      setSuccess(`Domain added to ${newDomainType}list`);
      setNewDomain('');
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add domain');
    } finally {
      setActionLoading(false);
    }
  };

  const handleRemoveDomain = async (domain: string, type: 'white' | 'black') => {
    setActionLoading(true);
    setError(null);
    setSuccess(null);

    try {
      await authenticatedFetch('/api/apps/pihole/domains', {
        method: 'DELETE',
        body: JSON.stringify({ domain, type }),
      });

      setSuccess(`Domain removed from ${type}list`);
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove domain');
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

  const tabs: { id: TabType; label: string; icon: typeof Activity }[] = [
    { id: 'overview', label: t('overview'), icon: Activity },
    { id: 'queries', label: t('queryLog'), icon: List },
    { id: 'lists', label: t('blockLists'), icon: Ban },
  ];

  const isBlocked = (status: number) => status !== 2 && status !== 3 && status !== 10;

  const filteredQueries = queryFilter
    ? queries.filter(q => 
        q.domain.toLowerCase().includes(queryFilter.toLowerCase()) ||
        q.client.toLowerCase().includes(queryFilter.toLowerCase())
      )
    : queries;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/apps">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="h-4 w-4 mr-1" />
              Back
            </Button>
          </Link>
          <div className="flex items-center gap-3">
            <div className="p-2 bg-red-100 rounded-lg">
              <Globe2 className="h-6 w-6 text-red-600" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
              <p className="text-gray-500 text-sm">{t('subtitle')}</p>
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          {stats && (
            stats.status === 'enabled' ? (
              <Button 
                variant="outline" 
                onClick={() => handleToggleBlocking(false)}
                disabled={actionLoading}
                className="text-red-600 hover:text-red-700"
              >
                {actionLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <ShieldOff className="h-4 w-4 mr-2" />
                )}
                Disable
              </Button>
            ) : (
              <Button 
                variant="default" 
                onClick={() => handleToggleBlocking(true)}
                disabled={actionLoading}
              >
                {actionLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <Shield className="h-4 w-4 mr-2" />
                )}
                Enable
              </Button>
            )
          )}
          <Button variant="outline" onClick={fetchData} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Status Messages */}
      {error && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-red-600">
              <AlertCircle className="h-5 w-5" />
              <span>{error}</span>
            </div>
          </CardContent>
        </Card>
      )}

      {success && (
        <Card className="border-green-200 bg-green-50">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-green-600">
              <CheckCircle2 className="h-5 w-5" />
              <span>{success}</span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <nav className="flex gap-4">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-4 py-2 border-b-2 font-medium text-sm transition-colors ${
                  activeTab === tab.id
                    ? 'border-red-500 text-red-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Tab Content */}
      {activeTab === 'overview' && stats && (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Card className={stats.status === 'enabled' ? 'border-green-200' : 'border-red-200'}>
            <CardHeader className="pb-2">
              <CardDescription>Status</CardDescription>
              <CardTitle className={`text-lg flex items-center gap-2 ${
                stats.status === 'enabled' ? 'text-green-600' : 'text-red-600'
              }`}>
                {stats.status === 'enabled' ? (
                  <><Shield className="h-5 w-5" /> Active</>
                ) : (
                  <><ShieldOff className="h-5 w-5" /> Disabled</>
                )}
              </CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Queries Today</CardDescription>
              <CardTitle className="text-2xl">{stats.queriesToday.toLocaleString()}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Ads Blocked Today</CardDescription>
              <CardTitle className="text-2xl text-red-600">
                {stats.adsBlockedToday.toLocaleString()}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-xs text-gray-500">
                {stats.adsPercentage.toFixed(1)}% of traffic
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Domains on Blocklist</CardDescription>
              <CardTitle className="text-2xl">{stats.domainsBlocked.toLocaleString()}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Unique Domains</CardDescription>
              <CardTitle className="text-lg">{stats.uniqueDomains.toLocaleString()}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Queries Forwarded</CardDescription>
              <CardTitle className="text-lg">{stats.queriesForwarded.toLocaleString()}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Queries Cached</CardDescription>
              <CardTitle className="text-lg">{stats.queriesCached.toLocaleString()}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Unique Clients</CardDescription>
              <CardTitle className="text-lg">{stats.uniqueClients}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-xs text-gray-500">
                {stats.clientsSeenEver} total seen
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {activeTab === 'queries' && (
        <div className="space-y-4">
          {/* Filter */}
          <Card>
            <CardContent className="pt-6">
              <Input
                placeholder="Filter by domain or client..."
                value={queryFilter}
                onChange={(e) => setQueryFilter(e.target.value)}
                className="max-w-md"
              />
            </CardContent>
          </Card>

          {/* Query Log */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Recent Queries ({filteredQueries.length})</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto max-h-96">
                <table className="w-full">
                  <thead className="bg-gray-50 border-b sticky top-0">
                    <tr>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Time</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Domain</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Client</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {filteredQueries.map((query, idx) => (
                      <tr key={idx} className="hover:bg-gray-50">
                        <td className="px-4 py-2 text-sm text-gray-500">
                          <div className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {new Date(query.timestamp * 1000).toLocaleTimeString()}
                          </div>
                        </td>
                        <td className="px-4 py-2 text-sm text-gray-500 font-mono">{query.type}</td>
                        <td className="px-4 py-2 text-sm text-gray-900 font-mono max-w-xs truncate">
                          {query.domain}
                        </td>
                        <td className="px-4 py-2 text-sm text-gray-500 font-mono">{query.client}</td>
                        <td className="px-4 py-2">
                          <span className={`inline-flex items-center gap-1 text-sm ${
                            isBlocked(query.status) ? 'text-red-600' : 'text-green-600'
                          }`}>
                            {isBlocked(query.status) ? (
                              <Ban className="h-3 w-3" />
                            ) : (
                              <Check className="h-3 w-3" />
                            )}
                            {query.reply}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {activeTab === 'lists' && (
        <div className="space-y-4">
          {/* Add Domain Form */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Add Domain</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleAddDomain} className="flex gap-4 items-end">
                <div className="flex-1 max-w-md">
                  <Input
                    placeholder="Domain (e.g., ads.example.com)"
                    value={newDomain}
                    onChange={(e) => setNewDomain(e.target.value)}
                  />
                </div>
                <div className="flex gap-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="listType"
                      checked={newDomainType === 'black'}
                      onChange={() => setNewDomainType('black')}
                      className="text-red-600"
                    />
                    Blacklist
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="listType"
                      checked={newDomainType === 'white'}
                      onChange={() => setNewDomainType('white')}
                      className="text-green-600"
                    />
                    Whitelist
                  </label>
                </div>
                <Button type="submit" disabled={actionLoading || !newDomain.trim()}>
                  {actionLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  ) : (
                    <Plus className="h-4 w-4 mr-2" />
                  )}
                  Add
                </Button>
              </form>
            </CardContent>
          </Card>

          {/* Lists */}
          <div className="grid gap-4 md:grid-cols-2">
            {/* Blacklist */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg text-red-600 flex items-center gap-2">
                  <Ban className="h-5 w-5" />
                  Blacklist ({blacklist.length})
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="max-h-64 overflow-y-auto space-y-1">
                  {blacklist.length === 0 ? (
                    <p className="text-gray-500 text-sm">No custom blacklist entries</p>
                  ) : (
                    blacklist.map((domain, idx) => (
                      <div key={idx} className="flex items-center justify-between py-1 px-2 hover:bg-gray-50 rounded">
                        <span className="text-sm font-mono truncate">{domain}</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRemoveDomain(domain, 'black')}
                          disabled={actionLoading}
                          className="text-red-600 hover:text-red-700"
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    ))
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Whitelist */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg text-green-600 flex items-center gap-2">
                  <Check className="h-5 w-5" />
                  Whitelist ({whitelist.length})
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="max-h-64 overflow-y-auto space-y-1">
                  {whitelist.length === 0 ? (
                    <p className="text-gray-500 text-sm">No custom whitelist entries</p>
                  ) : (
                    whitelist.map((domain, idx) => (
                      <div key={idx} className="flex items-center justify-between py-1 px-2 hover:bg-gray-50 rounded">
                        <span className="text-sm font-mono truncate">{domain}</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRemoveDomain(domain, 'white')}
                          disabled={actionLoading}
                          className="text-red-600 hover:text-red-700"
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    ))
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

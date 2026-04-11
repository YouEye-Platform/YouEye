'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Globe2,
  Shield,
  ShieldOff,
  Activity,
  List,
  Trash2,
  Loader2,
  AlertCircle,
  CheckCircle2,
  RefreshCw,
  Clock,
  Ban,
  Check,
  Settings,
  Network,
  Key,
  ExternalLink,
  Eye,
  EyeOff,
  Plus,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { authenticatedFetch } from '@/lib/api-client';
import { useTranslations } from 'next-intl';
import type { AppInstance } from '@/types/apps';

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

interface DNSRecord {
  domain: string;
  ip: string;
}

interface CNAMERecord {
  domain: string;
  target: string;
}

interface PasswordStatus {
  hasCustomPassword: boolean;
  canChangePassword: boolean;
}

type TabType = 'overview' | 'queries' | 'lists' | 'localdns' | 'settings';

export default function DNSPage() {
  const t = useTranslations('dns');
  const tc = useTranslations('common');
  const [piholeStatus, setPiholeStatus] = useState<AppInstance | null>(null);
  const [activeTab, setActiveTab] = useState<TabType>('overview');
  const [stats, setStats] = useState<PiholeStats | null>(null);
  const [queries, setQueries] = useState<QueryData[]>([]);
  const [whitelist, setWhitelist] = useState<string[]>([]);
  const [blacklist, setBlacklist] = useState<string[]>([]);
  const [dnsRecords, setDnsRecords] = useState<DNSRecord[]>([]);
  const [cnameRecords, setCnameRecords] = useState<CNAMERecord[]>([]);
  const [passwordStatus, setPasswordStatus] = useState<PasswordStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  // Form states
  const [newDomain, setNewDomain] = useState('');
  const [newDomainType, setNewDomainType] = useState<'white' | 'black'>('black');
  const [queryFilter, setQueryFilter] = useState('');
  
  // DNS record form states
  const [newDnsRecord, setNewDnsRecord] = useState({ domain: '', ip: '' });
  const [newCnameRecord, setNewCnameRecord] = useState({ domain: '', target: '' });
  
  // Password form states
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      // Fetch Pi-Hole app status
      const statusRes = await fetch('/api/apps/pihole/status');
      if (statusRes.ok) {
        const data = await statusRes.json();
        setPiholeStatus(data);

        // If Pi-Hole is running, fetch all data
        if (data.status === 'running') {
          const [statsRes, domainsRes, queriesRes, dnsRes, cnameRes, passwordRes] = await Promise.all([
            fetch('/api/apps/pihole/stats'),
            fetch('/api/apps/pihole/domains'),
            fetch('/api/apps/pihole/queries?limit=100'),
            fetch('/api/apps/pihole/dns-records'),
            fetch('/api/apps/pihole/cname-records'),
            fetch('/api/apps/pihole/password'),
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

          if (dnsRes.ok) {
            const dnsData = await dnsRes.json();
            setDnsRecords(dnsData.records || []);
          }

          if (cnameRes.ok) {
            const cnameData = await cnameRes.json();
            setCnameRecords(cnameData.records || []);
          }

          if (passwordRes.ok) {
            const passwordData = await passwordRes.json();
            setPasswordStatus(passwordData);
          }
        }
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

  const handlePiholeAction = async (action: 'start' | 'stop' | 'restart' | 'remove') => {
    setError(null);
    setSuccess(null);
    setActionLoading(true);

    try {
      const response = await authenticatedFetch('/api/apps/pihole/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Action failed');
      }

      setSuccess(data.message || `Pi-Hole ${action} successful`);
      
      setTimeout(() => {
        fetchData();
        setSuccess(null);
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setActionLoading(false);
    }
  };

  const handleToggleBlocking = async (enable: boolean) => {
    setActionLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const response = await authenticatedFetch('/api/apps/pihole/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: enable ? 'enable' : 'disable' }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to toggle blocking');
      }

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
      const response = await authenticatedFetch('/api/apps/pihole/domains', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: newDomain.trim(), type: newDomainType }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to add domain');
      }

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
      const response = await authenticatedFetch('/api/apps/pihole/domains', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain, type }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to remove domain');
      }

      setSuccess(`Domain removed from ${type}list`);
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove domain');
    } finally {
      setActionLoading(false);
    }
  };

  const handleAddDnsRecord = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDnsRecord.domain.trim() || !newDnsRecord.ip.trim()) return;

    setActionLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const response = await authenticatedFetch('/api/apps/pihole/dns-records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newDnsRecord),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to add DNS record');
      }

      setSuccess('DNS record added');
      setNewDnsRecord({ domain: '', ip: '' });
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add DNS record');
    } finally {
      setActionLoading(false);
    }
  };

  const handleRemoveDnsRecord = async (record: DNSRecord) => {
    setActionLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const response = await authenticatedFetch('/api/apps/pihole/dns-records', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(record),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to remove DNS record');
      }

      setSuccess('DNS record removed');
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove DNS record');
    } finally {
      setActionLoading(false);
    }
  };

  const handleAddCnameRecord = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCnameRecord.domain.trim() || !newCnameRecord.target.trim()) return;

    setActionLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const response = await authenticatedFetch('/api/apps/pihole/cname-records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newCnameRecord),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to add CNAME record');
      }

      setSuccess('CNAME record added');
      setNewCnameRecord({ domain: '', target: '' });
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add CNAME record');
    } finally {
      setActionLoading(false);
    }
  };

  const handleRemoveCnameRecord = async (record: CNAMERecord) => {
    setActionLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const response = await authenticatedFetch('/api/apps/pihole/cname-records', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(record),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to remove CNAME record');
      }

      setSuccess('CNAME record removed');
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove CNAME record');
    } finally {
      setActionLoading(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!newPassword.trim()) {
      setError('Password is required');
      return;
    }
    
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    
    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }

    setActionLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const response = await authenticatedFetch('/api/apps/pihole/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPassword }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to change password');
      }

      setSuccess('Password updated successfully');
      setNewPassword('');
      setConfirmPassword('');
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change password');
    } finally {
      setActionLoading(false);
    }
  };

  const isInstalled = piholeStatus?.status !== 'not-installed';
  const isRunning = piholeStatus?.status === 'running';
  const isStopped = piholeStatus?.status === 'stopped';

  const tabs: { id: TabType; label: string; icon: typeof Activity }[] = [
    { id: 'overview', label: t('overview'), icon: Activity },
    { id: 'queries', label: t('queryLog'), icon: List },
    { id: 'lists', label: t('blockLists'), icon: Ban },
    { id: 'localdns', label: t('localDns'), icon: Network },
    { id: 'settings', label: t('settings'), icon: Settings },
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
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
          <p className="text-gray-500">
            {t('description')}
          </p>
        </div>
        <Button
          variant="outline"
          onClick={fetchData}
          disabled={loading}
        >
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Loading...
            </>
          ) : (
            <>
              <RefreshCw className="h-4 w-4 mr-2" />
              Refresh
            </>
          )}
        </Button>
      </div>

      {/* Status Messages */}
      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 text-red-700">
          <AlertCircle className="h-4 w-4" />
          {error}
        </div>
      )}
      {success && (
        <div className="p-3 bg-green-50 border border-green-200 rounded-lg flex items-center gap-2 text-green-700">
          <CheckCircle2 className="h-4 w-4" />
          {success}
        </div>
      )}

      {/* Not Deployed State */}
      {!loading && !isInstalled && (
        <Card>
          <CardContent className="py-12">
            <div className="text-center space-y-4">
              <div className="mx-auto w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center">
                <Globe2 className="h-6 w-6 text-gray-400" />
              </div>
              <div>
                <h3 className="text-lg font-semibold">{t('notDeployed')}</h3>
                <p className="text-gray-500 mt-1">
                  Pi-Hole is deployed by Spine. Run <code className="bg-gray-100 px-1 rounded text-sm">spine deploy</code> to install all services.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Installed State */}
      {!loading && isInstalled && (
        <>
          {/* Pi-Hole Status Card */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`p-2 rounded-lg ${isRunning ? 'bg-green-100' : 'bg-gray-100'}`}>
                    <Globe2 className={`h-5 w-5 ${isRunning ? 'text-green-600' : 'text-gray-500'}`} />
                  </div>
                  <div>
                    <CardTitle className="text-lg">Pi-Hole</CardTitle>
                    <CardDescription>
                      {isRunning ? 'Running' : isStopped ? 'Stopped' : piholeStatus?.status}
                      {piholeStatus?.containerStatus?.ipv4 && ` • ${piholeStatus.containerStatus.ipv4}`}
                    </CardDescription>
                  </div>
                </div>
                <div className="flex gap-2">
                  {isRunning && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handlePiholeAction('restart')}
                        disabled={actionLoading}
                      >
                        {actionLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handlePiholeAction('stop')}
                        disabled={actionLoading}
                      >
                        Stop
                      </Button>
                    </>
                  )}
                  {isStopped && (
                    <Button
                      size="sm"
                      onClick={() => handlePiholeAction('start')}
                      disabled={actionLoading}
                    >
                      {actionLoading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                      Start
                    </Button>
                  )}
                </div>
              </div>
            </CardHeader>
          </Card>

          {/* Blocking Toggle and Tabs (only when running) */}
          {isRunning && (
            <>
              {/* Blocking Toggle */}
              <div className="flex items-center justify-between">
                <div className="border-b border-gray-200 flex-1">
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
                {stats && (
                  <div className="ml-4">
                    {stats.status === 'enabled' ? (
                      <Button 
                        variant="outline" 
                        size="sm"
                        onClick={() => handleToggleBlocking(false)}
                        disabled={actionLoading}
                        className="text-red-600 hover:text-red-700"
                      >
                        {actionLoading ? (
                          <Loader2 className="h-4 w-4 animate-spin mr-2" />
                        ) : (
                          <ShieldOff className="h-4 w-4 mr-2" />
                        )}
                        Disable Blocking
                      </Button>
                    ) : (
                      <Button 
                        variant="default" 
                        size="sm"
                        onClick={() => handleToggleBlocking(true)}
                        disabled={actionLoading}
                      >
                        {actionLoading ? (
                          <Loader2 className="h-4 w-4 animate-spin mr-2" />
                        ) : (
                          <Shield className="h-4 w-4 mr-2" />
                        )}
                        Enable Blocking
                      </Button>
                    )}
                  </div>
                )}
              </div>

              {/* Tab Content */}
              {activeTab === 'overview' && stats && (
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                  <Card className={stats.status === 'enabled' ? 'border-green-200' : 'border-red-200'}>
                    <CardHeader className="pb-2">
                      <CardDescription>Blocking Status</CardDescription>
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

              {activeTab === 'localdns' && (
                <div className="space-y-4">
                  {/* A Records */}
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-lg">DNS Records (A/AAAA)</CardTitle>
                      <CardDescription>
                        Custom domain to IP address mappings
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <form onSubmit={handleAddDnsRecord} className="flex gap-4 items-end">
                        <div className="flex-1 max-w-xs">
                          <label className="text-sm font-medium text-gray-700 mb-1 block">Domain</label>
                          <Input
                            placeholder="home.example.com"
                            value={newDnsRecord.domain}
                            onChange={(e) => setNewDnsRecord(r => ({ ...r, domain: e.target.value }))}
                          />
                        </div>
                        <div className="flex-1 max-w-xs">
                          <label className="text-sm font-medium text-gray-700 mb-1 block">IP Address</label>
                          <Input
                            placeholder="192.168.1.100"
                            value={newDnsRecord.ip}
                            onChange={(e) => setNewDnsRecord(r => ({ ...r, ip: e.target.value }))}
                          />
                        </div>
                        <Button type="submit" disabled={actionLoading || !newDnsRecord.domain.trim() || !newDnsRecord.ip.trim()}>
                          {actionLoading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Plus className="h-4 w-4 mr-2" />}
                          Add
                        </Button>
                      </form>

                      <div className="border rounded-lg overflow-hidden">
                        {dnsRecords.length === 0 ? (
                          <div className="text-center py-8 text-gray-500">
                            No custom DNS records
                          </div>
                        ) : (
                          <table className="w-full">
                            <thead className="bg-gray-50 border-b">
                              <tr>
                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Domain</th>
                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">IP Address</th>
                                <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-200">
                              {dnsRecords.map((record, idx) => (
                                <tr key={idx} className="hover:bg-gray-50">
                                  <td className="px-4 py-2 text-sm font-mono">{record.domain}</td>
                                  <td className="px-4 py-2 text-sm font-mono text-gray-600">{record.ip}</td>
                                  <td className="px-4 py-2 text-right">
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => handleRemoveDnsRecord(record)}
                                      disabled={actionLoading}
                                      className="text-red-600 hover:text-red-700"
                                    >
                                      <Trash2 className="h-3 w-3" />
                                    </Button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </div>
                    </CardContent>
                  </Card>

                  {/* CNAME Records */}
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-lg">CNAME Records</CardTitle>
                      <CardDescription>
                        Domain aliases pointing to other domains
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <form onSubmit={handleAddCnameRecord} className="flex gap-4 items-end">
                        <div className="flex-1 max-w-xs">
                          <label className="text-sm font-medium text-gray-700 mb-1 block">Alias (Source)</label>
                          <Input
                            placeholder="www.example.com"
                            value={newCnameRecord.domain}
                            onChange={(e) => setNewCnameRecord(r => ({ ...r, domain: e.target.value }))}
                          />
                        </div>
                        <div className="flex-1 max-w-xs">
                          <label className="text-sm font-medium text-gray-700 mb-1 block">Target</label>
                          <Input
                            placeholder="example.com"
                            value={newCnameRecord.target}
                            onChange={(e) => setNewCnameRecord(r => ({ ...r, target: e.target.value }))}
                          />
                        </div>
                        <Button type="submit" disabled={actionLoading || !newCnameRecord.domain.trim() || !newCnameRecord.target.trim()}>
                          {actionLoading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Plus className="h-4 w-4 mr-2" />}
                          Add
                        </Button>
                      </form>

                      <div className="border rounded-lg overflow-hidden">
                        {cnameRecords.length === 0 ? (
                          <div className="text-center py-8 text-gray-500">
                            No CNAME records
                          </div>
                        ) : (
                          <table className="w-full">
                            <thead className="bg-gray-50 border-b">
                              <tr>
                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Alias</th>
                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Target</th>
                                <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-200">
                              {cnameRecords.map((record, idx) => (
                                <tr key={idx} className="hover:bg-gray-50">
                                  <td className="px-4 py-2 text-sm font-mono">{record.domain}</td>
                                  <td className="px-4 py-2 text-sm font-mono text-gray-600">{record.target}</td>
                                  <td className="px-4 py-2 text-right">
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => handleRemoveCnameRecord(record)}
                                      disabled={actionLoading}
                                      className="text-red-600 hover:text-red-700"
                                    >
                                      <Trash2 className="h-3 w-3" />
                                    </Button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                </div>
              )}

              {activeTab === 'settings' && (
                <div className="space-y-4">
                  {/* Password Management */}
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-lg flex items-center gap-2">
                        <Key className="h-5 w-5" />
                        API Password
                      </CardTitle>
                      <CardDescription>
                        Configure the password used to communicate with Pi-Hole&apos;s API
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      {passwordStatus && (
                        <div className={`p-3 rounded-lg flex items-center gap-2 ${
                          passwordStatus.hasCustomPassword 
                            ? 'bg-green-50 text-green-700 border border-green-200' 
                            : 'bg-yellow-50 text-yellow-700 border border-yellow-200'
                        }`}>
                          {passwordStatus.hasCustomPassword ? (
                            <>
                              <CheckCircle2 className="h-4 w-4" />
                              Custom password configured
                            </>
                          ) : (
                            <>
                              <AlertCircle className="h-4 w-4" />
                              Using default password - consider setting a custom one
                            </>
                          )}
                        </div>
                      )}

                      <form onSubmit={handleChangePassword} className="space-y-4 max-w-md">
                        <div>
                          <label className="text-sm font-medium text-gray-700 mb-1 block">New Password</label>
                          <div className="relative">
                            <Input
                              type={showPassword ? 'text' : 'password'}
                              placeholder="Enter new password"
                              value={newPassword}
                              onChange={(e) => setNewPassword(e.target.value)}
                              className="pr-10"
                            />
                            <button
                              type="button"
                              onClick={() => setShowPassword(!showPassword)}
                              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-700"
                            >
                              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                            </button>
                          </div>
                        </div>
                        <div>
                          <label className="text-sm font-medium text-gray-700 mb-1 block">Confirm Password</label>
                          <Input
                            type={showPassword ? 'text' : 'password'}
                            placeholder="Confirm new password"
                            value={confirmPassword}
                            onChange={(e) => setConfirmPassword(e.target.value)}
                          />
                        </div>
                        <Button 
                          type="submit" 
                          disabled={actionLoading || !newPassword.trim() || newPassword !== confirmPassword}
                        >
                          {actionLoading ? (
                            <Loader2 className="h-4 w-4 animate-spin mr-2" />
                          ) : (
                            <Key className="h-4 w-4 mr-2" />
                          )}
                          Update Password
                        </Button>
                      </form>
                    </CardContent>
                  </Card>

                  {/* Direct Access */}
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-lg flex items-center gap-2">
                        <ExternalLink className="h-5 w-5" />
                        Direct Access
                      </CardTitle>
                      <CardDescription>
                        Access Pi-Hole&apos;s built-in admin interface directly
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      {piholeStatus?.containerStatus?.ipv4 ? (
                        <div className="flex items-center gap-4">
                          <a 
                            href={`http://${piholeStatus.containerStatus.ipv4}/admin`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-2 text-blue-600 hover:text-blue-800 hover:underline"
                          >
                            <Globe2 className="h-4 w-4" />
                            Open Pi-Hole Admin Panel
                            <ExternalLink className="h-3 w-3" />
                          </a>
                          <span className="text-sm text-gray-500">
                            ({piholeStatus.containerStatus.ipv4}/admin)
                          </span>
                        </div>
                      ) : (
                        <p className="text-gray-500">Pi-Hole IP not available</p>
                      )}
                    </CardContent>
                  </Card>

                  {/* Container Management */}
                  <Card className="border-red-200">
                    <CardHeader>
                      <CardTitle className="text-lg text-red-600">Danger Zone</CardTitle>
                      <CardDescription>
                        Destructive actions that cannot be undone
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <Button
                        variant="destructive"
                        onClick={() => handlePiholeAction('remove')}
                        disabled={actionLoading}
                      >
                        {actionLoading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Trash2 className="h-4 w-4 mr-2" />}
                        Remove Pi-Hole
                      </Button>
                    </CardContent>
                  </Card>
                </div>
              )}
            </>
          )}

          {/* Not running message */}
          {!isRunning && isStopped && (
            <Card>
              <CardContent className="py-8">
                <div className="text-center text-gray-500">
                  Start Pi-Hole to view DNS statistics and manage blocklists
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

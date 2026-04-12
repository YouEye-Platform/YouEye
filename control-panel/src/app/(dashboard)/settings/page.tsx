'use client';

import { useState, useEffect, useCallback, useMemo, CSSProperties } from 'react';
import { LanguageCard } from '@/components/settings/language-card';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Settings as SettingsIcon,
  Shield,
  Check,
  X,
  Loader2,
  AlertCircle,
  RefreshCw,
  Globe,
  Server,
  Key,
  CircleDot,
  Monitor,
  ExternalLink,
  Power,
  PowerOff,
  Paintbrush,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  XCircle,
  Circle,
  Mail,
  Send,
  Eye,
  EyeOff,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { authenticatedFetch } from '@/lib/api-client';
import { useSiteConfig } from '@/hooks/use-site-config';
import {
  type SiteNameStyle,
  DEFAULT_STYLE,
} from '@/lib/wordart-presets';
import SetupWordArtInline from '@/components/setup/WordArtPickerInline';

interface SSOStatus {
  domain: string | null;
  authentikSubdomain: string | null;
  controlSubdomain: string | null;
  authentikHealthy: boolean;
  ssoConfigured: boolean;
  authentikUrl: string | null;
  controlUrl: string | null;
  prerequisitesMet: boolean;
}

interface UIStatus {
  installed: boolean;
  enabled: boolean;
  containerStatus: string;
  version?: string;
  ip?: string;
  ssoConfigured: boolean;
  serviceActive: boolean;
  domain?: string;
}

type ReconfigStepStatus = 'pending' | 'running' | 'done' | 'error';

interface ReconfigStep {
  id: string;
  label: string;
  status: ReconfigStepStatus;
  message?: string;
}

/** Renders a styled site name using CSS inline styles */
function SiteNamePreview({ name, style }: { name: string; style: SiteNameStyle }) {
  const cssStyle = useMemo((): CSSProperties => {
    const base: CSSProperties = {
      fontFamily: `"${style.fontFamily}", sans-serif`,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      letterSpacing: style.letterSpacing,
      textTransform: style.textTransform as CSSProperties['textTransform'],
      textShadow: style.textShadow === 'none' ? undefined : style.textShadow,
      lineHeight: 1.2,
    };
    if (style.gradient?.enabled) {
      return {
        ...base,
        color: 'transparent',
        backgroundImage: `linear-gradient(${style.gradient.direction}, ${style.gradient.from}, ${style.gradient.to})`,
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
        backgroundClip: 'text',
      };
    }
    return { ...base, color: style.color, backgroundImage: 'none',
      WebkitBackgroundClip: 'initial', WebkitTextFillColor: style.color, backgroundClip: 'initial' };
  }, [style]);

  const gKey = style.gradient?.enabled ? `g-${style.gradient.from}-${style.gradient.to}` : 's';
  return <span key={gKey} style={cssStyle}>{name || 'YouEye'}</span>;
}

function useGoogleFont(fontFamily: string) {
  useEffect(() => {
    const id = `gf-${fontFamily.replace(/\s+/g, '-')}`;
    if (document.getElementById(id)) return;
    const link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fontFamily)}:wght@300;400;500;600;700;800;900&display=swap`;
    document.head.appendChild(link);
  }, [fontFamily]);
}

export default function SettingsPage() {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const config = useSiteConfig();
  const { site_name } = config;
  const [ssoStatus, setSSOStatus] = useState<SSOStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState<'setup' | 'disable' | null>(null);

  // UI state
  const [uiStatus, setUIStatus] = useState<UIStatus | null>(null);
  const [uiLoading, setUILoading] = useState(false);
  const [uiActionLoading, setUIActionLoading] = useState(false);
  const [uiError, setUIError] = useState<string | null>(null);
  const [uiSuccess, setUISuccess] = useState<string | null>(null);
  const [uiDomain, setUIDomain] = useState('');
  const [showUIConfirm, setShowUIConfirm] = useState<'enable' | 'disable' | null>(null);

  // Identity Provider state
  const [idpName, setIdpName] = useState('');
  const [idpSaving, setIdpSaving] = useState(false);
  const [idpSuccess, setIdpSuccess] = useState<string | null>(null);
  const [idpError, setIdpError] = useState<string | null>(null);

  // Reconfigure state
  const [showReconfig, setShowReconfig] = useState(false);
  const [rcSiteName, setRcSiteName] = useState('');
  const [rcDomain, setRcDomain] = useState('');
  const [rcSubdomains, setRcSubdomains] = useState({ control: '', auth: '', dns: '' });
  const [rcNameStyle, setRcNameStyle] = useState<SiteNameStyle>(DEFAULT_STYLE);
  const [rcShowAdvanced, setRcShowAdvanced] = useState(false);
  const [rcRunning, setRcRunning] = useState(false);
  const [rcSteps, setRcSteps] = useState<ReconfigStep[]>([]);
  const [rcComplete, setRcComplete] = useState(false);
  const [rcError, setRcError] = useState<string | null>(null);
  const [rcNewUrl, setRcNewUrl] = useState('');
  const [rcConfirm, setRcConfirm] = useState(false);


  const fetchStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authenticatedFetch('/api/auth/sso/status');
      if (res.ok) {
        const data = await res.json();
        setSSOStatus(data);
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Failed to fetch SSO status');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch SSO status');
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch UI status (only when SSO is configured)
  const fetchUIStatus = useCallback(async () => {
    setUILoading(true);
    setUIError(null);
    try {
      const res = await authenticatedFetch('/api/ui');
      if (res.ok) {
        const data = await res.json();
        setUIStatus(data);
        // Pre-fill domain suggestion if not already set
        if (!uiDomain && !data.domain && ssoStatus?.domain) {
          setUIDomain(ssoStatus.domain);
        } else if (data.domain) {
          setUIDomain(data.domain);
        }
      }
    } catch {
      // UI endpoint may not be available yet
    } finally {
      setUILoading(false);
    }
  }, [uiDomain, ssoStatus?.domain]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Fetch UI status after SSO status loads and SSO is configured
  useEffect(() => {
    if (ssoStatus?.ssoConfigured) {
      fetchUIStatus();
    }
  }, [ssoStatus?.ssoConfigured, fetchUIStatus]);

  // Load current config into reconfigure form when panel is opened
  const loadReconfigForm = useCallback(async () => {
    try {
      const res = await authenticatedFetch('/api/setup/config');
      if (res.ok) {
        const cfg = await res.json();
        setRcSiteName(cfg.site_name || 'YouEye');
        setRcDomain(cfg.domain || '');
        setRcSubdomains({
          control: cfg.subdomains?.control || 'control',
          auth: cfg.subdomains?.auth || 'auth',
          dns: cfg.subdomains?.dns || 'dns',
        });
        // Load existing style if available
        if (cfg.site_name_style) {
          setRcNameStyle(cfg.site_name_style);
        }
      }
    } catch { /* ignore */ }
  }, []);

  // Load Identity Provider name from config
  useEffect(() => {
    async function loadIdpName() {
      try {
        const res = await authenticatedFetch('/api/setup/config');
        if (res.ok) {
          const cfg = await res.json();
          setIdpName(cfg.authentik_name || `${cfg.site_name || 'YouEye'} ID`);
        }
      } catch { /* ignore */ }
    }
    loadIdpName();
  }, []);

  const handleSaveIdpName = useCallback(async () => {
    setIdpSaving(true);
    setIdpError(null);
    setIdpSuccess(null);
    try {
      const res = await authenticatedFetch('/api/settings/identity-provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authentik_name: idpName }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to update');
      }
      setIdpSuccess(t('identityProvider.saved'));
      setTimeout(() => setIdpSuccess(null), 3000);
    } catch (e) {
      setIdpError(e instanceof Error ? e.message : 'Failed to update');
    } finally {
      setIdpSaving(false);
    }
  }, [idpName, t]);

  // Load preset fonts on mount
  useEffect(() => {
    // Font preloading is now handled by the WordArtPickerInline component
  }, []);

  const handleReconfigure = useCallback(async () => {
    setRcConfirm(false);
    setRcRunning(true);
    setRcError(null);
    setRcComplete(false);
    setRcSteps([
      { id: 'config', label: 'Reading configuration', status: 'pending' },
      { id: 'apps', label: 'Enumerating installed apps', status: 'pending' },
      { id: 'yaml', label: 'Updating site configuration', status: 'pending' },
      { id: 'caddy', label: 'Updating reverse proxy', status: 'pending' },
      { id: 'dns', label: 'Updating DNS', status: 'pending' },
      { id: 'sso_cp', label: 'Updating CP SSO', status: 'pending' },
      { id: 'sso_ui', label: 'Updating UI SSO', status: 'pending' },
      { id: 'ui_db', label: 'Updating UI branding', status: 'pending' },
      { id: 'cp_env', label: 'Updating CP environment', status: 'pending' },
    ]);

    try {
      const res = await authenticatedFetch('/api/setup/reconfigure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          site_name: rcSiteName,
          domain: rcDomain,
          subdomains: rcSubdomains,
          site_name_style: rcNameStyle,
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Reconfigure failed (${res.status}): ${text || 'Unknown error'}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response stream');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          try {
            const event = JSON.parse(data);
            if (event.complete) {
              setRcComplete(true);
              if (event.newUrl) setRcNewUrl(event.newUrl);
              continue;
            }
            if (event.error) {
              setRcError(event.error);
              continue;
            }
            if (event.step && event.status) {
              setRcSteps(prev => {
                const exists = prev.some(s => s.id === event.step);
                if (exists) {
                  return prev.map(s =>
                    s.id === event.step
                      ? { ...s, status: event.status, message: event.message }
                      : s
                  );
                }
                // Dynamic step (e.g. app_memos) — add it
                return [...prev, { id: event.step, label: event.message || event.step, status: event.status }];
              });
            }
          } catch { /* ignore malformed */ }
        }
      }
    } catch (err) {
      setRcError(err instanceof Error ? err.message : 'Reconfigure failed');
    } finally {
      setRcRunning(false);
    }
  }, [rcSiteName, rcDomain, rcSubdomains, rcNameStyle]);

  const handleEnableUI = async () => {
    setShowUIConfirm(null);
    setUIActionLoading(true);
    setUIError(null);
    setUISuccess(null);

    try {
      const res = await authenticatedFetch('/api/ui', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: uiDomain }),
      });
      const data = await res.json();

      if (!res.ok) {
        const detail = data.details ? `: ${data.details}` : '';
        throw new Error((data.error || 'Failed to enable UI') + detail);
      }

      setUISuccess(data.message || `UI enabled at https://${uiDomain}`);
      await fetchUIStatus();
    } catch (e) {
      setUIError(e instanceof Error ? e.message : 'Failed to enable UI');
    } finally {
      setUIActionLoading(false);
    }
  };

  const handleDisableUI = async () => {
    setShowUIConfirm(null);
    setUIActionLoading(true);
    setUIError(null);
    setUISuccess(null);

    try {
      const res = await authenticatedFetch('/api/ui', { method: 'DELETE' });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to disable UI');
      }

      setUISuccess('UI has been disabled');
      await fetchUIStatus();
    } catch (e) {
      setUIError(e instanceof Error ? e.message : 'Failed to disable UI');
    } finally {
      setUIActionLoading(false);
    }
  };

  const handleSetup = async () => {
    setShowConfirm(null);
    setActionLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const res = await authenticatedFetch('/api/auth/sso/setup', { method: 'POST' });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'SSO setup failed');
      }

      setSuccess('SSO configured successfully! Control Panel is restarting. You will be redirected to login shortly...');

      // Wait for restart, then redirect
      setTimeout(() => {
        window.location.href = '/login';
      }, 8000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'SSO setup failed');
      setActionLoading(false);
    }
  };

  const handleDisable = async () => {
    setShowConfirm(null);
    setActionLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const res = await authenticatedFetch('/api/auth/sso/disable', { method: 'POST' });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to disable SSO');
      }

      setSuccess('SSO disabled. Control Panel is restarting. You will be redirected to login shortly...');

      setTimeout(() => {
        window.location.href = '/login';
      }, 8000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to disable SSO');
      setActionLoading(false);
    }
  };

  const PrereqItem = ({ met, label }: { met: boolean; label: string }) => (
    <div className="flex items-center gap-2 text-sm">
      {met ? (
        <Check className="h-4 w-4 text-green-600 shrink-0" />
      ) : (
        <X className="h-4 w-4 text-gray-400 shrink-0" />
      )}
      <span className={met ? 'text-gray-700' : 'text-gray-400'}>{label}</span>
    </div>
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
          <p className="text-gray-500">{t('subtitle')}</p>
        </div>
        <Button variant="outline" onClick={fetchStatus} disabled={loading}>
          {loading ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4 mr-2" />
          )}
          {tc('refresh')}
        </Button>
      </div>

      {/* Status Messages */}
      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span className="text-sm">{error}</span>
        </div>
      )}
      {success && (
        <div className="p-3 bg-green-50 border border-green-200 rounded-lg flex items-center gap-2 text-green-700">
          <Check className="h-4 w-4 shrink-0" />
          <span className="text-sm">{success}</span>
        </div>
      )}

      {/* Language Settings */}
      <LanguageCard />

      {/* Identity Provider */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Key className="h-5 w-5 text-gray-600" />
            <CardTitle className="text-lg">{t('identityProvider.title')}</CardTitle>
          </div>
          <CardDescription>{t('identityProvider.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="idpName">{t('identityProvider.name')}</Label>
            <div className="flex gap-2">
              <Input
                id="idpName"
                value={idpName}
                onChange={e => setIdpName(e.target.value)}
                placeholder={`${site_name || 'YouEye'} ID`}
              />
              <Button onClick={handleSaveIdpName} disabled={idpSaving}>
                {idpSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : tc('save')}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t('identityProvider.helper')}</p>
          </div>
          {idpSuccess && (
            <div className="text-sm text-green-600 flex items-center gap-1">
              <Check className="h-3.5 w-3.5" /> {idpSuccess}
            </div>
          )}
          {idpError && (
            <div className="text-sm text-red-600 flex items-center gap-1">
              <AlertCircle className="h-3.5 w-3.5" /> {idpError}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Server Configuration / Reconfigure */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Globe className="h-5 w-5 text-gray-600" />
            <CardTitle className="text-lg">{t('reconfigure.title')}</CardTitle>
          </div>
          <CardDescription>
            {t('reconfigure.description')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!showReconfig ? (
            <div className="flex items-center justify-between">
              <div className="text-sm text-gray-600">
                {config.domain && <p>Domain: <strong>{config.domain}</strong></p>}
                <p>Instance: <strong>{config.site_name || 'YouEye'}</strong></p>
              </div>
              <Button
                variant="outline"
                onClick={() => {
                  loadReconfigForm();
                  setShowReconfig(true);
                  setRcComplete(false);
                  setRcError(null);
                  setRcSteps([]);
                }}
              >
                <SettingsIcon className="h-4 w-4 mr-2" />
                {t('reconfigure.button')}
              </Button>
            </div>
          ) : rcRunning || rcComplete ? (
            /* Progress display */
            <div className="space-y-4">
              <div className="space-y-2">
                {rcSteps.map(s => (
                  <div key={s.id} className="flex items-start gap-3">
                    {s.status === 'running' && <Loader2 className="h-4 w-4 animate-spin text-primary mt-0.5" />}
                    {s.status === 'done' && <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5" />}
                    {s.status === 'error' && <XCircle className="h-4 w-4 text-red-600 mt-0.5" />}
                    {s.status === 'pending' && <Circle className="h-4 w-4 text-muted-foreground mt-0.5" />}
                    <div className="flex-1">
                      <p className={`text-sm ${s.status === 'running' ? 'font-medium' : ''}`}>{s.label}</p>
                      {s.message && (
                        <p className={`text-xs ${s.status === 'error' ? 'text-red-600' : 'text-muted-foreground'}`}>{s.message}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              {rcError && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{rcError}</div>
              )}
              {rcComplete && (
                <div className="space-y-3 pt-3 border-t">
                  <div className="text-center">
                    <CheckCircle2 className="h-10 w-10 text-green-600 mx-auto mb-2" />
                    <p className="font-semibold">Reconfiguration Complete!</p>
                    <p className="text-sm text-muted-foreground">
                      Control Panel will restart to apply new settings.
                    </p>
                  </div>
                  <div className="flex gap-2 justify-center">
                    {rcNewUrl && (
                      <Button asChild>
                        <a href={rcNewUrl}>Go to new Control Panel</a>
                      </Button>
                    )}
                    <Button variant="outline" onClick={() => { setShowReconfig(false); setRcComplete(false); }}>
                      Close
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            /* Reconfigure form */
            <div className="space-y-5">
              {/* Instance Name */}
              <div className="space-y-2">
                <Label htmlFor="rc-siteName">Instance Name</Label>
                <Input
                  id="rc-siteName"
                  value={rcSiteName}
                  onChange={e => setRcSiteName(e.target.value)}
                  placeholder="YouEye"
                />
              </div>

              {/* WordArt Style Picker */}
              <div className="space-y-3">
                <Label>Logo Style</Label>
                <SetupWordArtInline
                  siteName={rcSiteName}
                  style={rcNameStyle}
                  setStyle={setRcNameStyle}
                />
              </div>

              {/* Domain */}
              <div className="space-y-2">
                <Label htmlFor="rc-domain">Domain Name</Label>
                <Input
                  id="rc-domain"
                  value={rcDomain}
                  onChange={e => setRcDomain(e.target.value)}
                  placeholder="example.com"
                />
              </div>

              {/* Advanced: Subdomains */}
              <div>
                <button
                  type="button"
                  onClick={() => setRcShowAdvanced(!rcShowAdvanced)}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  Advanced options
                  {rcShowAdvanced ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                </button>
                {rcShowAdvanced && (
                  <div className="mt-2 space-y-2 rounded-lg border p-3 bg-muted/30">
                    <Label className="text-xs">Service Subdomains</Label>
                    <div className="grid grid-cols-1 gap-2">
                      {Object.entries(rcSubdomains).map(([key, value]) => (
                        <div key={key} className="flex items-center gap-2">
                          <Label className="text-xs text-muted-foreground capitalize w-16">
                            {key === 'auth' ? 'Auth' : key === 'dns' ? 'DNS' : 'Panel'}
                          </Label>
                          <div className="flex items-center gap-1 flex-1">
                            <Input
                              value={value}
                              onChange={e => setRcSubdomains(prev => ({ ...prev, [key]: e.target.value }))}
                              placeholder={key}
                              className="text-sm h-8"
                            />
                            {rcDomain && (
                              <span className="text-xs text-muted-foreground whitespace-nowrap">.{rcDomain}</span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Confirmation */}
              {rcConfirm ? (
                <div className="p-4 rounded-lg border-2 border-amber-200 bg-amber-50 space-y-3">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
                    <div>
                      <p className="font-medium text-amber-900">Confirm Reconfiguration</p>
                      <p className="text-sm text-amber-700 mt-1">
                        This will update all services, SSO configurations, and installed apps.
                        The Control Panel will <strong>restart</strong> after completion.
                        No data will be lost.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 ml-7">
                    <Button size="sm" onClick={handleReconfigure} className="bg-blue-600 hover:bg-blue-700 text-white">
                      Yes, Reconfigure
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setRcConfirm(false)}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <div className="flex gap-2">
                  <Button onClick={() => setRcConfirm(true)} disabled={!rcDomain}>
                    Apply Changes
                  </Button>
                  <Button variant="outline" onClick={() => setShowReconfig(false)}>Cancel</Button>
                </div>
              )}

              {rcError && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{rcError}</div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Authentication Section */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-gray-600" />
            <CardTitle className="text-lg">{t('sso.title')}</CardTitle>
          </div>
          <CardDescription>
            {t('sso.description')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
            </div>
          ) : ssoStatus ? (
            <>
              {/* Current Status */}
              <div className="flex items-center gap-3 p-4 rounded-lg bg-gray-50 border">
                <CircleDot className={`h-5 w-5 ${ssoStatus.ssoConfigured ? 'text-green-500' : 'text-gray-400'}`} />
                <div>
                  <p className="font-medium text-gray-900">
                    {t('sso.status')}: {ssoStatus.ssoConfigured ? t('sso.configured') : t('sso.notConfigured')}
                  </p>
                  {ssoStatus.ssoConfigured && ssoStatus.authentikUrl && (
                    <p className="text-sm text-gray-500 mt-0.5">
                      Authentik: {ssoStatus.authentikUrl}
                    </p>
                  )}
                  {ssoStatus.ssoConfigured && ssoStatus.controlUrl && (
                    <p className="text-sm text-gray-500">
                      SSO Login: {ssoStatus.controlUrl}
                    </p>
                  )}
                </div>
              </div>

              {/* How it works */}
              <div className="text-sm text-gray-600 space-y-1 border-l-2 border-blue-200 pl-3">
                <p><strong>How SSO works:</strong></p>
                <p>When accessed via <strong>IP address</strong> (e.g., 192.168.31.190), login uses <strong>Linux PAM</strong> credentials.</p>
                <p>When accessed via <strong>subdomain</strong> (e.g., control.yourdomain.com), login uses <strong>Authentik SSO</strong> — no PAM option.</p>
              </div>

              {/* Prerequisites */}
              {!ssoStatus.ssoConfigured && (
                <div className="space-y-3">
                  <h3 className="text-sm font-medium text-gray-700">Prerequisites</h3>
                  <div className="space-y-2 p-3 rounded-lg border bg-white">
                    <PrereqItem
                      met={!!ssoStatus.domain}
                      label={ssoStatus.domain ? `Domain configured (${ssoStatus.domain})` : 'Domain name configured in Reverse Proxy'}
                    />
                    <PrereqItem
                      met={!!ssoStatus.controlSubdomain}
                      label={ssoStatus.controlSubdomain ? `Control Panel subdomain (${ssoStatus.controlSubdomain})` : 'Control Panel subdomain configured'}
                    />
                    <PrereqItem
                      met={!!ssoStatus.authentikSubdomain}
                      label={ssoStatus.authentikSubdomain ? `Authentik subdomain (${ssoStatus.authentikSubdomain})` : 'Authentik subdomain configured'}
                    />
                    <PrereqItem
                      met={ssoStatus.authentikHealthy}
                      label={ssoStatus.authentikHealthy ? 'Authentik service healthy' : 'Authentik service running'}
                    />
                  </div>
                  {!ssoStatus.prerequisitesMet && (
                    <p className="text-xs text-gray-500">
                      Configure subdomains in the <strong>Reverse Proxy</strong> tab. Ensure Authentik is deployed and running.
                    </p>
                  )}
                </div>
              )}

              {/* Actions */}
              <div className="flex items-center gap-3 pt-2">
                {!ssoStatus.ssoConfigured ? (
                  <Button
                    onClick={() => setShowConfirm('setup')}
                    disabled={!ssoStatus.prerequisitesMet || actionLoading}
                    className="bg-blue-600 hover:bg-blue-700 text-white"
                  >
                    {actionLoading ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Key className="h-4 w-4 mr-2" />
                    )}
                    Setup Control Panel SSO
                  </Button>
                ) : (
                  <Button
                    onClick={() => setShowConfirm('disable')}
                    disabled={actionLoading}
                    variant="outline"
                    className="text-red-600 border-red-200 hover:bg-red-50"
                  >
                    {actionLoading ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <X className="h-4 w-4 mr-2" />
                    )}
                    Disable SSO
                  </Button>
                )}
              </div>

              {/* Confirmation Modal */}
              {showConfirm && (
                <div className="p-4 rounded-lg border-2 border-amber-200 bg-amber-50 space-y-3">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
                    <div>
                      <p className="font-medium text-amber-900">
                        {showConfirm === 'setup' ? 'Confirm SSO Setup' : 'Confirm SSO Disable'}
                      </p>
                      <p className="text-sm text-amber-700 mt-1">
                        Control Panel will <strong>restart</strong>. You will be logged out and need to sign in again.
                        {showConfirm === 'setup' && (
                          <> After restart, subdomain access will use Authentik SSO login.</>
                        )}
                        {showConfirm === 'disable' && (
                          <> After restart, all access will use PAM login.</>
                        )}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 ml-7">
                    <Button
                      size="sm"
                      onClick={showConfirm === 'setup' ? handleSetup : handleDisable}
                      className={showConfirm === 'setup' ? 'bg-blue-600 hover:bg-blue-700 text-white' : 'bg-red-600 hover:bg-red-700 text-white'}
                    >
                      {showConfirm === 'setup' ? 'Yes, Setup SSO' : 'Yes, Disable SSO'}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setShowConfirm(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <p className="text-gray-500">Unable to load SSO status.</p>
          )}
        </CardContent>
      </Card>

      {/* Auth Mode Info */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <SettingsIcon className="h-5 w-5 text-gray-600" />
            <CardTitle className="text-lg">Authentication Modes</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="p-4 rounded-lg border bg-white space-y-2">
              <div className="flex items-center gap-2">
                <Server className="h-4 w-4 text-gray-600" />
                <h4 className="font-medium text-gray-900">PAM Login</h4>
              </div>
              <p className="text-sm text-gray-500">
                Access via IP address (e.g., 192.168.31.190). Uses Linux system credentials.
                Always available for local access.
              </p>
            </div>
            <div className="p-4 rounded-lg border bg-white space-y-2">
              <div className="flex items-center gap-2">
                <Globe className="h-4 w-4 text-blue-600" />
                <h4 className="font-medium text-gray-900">Authentik SSO</h4>
              </div>
              <p className="text-sm text-gray-500">
                Access via subdomain (e.g., control.yourdomain.com). Uses Authentik identity provider.
                {ssoStatus?.ssoConfigured ? ' Currently enabled.' : ' Requires setup.'}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* YouEye UI Section — only visible when SSO is configured and UI is installed */}
      {ssoStatus?.ssoConfigured && uiStatus?.installed && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Monitor className="h-5 w-5 text-gray-600" />
              <CardTitle className="text-lg">{site_name} UI</CardTitle>
            </div>
            <CardDescription>
              Enable the {site_name} user interface with SSO authentication on a custom subdomain
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {uiLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
              </div>
            ) : (
              <>
                {/* Status Messages */}
                {uiError && (
                  <div className="p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 text-red-700">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span className="text-sm">{uiError}</span>
                  </div>
                )}
                {uiSuccess && (
                  <div className="p-3 bg-green-50 border border-green-200 rounded-lg flex items-center gap-2 text-green-700">
                    <Check className="h-4 w-4 shrink-0" />
                    <span className="text-sm">{uiSuccess}</span>
                  </div>
                )}

                {/* Current Status */}
                <div className="flex items-center gap-3 p-4 rounded-lg bg-gray-50 border">
                  <CircleDot className={`h-5 w-5 ${uiStatus.serviceActive ? 'text-green-500' : uiStatus.enabled ? 'text-amber-500' : 'text-gray-400'}`} />
                  <div className="flex-1">
                    <p className="font-medium text-gray-900">
                      UI Status: {uiStatus.serviceActive ? 'Running' : uiStatus.enabled ? 'Enabled (starting...)' : 'Installed — Not Enabled'}
                    </p>
                    {uiStatus.version && (
                      <p className="text-sm text-gray-500 mt-0.5">Version: {uiStatus.version}</p>
                    )}
                    {uiStatus.domain && uiStatus.serviceActive && (
                      <a
                        href={uiStatus.domain.startsWith('http') ? uiStatus.domain : `https://${uiStatus.domain}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-sm text-blue-600 hover:text-blue-700 mt-0.5"
                      >
                        {uiStatus.domain.startsWith('http') ? uiStatus.domain : `https://${uiStatus.domain}`}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={fetchUIStatus}
                    disabled={uiLoading}
                  >
                    <RefreshCw className={`h-4 w-4 ${uiLoading ? 'animate-spin' : ''}`} />
                  </Button>
                </div>

                {/* Enable UI — domain input + button */}
                {!uiStatus.enabled && (
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <label htmlFor="ui-domain" className="text-sm font-medium text-gray-700">
                        UI Subdomain
                      </label>
                      <Input
                        id="ui-domain"
                        type="text"
                        placeholder={ssoStatus?.domain ? ssoStatus.domain : 'yourdomain.com'}
                        value={uiDomain}
                        onChange={(e) => setUIDomain(e.target.value)}
                        disabled={uiActionLoading}
                        className="max-w-md"
                      />
                      <p className="text-xs text-gray-500">
                        The subdomain where {site_name} UI will be accessible. Make sure DNS points to this server.
                      </p>
                    </div>

                    <Button
                      onClick={() => setShowUIConfirm('enable')}
                      disabled={!uiDomain.trim() || uiActionLoading}
                      className="bg-blue-600 hover:bg-blue-700 text-white"
                    >
                      {uiActionLoading ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <Power className="h-4 w-4 mr-2" />
                      )}
                      Enable {site_name} UI
                    </Button>
                  </div>
                )}

                {/* Disable UI — shown when enabled */}
                {uiStatus.enabled && (
                  <Button
                    onClick={() => setShowUIConfirm('disable')}
                    disabled={uiActionLoading}
                    variant="outline"
                    className="text-red-600 border-red-200 hover:bg-red-50"
                  >
                    {uiActionLoading ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <PowerOff className="h-4 w-4 mr-2" />
                    )}
                    Disable UI
                  </Button>
                )}

                {/* Confirmation Modal */}
                {showUIConfirm && (
                  <div className="p-4 rounded-lg border-2 border-amber-200 bg-amber-50 space-y-3">
                    <div className="flex items-start gap-2">
                      <AlertCircle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
                      <div>
                        <p className="font-medium text-amber-900">
                          {showUIConfirm === 'enable' ? 'Confirm Enable UI' : 'Confirm Disable UI'}
                        </p>
                        <p className="text-sm text-amber-700 mt-1">
                          {showUIConfirm === 'enable' ? (
                            <>
                              This will create an OAuth2 application in Authentik, configure Caddy routing for <strong>{uiDomain}</strong>, and start the UI service. Ensure DNS is configured before proceeding.
                            </>
                          ) : (
                            <>
                              This will stop the UI service, remove the Authentik OAuth2 application, and remove the Caddy route. Users will no longer be able to access the UI.
                            </>
                          )}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 ml-7">
                      <Button
                        size="sm"
                        onClick={showUIConfirm === 'enable' ? handleEnableUI : handleDisableUI}
                        className={showUIConfirm === 'enable' ? 'bg-blue-600 hover:bg-blue-700 text-white' : 'bg-red-600 hover:bg-red-700 text-white'}
                      >
                        {showUIConfirm === 'enable' ? 'Yes, Enable UI' : 'Yes, Disable UI'}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setShowUIConfirm(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}

                {/* How it works */}
                <div className="text-sm text-gray-600 space-y-1 border-l-2 border-blue-200 pl-3">
                  <p><strong>How UI deployment works:</strong></p>
                  <p>Enabling creates an OAuth2 application in Authentik, configures reverse proxy routing, sets up the database, and starts the service.</p>
                  <p>Users authenticate via Authentik SSO. Admin users in the <strong>youeye-admins</strong> group get admin access.</p>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* SMTP Email */}
      <SmtpCard />

      {/* Release Channel */}
      <ReleaseChannelCard />
    </div>
  );
}

function ReleaseChannelCard() {
  const t = useTranslations('settings.releaseChannel');
  const tc = useTranslations('common');
  const [branch, setBranch] = useState('');
  const [inputValue, setInputValue] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const fetchBranch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authenticatedFetch('/api/setup/config');
      if (res.ok) {
        const cfg = await res.json();
        const b = cfg.release_branch || '';
        setBranch(b);
        setInputValue(b);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchBranch(); }, [fetchBranch]);

  const handleSave = async () => {
    const newBranch = inputValue.trim().toLowerCase();
    // Validate: alphanumeric, hyphens, underscores only
    if (newBranch && !/^[a-z0-9_-]+$/.test(newBranch)) {
      setError('Branch name can only contain lowercase letters, numbers, hyphens, and underscores');
      return;
    }

    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await authenticatedFetch('/api/setup/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ release_branch: newBranch }),
      });
      if (res.ok) {
        setBranch(newBranch);
        setSuccess(newBranch ? `Release channel set to "${newBranch}"` : 'Reset to main (default) channel');
        setTimeout(() => setSuccess(null), 5000);
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Failed to save');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setInputValue('');
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await authenticatedFetch('/api/setup/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ release_branch: '' }),
      });
      if (res.ok) {
        setBranch('');
        setSuccess('Reset to main (default) channel');
        setTimeout(() => setSuccess(null), 5000);
      }
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  };

  const hasChanges = inputValue.trim().toLowerCase() !== branch;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CircleDot className="h-5 w-5 text-gray-600" />
          <CardTitle className="text-lg">{t('title')}</CardTitle>
        </div>
        <CardDescription>
          {t('description')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center gap-2 text-gray-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">Loading...</span>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 text-sm text-gray-600">
              <span>{t('current')}:</span>
              <span className="font-mono font-medium px-2 py-0.5 bg-gray-100 rounded text-gray-800">
                {branch || 'main'}
              </span>
              {branch && branch !== 'main' && (
                <span className="text-xs text-amber-600 bg-amber-50 px-2 py-0.5 rounded">
                  Non-default
                </span>
              )}
            </div>

            <div className="flex items-center gap-2 max-w-md">
              <Input
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                placeholder="main"
                disabled={saving}
                className="font-mono"
              />
              <Button onClick={handleSave} disabled={!hasChanges || saving} size="sm">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : tc('save')}
              </Button>
              {branch && (
                <Button onClick={handleReset} variant="outline" size="sm" disabled={saving}>
                  {tc('reset')}
                </Button>
              )}
            </div>

            {error && (
              <div className="text-sm text-red-600 flex items-center gap-1">
                <AlertCircle className="h-3 w-3" />
                {error}
              </div>
            )}
            {success && (
              <div className="text-sm text-green-600 flex items-center gap-1">
                <Check className="h-3 w-3" />
                {success}
              </div>
            )}

            <div className="text-xs text-gray-500 space-y-1 border-l-2 border-gray-200 pl-3">
              <p>When set, updates look for releases tagged with the branch prefix (e.g., <code>alpha-v0.1.50</code>).</p>
              <p>If no branch-specific release exists for a component, it falls back to the main release.</p>
              <p>Leave empty or set to &quot;main&quot; to use default releases.</p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function SmtpCard() {
  const tc = useTranslations('common');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [host, setHost] = useState('');
  const [port, setPort] = useState('587');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [from, setFrom] = useState('');
  const [requireTls, setRequireTls] = useState(true);
  const [configured, setConfigured] = useState(false);
  const [hasPassword, setHasPassword] = useState(false);
  const [lastTestDate, setLastTestDate] = useState<string | null>(null);

  useEffect(() => {
    authenticatedFetch('/api/settings/smtp')
      .then(r => r.json())
      .then(data => {
        setHost(data.host || '');
        setPort(String(data.port || 587));
        setUsername(data.username || '');
        setFrom(data.from || '');
        setRequireTls(data.requireTls ?? true);
        setConfigured(data.configured || false);
        setHasPassword(data.hasPassword || false);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const body: Record<string, unknown> = { host, port: Number(port), username, from, requireTls };
      if (password) body.password = password;
      else if (!hasPassword) {
        setError('SMTP password is required');
        setSaving(false);
        return;
      }
      const res = await authenticatedFetch('/api/settings/smtp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to save');
      }
      setConfigured(true);
      setHasPassword(true);
      setPassword('');
      setSuccess('SMTP settings saved. Authentik email backend updated.');
      setTimeout(() => setSuccess(''), 5000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setError('');
    setSuccess('');
    try {
      const res = await authenticatedFetch('/api/settings/smtp/test', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Test failed');
      setLastTestDate(new Date().toLocaleDateString());
      setSuccess('Test email sent successfully!');
      setTimeout(() => setSuccess(''), 5000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Test failed');
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Mail className="h-5 w-5 text-gray-600" />
            <CardTitle className="text-lg">Email (SMTP)</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {tc('loading')}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Mail className="h-5 w-5 text-gray-600" />
          <CardTitle className="text-lg">Email (SMTP)</CardTitle>
          {configured ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-green-100 text-green-700 text-xs font-medium rounded-full">
              <CheckCircle2 className="h-3 w-3" />
              Configured
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-100 text-gray-500 text-xs font-medium rounded-full">
              Not configured
            </span>
          )}
          {lastTestDate && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-50 text-blue-600 text-xs font-medium rounded-full">
              <CheckCircle2 className="h-3 w-3" />
              Last test: {lastTestDate}
            </span>
          )}
        </div>
        <CardDescription>
          Configure outgoing email for password resets, notifications, and app emails.
          {Number(port) === 587 ? ' Gmail requires an app password, not your account password.' : ''}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="smtp-host">SMTP Host</Label>
            <Input id="smtp-host" value={host} onChange={e => setHost(e.target.value)} placeholder="smtp.gmail.com" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="smtp-port">Port</Label>
            <Input id="smtp-port" type="number" value={port} onChange={e => setPort(e.target.value)} placeholder="587" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="smtp-username">Username</Label>
            <Input id="smtp-username" value={username} onChange={e => setUsername(e.target.value)} placeholder="user@gmail.com" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="smtp-password">Password {hasPassword && !password ? '(saved)' : ''}</Label>
            <div className="relative">
              <Input
                id="smtp-password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder={hasPassword ? '••••••••' : 'Enter password'}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="smtp-from">From Address</Label>
          <Input id="smtp-from" value={from} onChange={e => setFrom(e.target.value)} placeholder="youeye@yourdomain.com" />
        </div>

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="smtp-tls"
            checked={requireTls}
            onChange={e => setRequireTls(e.target.checked)}
            className="rounded"
          />
          <Label htmlFor="smtp-tls" className="text-sm font-normal cursor-pointer">
            Require TLS (STARTTLS on port 587, implicit TLS on port 465)
          </Label>
        </div>

        <div className="flex items-center gap-2 pt-1">
          <Button onClick={handleSave} disabled={saving || !host || !username || !from}>
            {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Check className="h-4 w-4 mr-2" />}
            {tc('save')}
          </Button>
          {configured && (
            <Button variant="outline" onClick={handleTest} disabled={testing}>
              {testing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Send className="h-4 w-4 mr-2" />}
              Send Test Email
            </Button>
          )}
        </div>

        {error && (
          <div className="text-sm text-red-600 flex items-center gap-1">
            <AlertCircle className="h-3 w-3" />
            {error}
          </div>
        )}
        {success && (
          <div className="text-sm text-green-600 flex items-center gap-1">
            <Check className="h-3 w-3" />
            {success}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

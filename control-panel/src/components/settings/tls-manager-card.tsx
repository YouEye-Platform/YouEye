'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Shield,
  ShieldCheck,
  ShieldAlert,
  Loader2,
  AlertCircle,
  Check,
  Copy,
  Download,
  Upload,
  RefreshCw,
  Lock,
  Globe,
  FileKey,
  ChevronDown,
} from 'lucide-react';
import { authenticatedFetch } from '@/lib/api-client';

interface TLSStatus {
  mode: 'internal' | 'acme' | 'manual';
  hasExternalCert: boolean;
  cert: {
    issuer: string;
    domains: string[];
    expiresAt: string;
    issuedAt: string;
  } | null;
  subjects: string[];
  expiryWarning: boolean;
}

interface DnsChallenge {
  domain: string;
  txtName: string;
  txtValue: string;
}

type View = 'status' | 'acme' | 'upload';
type AcmeStep = 'domain' | 'records' | 'verifying' | 'done';

export function TLSManagerCard() {
  const [status, setStatus] = useState<TLSStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>('status');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // ACME flow state
  const [acmeStep, setAcmeStep] = useState<AcmeStep>('domain');
  const [acmeDomain, setAcmeDomain] = useState('');
  const [acmeWildcard, setAcmeWildcard] = useState(true);
  const [acmeOrderId, setAcmeOrderId] = useState('');
  const [acmeChallenges, setAcmeChallenges] = useState<DnsChallenge[]>([]);
  const [acmeLoading, setAcmeLoading] = useState(false);

  // Upload state
  const [uploadCert, setUploadCert] = useState('');
  const [uploadKey, setUploadKey] = useState('');
  const [uploadChain, setUploadChain] = useState('');
  const [uploadLoading, setUploadLoading] = useState(false);

  // Revert state
  const [showRevert, setShowRevert] = useState(false);
  const [reverting, setReverting] = useState(false);

  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authenticatedFetch('/api/tls/status');
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
        if (data.cert?.domains?.[0]) {
          setAcmeDomain(data.cert.domains[0].replace(/^\*\./, ''));
        }
      }
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  // Pre-fill domain from status subjects
  useEffect(() => {
    if (!acmeDomain && status?.subjects?.length) {
      const base = status.subjects.find(s => !s.startsWith('*'));
      if (base) setAcmeDomain(base);
    }
  }, [status, acmeDomain]);

  const handleStartAcme = async () => {
    if (!acmeDomain.trim()) { setError('Domain is required'); return; }
    setAcmeLoading(true);
    setError('');
    try {
      const res = await authenticatedFetch('/api/tls/acme', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: acmeDomain.trim(), includeWildcard: acmeWildcard }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start order');
      setAcmeOrderId(data.orderId);
      setAcmeChallenges(data.challenges);
      setAcmeStep('records');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start ACME order');
    } finally {
      setAcmeLoading(false);
    }
  };

  const handleVerifyAcme = async () => {
    setAcmeLoading(true);
    setError('');
    setAcmeStep('verifying');
    try {
      const res = await authenticatedFetch('/api/tls/acme', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: acmeOrderId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Verification failed');
      setAcmeStep('done');
      setSuccess(data.message || 'Certificate issued successfully!');
      fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ACME verification failed');
      setAcmeStep('records'); // Go back to records so user can retry
    } finally {
      setAcmeLoading(false);
    }
  };

  const handleUpload = async () => {
    if (!uploadCert.trim() || !uploadKey.trim()) {
      setError('Certificate and private key are required');
      return;
    }
    setUploadLoading(true);
    setError('');
    try {
      const res = await authenticatedFetch('/api/tls/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          certificate: uploadCert.trim(),
          privateKey: uploadKey.trim(),
          chain: uploadChain.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      setSuccess(data.message || 'Certificate uploaded!');
      setView('status');
      setUploadCert('');
      setUploadKey('');
      setUploadChain('');
      fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploadLoading(false);
    }
  };

  const handleRevert = async () => {
    setReverting(true);
    setError('');
    try {
      const res = await authenticatedFetch('/api/tls/status', { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Revert failed');
      setSuccess(data.message || 'Reverted to self-signed');
      setShowRevert(false);
      fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Revert failed');
    } finally {
      setReverting(false);
    }
  };

  const handleDownload = (type: string) => {
    window.open(`/api/tls/download?type=${type}`, '_blank');
  };

  const copyToClipboard = (text: string, index: number) => {
    navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  const handleFileUpload = (
    event: React.ChangeEvent<HTMLInputElement>,
    setter: (value: string) => void,
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      setter(e.target?.result as string || '');
    };
    reader.readAsText(file);
  };

  const modeBadge = () => {
    if (!status) return null;
    switch (status.mode) {
      case 'acme':
        return <Badge className="bg-green-100 text-green-700 hover:bg-green-100">Let&apos;s Encrypt</Badge>;
      case 'manual':
        return <Badge className="bg-blue-100 text-blue-700 hover:bg-blue-100">Custom</Badge>;
      default:
        return <Badge variant="secondary">Self-Signed</Badge>;
    }
  };

  const modeIcon = () => {
    if (!status) return <Shield className="h-5 w-5 text-gray-400" />;
    if (status.expiryWarning) return <ShieldAlert className="h-5 w-5 text-amber-500" />;
    if (status.mode !== 'internal') return <ShieldCheck className="h-5 w-5 text-green-600" />;
    return <Shield className="h-5 w-5 text-gray-500" />;
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className={`p-2 rounded-lg ${status?.mode !== 'internal' ? 'bg-green-100' : 'bg-gray-100'}`}>
              {modeIcon()}
            </div>
            <div>
              <CardTitle className="text-lg">TLS Certificates</CardTitle>
              <CardDescription>
                Manage HTTPS certificates for your server
              </CardDescription>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {modeBadge()}
            <Button variant="ghost" size="sm" onClick={fetchStatus} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Error / Success messages */}
        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2 text-red-700 text-sm">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
        {success && (
          <div className="p-3 bg-green-50 border border-green-200 rounded-lg flex items-center gap-2 text-green-700 text-sm">
            <Check className="h-4 w-4 shrink-0" />
            <span>{success}</span>
          </div>
        )}

        {/* Expiry warning */}
        {status?.expiryWarning && status.cert?.expiresAt && (
          <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg flex items-start gap-2 text-amber-700 text-sm">
            <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">Certificate expires soon</p>
              <p>Expires: {new Date(status.cert.expiresAt).toLocaleDateString()}. Renew to avoid browser warnings.</p>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
          </div>
        ) : view === 'status' ? (
          /* ─── Status View ─── */
          <>
            {/* Current cert info */}
            {status?.hasExternalCert && status.cert ? (
              <div className="p-4 rounded-lg bg-gray-50 border space-y-2">
                <div className="flex items-center gap-2 text-sm">
                  <Lock className="h-4 w-4 text-green-600" />
                  <span className="font-medium">Active Certificate</span>
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm text-gray-600 pl-6">
                  <span>Issuer:</span>
                  <span className="font-medium text-gray-900">{status.cert.issuer}</span>
                  <span>Domains:</span>
                  <div className="flex flex-wrap gap-1">
                    {status.cert.domains.map(d => (
                      <Badge key={d} variant="outline" className="font-mono text-xs">{d}</Badge>
                    ))}
                  </div>
                  {status.cert.expiresAt && (
                    <>
                      <span>Expires:</span>
                      <span className="font-medium text-gray-900">
                        {new Date(status.cert.expiresAt).toLocaleDateString()}
                      </span>
                    </>
                  )}
                  {status.cert.issuedAt && (
                    <>
                      <span>Issued:</span>
                      <span>{new Date(status.cert.issuedAt).toLocaleDateString()}</span>
                    </>
                  )}
                </div>
              </div>
            ) : (
              <div className="p-4 rounded-lg bg-gray-50 border">
                <div className="flex items-center gap-2 text-sm text-gray-600">
                  <Shield className="h-4 w-4" />
                  <span>Using Caddy&apos;s internal CA (self-signed certificates)</span>
                </div>
                <p className="text-xs text-gray-500 mt-1 pl-6">
                  Browsers will show &quot;connection not secure&quot; warnings. Get a real certificate or download
                  the CA cert below to trust it.
                </p>
              </div>
            )}

            {/* Action buttons */}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() => { setView('acme'); setAcmeStep('domain'); setError(''); setSuccess(''); }}
              >
                <Globe className="h-4 w-4 mr-1.5" />
                {status?.mode === 'acme' ? 'Renew Certificate' : "Get Let's Encrypt Cert"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => { setView('upload'); setError(''); setSuccess(''); }}
              >
                <Upload className="h-4 w-4 mr-1.5" />
                Upload Custom Cert
              </Button>
            </div>

            {/* Download section */}
            <div className="border-t pt-4 space-y-2">
              <p className="text-sm font-medium text-gray-700">Downloads</p>
              <div className="flex flex-wrap gap-2">
                {status?.hasExternalCert && (
                  <>
                    <Button variant="outline" size="sm" onClick={() => handleDownload('cert')}>
                      <Download className="h-3.5 w-3.5 mr-1.5" />
                      Certificate
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => handleDownload('key')}>
                      <FileKey className="h-3.5 w-3.5 mr-1.5" />
                      Private Key
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => handleDownload('bundle')}>
                      <Download className="h-3.5 w-3.5 mr-1.5" />
                      Bundle (JSON)
                    </Button>
                  </>
                )}
                <Button variant="outline" size="sm" onClick={() => handleDownload('ca')}>
                  <Shield className="h-3.5 w-3.5 mr-1.5" />
                  CA Cert (Trust)
                </Button>
              </div>
              <p className="text-xs text-gray-500">
                {status?.hasExternalCert
                  ? 'Download your certificate and key as a backup.'
                  : 'Download the CA certificate to trust self-signed certs in your browser/OS.'}
              </p>
            </div>

            {/* Revert to self-signed */}
            {status?.hasExternalCert && (
              <div className="border-t pt-4">
                {showRevert ? (
                  <div className="p-3 rounded-lg border-2 border-amber-200 bg-amber-50 space-y-2">
                    <p className="text-sm text-amber-800 font-medium">Revert to self-signed certificates?</p>
                    <p className="text-xs text-amber-700">
                      This will remove the current certificate and switch back to Caddy&apos;s internal CA.
                      Browsers will show security warnings again.
                    </p>
                    <div className="flex gap-2">
                      <Button size="sm" variant="destructive" onClick={handleRevert} disabled={reverting}>
                        {reverting ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}
                        Yes, Revert
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setShowRevert(false)}>Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => setShowRevert(true)}
                    className="text-xs text-gray-400 hover:text-red-500 transition-colors"
                  >
                    Revert to self-signed certificates
                  </button>
                )}
              </div>
            )}
          </>
        ) : view === 'acme' ? (
          /* ─── ACME Flow ─── */
          <>
            {acmeStep === 'domain' && (
              <div className="space-y-4">
                <div className="p-3 rounded-lg bg-blue-50 border border-blue-100 text-sm text-blue-800">
                  <p className="font-medium">How it works</p>
                  <p className="mt-1 text-blue-700">
                    We&apos;ll request a certificate from Let&apos;s Encrypt. You&apos;ll need to create DNS TXT
                    records at your domain provider to prove ownership. Works with any DNS provider.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="acme-domain">Domain</Label>
                  <Input
                    id="acme-domain"
                    value={acmeDomain}
                    onChange={e => setAcmeDomain(e.target.value)}
                    placeholder="example.com"
                  />
                </div>

                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={acmeWildcard}
                    onChange={e => setAcmeWildcard(e.target.checked)}
                    className="rounded"
                  />
                  Include wildcard (*.{acmeDomain || 'example.com'})
                </label>

                <div className="flex gap-2">
                  <Button onClick={handleStartAcme} disabled={acmeLoading || !acmeDomain.trim()}>
                    {acmeLoading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Globe className="h-4 w-4 mr-2" />}
                    Request Certificate
                  </Button>
                  <Button variant="outline" onClick={() => { setView('status'); setError(''); }}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {acmeStep === 'records' && (
              <div className="space-y-4">
                <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-800">
                  <p className="font-medium">Create these DNS TXT records</p>
                  <p className="mt-1 text-amber-700">
                    Go to your DNS provider and create the TXT records below. Both records use the same name
                    but different values. Wait a few minutes for DNS propagation before verifying.
                  </p>
                </div>

                {acmeChallenges.map((ch, i) => (
                  <div key={i} className="p-4 rounded-lg border bg-white space-y-2">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <Badge variant="outline" className="font-mono text-xs">{ch.domain}</Badge>
                    </div>
                    <div className="grid grid-cols-[80px_1fr] gap-2 text-sm">
                      <span className="text-gray-500">Type:</span>
                      <span className="font-mono font-medium">TXT</span>
                      <span className="text-gray-500">Name:</span>
                      <div className="flex items-center gap-1.5">
                        <code className="text-xs bg-gray-100 px-2 py-1 rounded font-mono break-all flex-1">
                          {ch.txtName}
                        </code>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 shrink-0"
                          onClick={() => copyToClipboard(ch.txtName, i * 2)}
                        >
                          {copiedIndex === i * 2 ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
                        </Button>
                      </div>
                      <span className="text-gray-500">Value:</span>
                      <div className="flex items-center gap-1.5">
                        <code className="text-xs bg-gray-100 px-2 py-1 rounded font-mono break-all flex-1">
                          {ch.txtValue}
                        </code>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 shrink-0"
                          onClick={() => copyToClipboard(ch.txtValue, i * 2 + 1)}
                        >
                          {copiedIndex === i * 2 + 1 ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}

                <div className="flex gap-2">
                  <Button onClick={handleVerifyAcme} disabled={acmeLoading}>
                    {acmeLoading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Check className="h-4 w-4 mr-2" />}
                    Verify &amp; Issue Certificate
                  </Button>
                  <Button variant="outline" onClick={() => { setView('status'); setAcmeStep('domain'); setError(''); }}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {acmeStep === 'verifying' && (
              <div className="flex flex-col items-center justify-center py-8 gap-3">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                <p className="text-sm text-gray-600">Verifying DNS records and issuing certificate...</p>
                <p className="text-xs text-gray-400">This may take up to 60 seconds</p>
              </div>
            )}

            {acmeStep === 'done' && (
              <div className="space-y-4 text-center py-4">
                <ShieldCheck className="h-12 w-12 text-green-500 mx-auto" />
                <div>
                  <p className="font-semibold text-lg">Certificate Issued!</p>
                  <p className="text-sm text-gray-600 mt-1">
                    Your site is now using a trusted Let&apos;s Encrypt certificate.
                    No more browser warnings.
                  </p>
                </div>
                <Button onClick={() => { setView('status'); setAcmeStep('domain'); setSuccess(''); }}>
                  Done
                </Button>
              </div>
            )}
          </>
        ) : view === 'upload' ? (
          /* ─── Upload View ─── */
          <div className="space-y-4">
            <div className="p-3 rounded-lg bg-blue-50 border border-blue-100 text-sm text-blue-700">
              Upload a PEM-encoded certificate and private key. Optionally include the CA chain.
            </div>

            <div className="space-y-2">
              <Label>Certificate (PEM)</Label>
              <div className="flex gap-2">
                <textarea
                  value={uploadCert}
                  onChange={e => setUploadCert(e.target.value)}
                  placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
                  className="flex-1 min-h-[100px] rounded-md border bg-transparent px-3 py-2 text-xs font-mono resize-y"
                />
                <label className="flex items-center justify-center w-10 border rounded-md cursor-pointer hover:bg-gray-50">
                  <Upload className="h-4 w-4 text-gray-400" />
                  <input type="file" className="hidden" accept=".pem,.crt,.cer" onChange={e => handleFileUpload(e, setUploadCert)} />
                </label>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Private Key (PEM)</Label>
              <div className="flex gap-2">
                <textarea
                  value={uploadKey}
                  onChange={e => setUploadKey(e.target.value)}
                  placeholder="-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----"
                  className="flex-1 min-h-[100px] rounded-md border bg-transparent px-3 py-2 text-xs font-mono resize-y"
                />
                <label className="flex items-center justify-center w-10 border rounded-md cursor-pointer hover:bg-gray-50">
                  <Upload className="h-4 w-4 text-gray-400" />
                  <input type="file" className="hidden" accept=".pem,.key" onChange={e => handleFileUpload(e, setUploadKey)} />
                </label>
              </div>
            </div>

            <div className="space-y-2">
              <button
                type="button"
                onClick={() => setUploadChain(uploadChain ? '' : ' ')}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                <ChevronDown className={`h-3.5 w-3.5 transition-transform ${uploadChain ? 'rotate-180' : ''}`} />
                CA Chain (optional)
              </button>
              {uploadChain !== '' && (
                <div className="flex gap-2">
                  <textarea
                    value={uploadChain === ' ' ? '' : uploadChain}
                    onChange={e => setUploadChain(e.target.value)}
                    placeholder="-----BEGIN CERTIFICATE-----&#10;(intermediate CA)&#10;-----END CERTIFICATE-----"
                    className="flex-1 min-h-[80px] rounded-md border bg-transparent px-3 py-2 text-xs font-mono resize-y"
                  />
                  <label className="flex items-center justify-center w-10 border rounded-md cursor-pointer hover:bg-gray-50">
                    <Upload className="h-4 w-4 text-gray-400" />
                    <input type="file" className="hidden" accept=".pem,.crt" onChange={e => handleFileUpload(e, setUploadChain)} />
                  </label>
                </div>
              )}
            </div>

            <div className="flex gap-2">
              <Button onClick={handleUpload} disabled={uploadLoading || !uploadCert.trim() || !uploadKey.trim()}>
                {uploadLoading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Upload className="h-4 w-4 mr-2" />}
                Upload &amp; Apply
              </Button>
              <Button variant="outline" onClick={() => { setView('status'); setError(''); }}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

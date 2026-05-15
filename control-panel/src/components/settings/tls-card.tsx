/**
 * TLS Certificate Management Card — settings page component
 *
 * Admin-only card with 3 views: status, ACME/Let's Encrypt, upload custom.
 * Mirrors the embed TLS client but uses shadcn Card styling and
 * authenticatedFetch() for CSRF-protected requests.
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Shield, Loader2, Check, AlertCircle, Download, Upload, RefreshCw,
  Lock, ChevronDown, Copy, CheckCircle2, XCircle,
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

export function TlsCard() {
  const [status, setStatus] = useState<TLSStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>('status');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // ACME state
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
  const [showChain, setShowChain] = useState(false);

  // Revert state
  const [showRevert, setShowRevert] = useState(false);
  const [reverting, setReverting] = useState(false);

  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      setError('');
      const res = await authenticatedFetch('/api/tls/status');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setStatus(data);
      if (data.cert?.domains?.[0]) {
        setAcmeDomain(data.cert.domains[0].replace(/^\*\./, ''));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  useEffect(() => {
    if (!acmeDomain && status?.subjects?.length) {
      const base = status.subjects.find((s) => !s.startsWith('*'));
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
      setAcmeStep('records');
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

  const copyText = (text: string, idx: number) => {
    navigator.clipboard.writeText(text);
    setCopiedIndex(idx);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  const readFile = (e: React.ChangeEvent<HTMLInputElement>, setter: (v: string) => void) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setter((ev.target?.result as string) || '');
    reader.readAsText(file);
  };

  const modeLabel = status?.mode === 'acme' ? "Let's Encrypt" : status?.mode === 'manual' ? 'Custom' : 'Self-Signed';

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Lock className="h-5 w-5" />
            TLS Certificates
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading certificate status...
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Lock className="h-5 w-5" />
              TLS Certificates
              <span className={`inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-full ${
                status?.mode === 'acme' ? 'bg-green-100 text-green-700' :
                status?.mode === 'manual' ? 'bg-blue-100 text-blue-700' :
                'bg-gray-100 text-gray-500'
              }`}>
                {modeLabel}
              </span>
            </CardTitle>
            <CardDescription>Manage HTTPS certificates for your server</CardDescription>
          </div>
          {view === 'status' && (
            <Button variant="outline" size="sm" onClick={() => fetchStatus()}>
              <RefreshCw className="h-4 w-4" />
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Alerts */}
        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2 text-sm text-red-700">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            {error}
          </div>
        )}
        {success && (
          <div className="p-3 bg-green-50 border border-green-200 rounded-lg flex items-start gap-2 text-sm text-green-700">
            <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
            {success}
          </div>
        )}
        {status?.expiryWarning && status.cert?.expiresAt && (
          <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700">
            <strong>Certificate expires soon</strong>
            <p className="mt-1">Expires: {new Date(status.cert.expiresAt).toLocaleDateString()}. Renew to avoid browser warnings.</p>
          </div>
        )}

        {/* ─── Status View ─── */}
        {view === 'status' && (
          <>
            {/* Current cert info */}
            <div className="p-4 rounded-lg border bg-muted/30">
              {status?.hasExternalCert && status.cert ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 font-medium">
                    <Shield className="h-4 w-4 text-green-600" />
                    Active Certificate
                  </div>
                  <div className="grid grid-cols-[80px_1fr] gap-x-4 gap-y-1 text-sm">
                    <span className="text-muted-foreground">Issuer:</span>
                    <span>{status.cert.issuer}</span>
                    <span className="text-muted-foreground">Domains:</span>
                    <div className="flex flex-wrap gap-1">
                      {status.cert.domains.map((d) => (
                        <span key={d} className="px-1.5 py-0.5 bg-muted rounded text-xs font-mono">{d}</span>
                      ))}
                    </div>
                    {status.cert.expiresAt && (
                      <>
                        <span className="text-muted-foreground">Expires:</span>
                        <span>{new Date(status.cert.expiresAt).toLocaleDateString()}</span>
                      </>
                    )}
                    {status.cert.issuedAt && (
                      <>
                        <span className="text-muted-foreground">Issued:</span>
                        <span>{new Date(status.cert.issuedAt).toLocaleDateString()}</span>
                      </>
                    )}
                  </div>
                </div>
              ) : (
                <div className="space-y-1">
                  <div className="flex items-center gap-2 font-medium">
                    <Lock className="h-4 w-4" />
                    Self-Signed (Internal CA)
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Using Caddy&apos;s internal CA. Browsers will show &quot;connection not secure&quot; warnings.
                  </p>
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() => { setView('acme'); setAcmeStep('domain'); setError(''); setSuccess(''); }}
              >
                {status?.mode === 'acme' ? 'Renew Certificate' : "Get Let's Encrypt Cert"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => { setView('upload'); setError(''); setSuccess(''); }}
              >
                <Upload className="h-3.5 w-3.5 mr-1.5" />
                Upload Custom Cert
              </Button>
            </div>

            {/* Downloads */}
            <div className="border-t pt-4 space-y-2">
              <Label className="text-sm">Downloads</Label>
              <div className="flex flex-wrap gap-2">
                {status?.hasExternalCert && (
                  <>
                    <Button variant="outline" size="sm" onClick={() => handleDownload('zip')}>
                      <Download className="h-3.5 w-3.5 mr-1.5" />
                      Keys (ZIP)
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => handleDownload('cert')}>Certificate</Button>
                    <Button variant="outline" size="sm" onClick={() => handleDownload('key')}>Private Key</Button>
                    <Button variant="outline" size="sm" onClick={() => handleDownload('bundle')}>Bundle (JSON)</Button>
                  </>
                )}
                <Button variant="outline" size="sm" onClick={() => handleDownload('ca')}>CA Cert (Trust)</Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {status?.hasExternalCert
                  ? 'Download your certificate and private key as a ZIP archive, or individually.'
                  : 'Download the CA certificate to trust self-signed certs in your browser/OS.'}
              </p>
            </div>

            {/* Revert */}
            {status?.hasExternalCert && (
              <div className="border-t pt-4">
                {showRevert ? (
                  <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg space-y-3">
                    <div>
                      <p className="font-medium text-amber-900">Revert to self-signed certificates?</p>
                      <p className="text-xs text-amber-700 mt-1">
                        This removes the current certificate and switches back to Caddy&apos;s internal CA.
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" variant="destructive" onClick={handleRevert} disabled={reverting}>
                        {reverting && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                        Yes, Revert
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setShowRevert(false)}>Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <button
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                    onClick={() => setShowRevert(true)}
                  >
                    Revert to self-signed certificates
                  </button>
                )}
              </div>
            )}
          </>
        )}

        {/* ─── ACME Flow ─── */}
        {view === 'acme' && (
          <>
            {acmeStep === 'domain' && (
              <div className="space-y-4">
                <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-700 space-y-1">
                  <p className="font-medium">How it works</p>
                  <p>We&apos;ll request a certificate from Let&apos;s Encrypt. You&apos;ll need to create DNS TXT records at your domain provider to prove ownership.</p>
                </div>

                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="tls-domain">Domain</Label>
                    <Input
                      id="tls-domain"
                      value={acmeDomain}
                      onChange={(e) => setAcmeDomain(e.target.value)}
                      placeholder="example.com"
                    />
                  </div>

                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={acmeWildcard}
                      onChange={(e) => setAcmeWildcard(e.target.checked)}
                      className="rounded"
                    />
                    Include wildcard (*.{acmeDomain || 'example.com'})
                  </label>
                </div>

                <div className="flex gap-2">
                  <Button onClick={handleStartAcme} disabled={acmeLoading || !acmeDomain.trim()}>
                    {acmeLoading && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
                    Request Certificate
                  </Button>
                  <Button variant="outline" onClick={() => { setView('status'); setError(''); }}>Cancel</Button>
                </div>
              </div>
            )}

            {acmeStep === 'records' && (
              <div className="space-y-4">
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700 space-y-1">
                  <p className="font-medium">Create these DNS TXT records</p>
                  <p>Go to your DNS provider and create the TXT records below. Wait a few minutes for DNS propagation before verifying.</p>
                </div>

                {acmeChallenges.map((ch, i) => (
                  <div key={i} className="p-3 rounded-lg border space-y-2">
                    <span className="px-2 py-0.5 bg-muted rounded text-xs font-mono">{ch.domain}</span>
                    <div className="grid grid-cols-[60px_1fr_auto] gap-x-3 gap-y-1 text-sm items-center">
                      <span className="text-muted-foreground">Type:</span>
                      <span className="font-mono">TXT</span>
                      <span />
                      <span className="text-muted-foreground">Name:</span>
                      <code className="text-xs bg-muted px-2 py-1 rounded break-all">{ch.txtName}</code>
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => copyText(ch.txtName, i * 2)}>
                        {copiedIndex === i * 2 ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                      </Button>
                      <span className="text-muted-foreground">Value:</span>
                      <code className="text-xs bg-muted px-2 py-1 rounded break-all">{ch.txtValue}</code>
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => copyText(ch.txtValue, i * 2 + 1)}>
                        {copiedIndex === i * 2 + 1 ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                      </Button>
                    </div>
                  </div>
                ))}

                <div className="flex gap-2">
                  <Button onClick={handleVerifyAcme} disabled={acmeLoading}>
                    {acmeLoading && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
                    Verify & Issue Certificate
                  </Button>
                  <Button variant="outline" onClick={() => { setView('status'); setAcmeStep('domain'); setError(''); }}>Cancel</Button>
                </div>
              </div>
            )}

            {acmeStep === 'verifying' && (
              <div className="text-center py-10 space-y-3">
                <Loader2 className="h-8 w-8 animate-spin mx-auto text-primary" />
                <p className="text-sm">Verifying DNS records and issuing certificate...</p>
                <p className="text-xs text-muted-foreground">This may take up to 60 seconds</p>
              </div>
            )}

            {acmeStep === 'done' && (
              <div className="text-center py-8 space-y-3">
                <CheckCircle2 className="h-12 w-12 text-green-600 mx-auto" />
                <p className="font-semibold">Certificate Issued!</p>
                <p className="text-sm text-muted-foreground">
                  Your site is now using a trusted Let&apos;s Encrypt certificate.
                </p>
                <Button onClick={() => { setView('status'); setAcmeStep('domain'); setSuccess(''); }}>
                  Done
                </Button>
              </div>
            )}
          </>
        )}

        {/* ─── Upload View ─── */}
        {view === 'upload' && (
          <div className="space-y-4">
            <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-700">
              Upload a PEM-encoded certificate and private key. Optionally include the CA chain.
            </div>

            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Certificate (PEM)</Label>
                <div className="flex gap-2">
                  <textarea
                    className="w-full min-h-[100px] p-2 rounded-md border bg-background font-mono text-xs resize-y"
                    value={uploadCert}
                    onChange={(e) => setUploadCert(e.target.value)}
                    placeholder={"-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"}
                  />
                  <label className="flex items-center justify-center w-9 rounded-md border cursor-pointer hover:bg-muted transition-colors flex-shrink-0">
                    <Upload className="h-4 w-4 text-muted-foreground" />
                    <input type="file" className="hidden" accept=".pem,.crt,.cer" onChange={(e) => readFile(e, setUploadCert)} />
                  </label>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>Private Key (PEM)</Label>
                <div className="flex gap-2">
                  <textarea
                    className="w-full min-h-[100px] p-2 rounded-md border bg-background font-mono text-xs resize-y"
                    value={uploadKey}
                    onChange={(e) => setUploadKey(e.target.value)}
                    placeholder={"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"}
                  />
                  <label className="flex items-center justify-center w-9 rounded-md border cursor-pointer hover:bg-muted transition-colors flex-shrink-0">
                    <Upload className="h-4 w-4 text-muted-foreground" />
                    <input type="file" className="hidden" accept=".pem,.key" onChange={(e) => readFile(e, setUploadKey)} />
                  </label>
                </div>
              </div>

              <button
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => setShowChain(!showChain)}
              >
                <ChevronDown className={`h-3 w-3 transition-transform ${showChain ? 'rotate-180' : ''}`} />
                CA Chain (optional)
              </button>

              {showChain && (
                <div className="space-y-1.5">
                  <div className="flex gap-2">
                    <textarea
                      className="w-full min-h-[80px] p-2 rounded-md border bg-background font-mono text-xs resize-y"
                      value={uploadChain}
                      onChange={(e) => setUploadChain(e.target.value)}
                      placeholder={"-----BEGIN CERTIFICATE-----\n(intermediate CA)\n-----END CERTIFICATE-----"}
                    />
                    <label className="flex items-center justify-center w-9 rounded-md border cursor-pointer hover:bg-muted transition-colors flex-shrink-0">
                      <Upload className="h-4 w-4 text-muted-foreground" />
                      <input type="file" className="hidden" accept=".pem,.crt" onChange={(e) => readFile(e, setUploadChain)} />
                    </label>
                  </div>
                </div>
              )}
            </div>

            <div className="flex gap-2">
              <Button onClick={handleUpload} disabled={uploadLoading || !uploadCert.trim() || !uploadKey.trim()}>
                {uploadLoading && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
                Upload & Apply
              </Button>
              <Button variant="outline" onClick={() => { setView('status'); setError(''); }}>Cancel</Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

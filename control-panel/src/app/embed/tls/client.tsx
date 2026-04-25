"use client";

import { useEffect, useState, useCallback } from "react";

interface TLSStatus {
  mode: "internal" | "acme" | "manual";
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

type View = "status" | "acme" | "upload";
type AcmeStep = "domain" | "records" | "verifying" | "done";

const styles = `
  .tls-alert {
    padding: 10px 14px;
    border-radius: 6px;
    font-size: 13px;
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin-bottom: 12px;
  }
  .tls-alert-error { background: color-mix(in srgb, var(--embed-danger) 10%, transparent); border: 1px solid color-mix(in srgb, var(--embed-danger) 30%, transparent); color: var(--embed-danger); }
  .tls-alert-success { background: color-mix(in srgb, var(--embed-success) 10%, transparent); border: 1px solid color-mix(in srgb, var(--embed-success) 30%, transparent); color: var(--embed-success); }
  .tls-alert-warn { background: color-mix(in srgb, var(--embed-warning) 10%, transparent); border: 1px solid color-mix(in srgb, var(--embed-warning) 30%, transparent); color: var(--embed-warning); }
  .tls-alert-info { background: color-mix(in srgb, var(--embed-primary) 10%, transparent); border: 1px solid color-mix(in srgb, var(--embed-primary) 30%, transparent); color: var(--embed-primary); }
  .tls-alert strong { font-weight: 600; }
  .tls-input {
    width: 100%;
    padding: 6px 10px;
    border-radius: 6px;
    border: 1px solid var(--embed-border);
    background: var(--embed-card-bg);
    color: var(--embed-text);
    font-size: 13px;
    outline: none;
  }
  .tls-input:focus { border-color: var(--embed-primary); }
  .tls-textarea {
    width: 100%;
    min-height: 100px;
    padding: 8px 10px;
    border-radius: 6px;
    border: 1px solid var(--embed-border);
    background: var(--embed-card-bg);
    color: var(--embed-text);
    font-family: "SF Mono", "Fira Code", monospace;
    font-size: 12px;
    resize: vertical;
    outline: none;
  }
  .tls-textarea:focus { border-color: var(--embed-primary); }
  .tls-label { display: block; font-size: 12px; font-weight: 500; color: var(--embed-text-muted); margin-bottom: 4px; }
  .tls-btn-primary {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 7px 14px; border-radius: 6px; border: none;
    background: var(--embed-primary); color: #fff;
    font-size: 13px; font-weight: 500; cursor: pointer;
  }
  .tls-btn-primary:hover { opacity: 0.9; }
  .tls-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .tls-btn-danger {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 7px 14px; border-radius: 6px; border: none;
    background: var(--embed-danger); color: #fff;
    font-size: 13px; font-weight: 500; cursor: pointer;
  }
  .tls-btn-danger:disabled { opacity: 0.5; cursor: not-allowed; }
  .tls-grid-info { display: grid; grid-template-columns: 80px 1fr; gap: 4px 16px; font-size: 13px; }
  .tls-code {
    font-family: "SF Mono", "Fira Code", monospace;
    font-size: 11px;
    background: var(--embed-hover);
    padding: 4px 8px;
    border-radius: 4px;
    word-break: break-all;
  }
  .tls-copy-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 28px; height: 28px; border-radius: 4px; border: 1px solid var(--embed-border);
    background: var(--embed-card-bg); color: var(--embed-text-muted); cursor: pointer;
    font-size: 14px; flex-shrink: 0;
  }
  .tls-copy-btn:hover { background: var(--embed-hover); }
  .tls-checkbox { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }
  .tls-divider { border: none; border-top: 1px solid var(--embed-border); margin: 16px 0; }
  .tls-spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid var(--embed-border); border-top-color: var(--embed-primary); border-radius: 50%; animation: embed-spin 0.6s linear infinite; }
  .tls-file-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 36px; border-radius: 6px; border: 1px solid var(--embed-border);
    background: var(--embed-card-bg); cursor: pointer; flex-shrink: 0;
  }
  .tls-file-btn:hover { background: var(--embed-hover); }
`;

export function TlsEmbedClient() {
  const [status, setStatus] = useState<TLSStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [view, setView] = useState<View>("status");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // ACME state
  const [acmeStep, setAcmeStep] = useState<AcmeStep>("domain");
  const [acmeDomain, setAcmeDomain] = useState("");
  const [acmeWildcard, setAcmeWildcard] = useState(true);
  const [acmeOrderId, setAcmeOrderId] = useState("");
  const [acmeChallenges, setAcmeChallenges] = useState<DnsChallenge[]>([]);
  const [acmeLoading, setAcmeLoading] = useState(false);

  // Upload state
  const [uploadCert, setUploadCert] = useState("");
  const [uploadKey, setUploadKey] = useState("");
  const [uploadChain, setUploadChain] = useState("");
  const [uploadLoading, setUploadLoading] = useState(false);
  const [showChain, setShowChain] = useState(false);

  // Revert state
  const [showRevert, setShowRevert] = useState(false);
  const [reverting, setReverting] = useState(false);

  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      setError("");
      const res = await fetch("/api/tls/status");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setStatus(data);
      if (data.cert?.domains?.[0]) {
        setAcmeDomain(data.cert.domains[0].replace(/^\*\./, ""));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  useEffect(() => {
    if (!acmeDomain && status?.subjects?.length) {
      const base = status.subjects.find((s) => !s.startsWith("*"));
      if (base) setAcmeDomain(base);
    }
  }, [status, acmeDomain]);

  const handleStartAcme = async () => {
    if (!acmeDomain.trim()) { setError("Domain is required"); return; }
    setAcmeLoading(true);
    setError("");
    try {
      const res = await fetch("/api/tls/acme", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: acmeDomain.trim(), includeWildcard: acmeWildcard }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to start order");
      setAcmeOrderId(data.orderId);
      setAcmeChallenges(data.challenges);
      setAcmeStep("records");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start ACME order");
    } finally {
      setAcmeLoading(false);
    }
  };

  const handleVerifyAcme = async () => {
    setAcmeLoading(true);
    setError("");
    setAcmeStep("verifying");
    try {
      const res = await fetch("/api/tls/acme", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: acmeOrderId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Verification failed");
      setAcmeStep("done");
      setSuccess(data.message || "Certificate issued successfully!");
      fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "ACME verification failed");
      setAcmeStep("records");
    } finally {
      setAcmeLoading(false);
    }
  };

  const handleUpload = async () => {
    if (!uploadCert.trim() || !uploadKey.trim()) {
      setError("Certificate and private key are required");
      return;
    }
    setUploadLoading(true);
    setError("");
    try {
      const res = await fetch("/api/tls/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          certificate: uploadCert.trim(),
          privateKey: uploadKey.trim(),
          chain: uploadChain.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");
      setSuccess(data.message || "Certificate uploaded!");
      setView("status");
      setUploadCert("");
      setUploadKey("");
      setUploadChain("");
      fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploadLoading(false);
    }
  };

  const handleRevert = async () => {
    setReverting(true);
    setError("");
    try {
      const res = await fetch("/api/tls/status", { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Revert failed");
      setSuccess(data.message || "Reverted to self-signed");
      setShowRevert(false);
      fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Revert failed");
    } finally {
      setReverting(false);
    }
  };

  const handleDownload = (type: string) => {
    window.open(`/api/tls/download?type=${type}`, "_blank");
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
    reader.onload = (ev) => setter((ev.target?.result as string) || "");
    reader.readAsText(file);
  };

  const modeLabel = status?.mode === "acme" ? "Let's Encrypt" : status?.mode === "manual" ? "Custom" : "Self-Signed";
  const modeColor = status?.mode === "acme" ? "green" : status?.mode === "manual" ? "var(--embed-primary)" : "var(--embed-text-muted)";

  if (loading) {
    return (
      <div style={{ padding: 16 }}>
        <style>{styles}</style>
        <div className="embed-skeleton" style={{ height: 20, width: 200, marginBottom: 16 }} />
        <div className="embed-skeleton" style={{ height: 120, width: "100%", marginBottom: 12 }} />
        <div className="embed-skeleton" style={{ height: 40, width: 200 }} />
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
      <style>{styles}</style>

      {/* Header */}
      <div className="embed-header">
        <div>
          <div className="embed-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
            TLS Certificates
            <span className="embed-badge" style={{ color: modeColor, borderColor: `color-mix(in srgb, ${modeColor} 40%, transparent)` }}>
              {modeLabel}
            </span>
          </div>
          <div className="embed-subtitle">Manage HTTPS certificates for your server</div>
        </div>
        <button className="embed-btn" onClick={() => { setRefreshing(true); fetchStatus(); }} disabled={refreshing}>
          {refreshing ? "..." : "Refresh"}
        </button>
      </div>

      {/* Alerts */}
      {error && <div className="tls-alert tls-alert-error">{error}</div>}
      {success && <div className="tls-alert tls-alert-success">{success}</div>}
      {status?.expiryWarning && status.cert?.expiresAt && (
        <div className="tls-alert tls-alert-warn">
          <div>
            <strong>Certificate expires soon</strong>
            <div style={{ marginTop: 2 }}>Expires: {new Date(status.cert.expiresAt).toLocaleDateString()}. Renew to avoid browser warnings.</div>
          </div>
        </div>
      )}

      {/* ─── Status View ─── */}
      {view === "status" && (
        <>
          {/* Current cert info */}
          <div className="embed-card">
            {status?.hasExternalCert && status.cert ? (
              <>
                <div className="embed-card-title">
                  <span style={{ color: "var(--embed-success)" }}>&#128274;</span>
                  Active Certificate
                </div>
                <div className="tls-grid-info">
                  <span className="embed-muted">Issuer:</span>
                  <span className="embed-value">{status.cert.issuer}</span>
                  <span className="embed-muted">Domains:</span>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {status.cert.domains.map((d) => (
                      <span key={d} className="embed-badge embed-mono" style={{ fontSize: 11 }}>{d}</span>
                    ))}
                  </div>
                  {status.cert.expiresAt && (
                    <>
                      <span className="embed-muted">Expires:</span>
                      <span className="embed-value">{new Date(status.cert.expiresAt).toLocaleDateString()}</span>
                    </>
                  )}
                  {status.cert.issuedAt && (
                    <>
                      <span className="embed-muted">Issued:</span>
                      <span>{new Date(status.cert.issuedAt).toLocaleDateString()}</span>
                    </>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="embed-card-title">
                  <span>&#128274;</span>
                  Self-Signed (Internal CA)
                </div>
                <div className="embed-muted" style={{ fontSize: 13 }}>
                  Using Caddy&apos;s internal CA. Browsers will show &quot;connection not secure&quot; warnings.
                  Get a real certificate or download the CA cert below to trust it.
                </div>
              </>
            )}
          </div>

          {/* Actions */}
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button
              className="tls-btn-primary"
              onClick={() => { setView("acme"); setAcmeStep("domain"); setError(""); setSuccess(""); }}
            >
              {status?.mode === "acme" ? "Renew Certificate" : "Get Let's Encrypt Cert"}
            </button>
            <button
              className="embed-btn"
              onClick={() => { setView("upload"); setError(""); setSuccess(""); }}
            >
              Upload Custom Cert
            </button>
          </div>

          {/* Downloads */}
          <hr className="tls-divider" />
          <div className="embed-card-title" style={{ marginBottom: 8 }}>Downloads</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {status?.hasExternalCert && (
              <>
                <button className="embed-btn" onClick={() => handleDownload("cert")}>&#128196; Certificate</button>
                <button className="embed-btn" onClick={() => handleDownload("key")}>&#128273; Private Key</button>
                <button className="embed-btn" onClick={() => handleDownload("bundle")}>&#128230; Bundle (JSON)</button>
              </>
            )}
            <button className="embed-btn" onClick={() => handleDownload("ca")}>&#128737; CA Cert (Trust)</button>
          </div>
          <div className="embed-muted" style={{ fontSize: 12, marginTop: 6 }}>
            {status?.hasExternalCert
              ? "Download your certificate and key as a backup."
              : "Download the CA certificate to trust self-signed certs in your browser/OS."}
          </div>

          {/* Revert */}
          {status?.hasExternalCert && (
            <>
              <hr className="tls-divider" />
              {showRevert ? (
                <div className="tls-alert tls-alert-warn" style={{ flexDirection: "column" }}>
                  <strong>Revert to self-signed certificates?</strong>
                  <div style={{ fontSize: 12, marginTop: 4 }}>
                    This will remove the current certificate and switch back to Caddy&apos;s internal CA.
                    Browsers will show security warnings again.
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <button className="tls-btn-danger" onClick={handleRevert} disabled={reverting}>
                      {reverting && <span className="tls-spinner" />}
                      Yes, Revert
                    </button>
                    <button className="embed-btn" onClick={() => setShowRevert(false)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <button
                  className="embed-btn"
                  style={{ color: "var(--embed-text-muted)", fontSize: 12 }}
                  onClick={() => setShowRevert(true)}
                >
                  Revert to self-signed certificates
                </button>
              )}
            </>
          )}
        </>
      )}

      {/* ─── ACME Flow ─── */}
      {view === "acme" && (
        <>
          {acmeStep === "domain" && (
            <>
              <div className="tls-alert tls-alert-info" style={{ flexDirection: "column" }}>
                <strong>How it works</strong>
                <div style={{ marginTop: 4, opacity: 0.85 }}>
                  We&apos;ll request a certificate from Let&apos;s Encrypt. You&apos;ll need to create DNS TXT
                  records at your domain provider to prove ownership. Works with any DNS provider.
                </div>
              </div>

              <div className="embed-card">
                <div style={{ marginBottom: 12 }}>
                  <label className="tls-label">Domain</label>
                  <input
                    className="tls-input"
                    value={acmeDomain}
                    onChange={(e) => setAcmeDomain(e.target.value)}
                    placeholder="example.com"
                  />
                </div>

                <label className="tls-checkbox">
                  <input
                    type="checkbox"
                    checked={acmeWildcard}
                    onChange={(e) => setAcmeWildcard(e.target.checked)}
                  />
                  Include wildcard (*.{acmeDomain || "example.com"})
                </label>
              </div>

              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button className="tls-btn-primary" onClick={handleStartAcme} disabled={acmeLoading || !acmeDomain.trim()}>
                  {acmeLoading && <span className="tls-spinner" />}
                  Request Certificate
                </button>
                <button className="embed-btn" onClick={() => { setView("status"); setError(""); }}>Cancel</button>
              </div>
            </>
          )}

          {acmeStep === "records" && (
            <>
              <div className="tls-alert tls-alert-warn" style={{ flexDirection: "column" }}>
                <strong>Create these DNS TXT records</strong>
                <div style={{ marginTop: 4, opacity: 0.85 }}>
                  Go to your DNS provider and create the TXT records below. Both records use the same name
                  but different values. Wait a few minutes for DNS propagation before verifying.
                </div>
              </div>

              {acmeChallenges.map((ch, i) => (
                <div key={i} className="embed-card" style={{ marginTop: 8 }}>
                  <div className="embed-card-title">
                    <span className="embed-badge embed-mono" style={{ fontSize: 11 }}>{ch.domain}</span>
                  </div>
                  <div className="tls-grid-info">
                    <span className="embed-muted">Type:</span>
                    <span className="embed-mono embed-value">TXT</span>
                    <span className="embed-muted">Name:</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span className="tls-code" style={{ flex: 1 }}>{ch.txtName}</span>
                      <button className="tls-copy-btn" onClick={() => copyText(ch.txtName, i * 2)}>
                        {copiedIndex === i * 2 ? "\u2713" : "\u2398"}
                      </button>
                    </div>
                    <span className="embed-muted">Value:</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span className="tls-code" style={{ flex: 1 }}>{ch.txtValue}</span>
                      <button className="tls-copy-btn" onClick={() => copyText(ch.txtValue, i * 2 + 1)}>
                        {copiedIndex === i * 2 + 1 ? "\u2713" : "\u2398"}
                      </button>
                    </div>
                  </div>
                </div>
              ))}

              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button className="tls-btn-primary" onClick={handleVerifyAcme} disabled={acmeLoading}>
                  {acmeLoading && <span className="tls-spinner" />}
                  Verify &amp; Issue Certificate
                </button>
                <button className="embed-btn" onClick={() => { setView("status"); setAcmeStep("domain"); setError(""); }}>Cancel</button>
              </div>
            </>
          )}

          {acmeStep === "verifying" && (
            <div style={{ textAlign: "center", padding: "40px 0" }}>
              <div className="tls-spinner" style={{ width: 32, height: 32, borderWidth: 3, marginBottom: 12 }} />
              <div style={{ fontSize: 14 }}>Verifying DNS records and issuing certificate...</div>
              <div className="embed-muted" style={{ fontSize: 12, marginTop: 4 }}>This may take up to 60 seconds</div>
            </div>
          )}

          {acmeStep === "done" && (
            <div style={{ textAlign: "center", padding: "32px 0" }}>
              <div style={{ fontSize: 48, marginBottom: 8 }}>&#128994;</div>
              <div style={{ fontSize: 16, fontWeight: 600 }}>Certificate Issued!</div>
              <div className="embed-muted" style={{ fontSize: 13, marginTop: 4 }}>
                Your site is now using a trusted Let&apos;s Encrypt certificate. No more browser warnings.
              </div>
              <button
                className="tls-btn-primary"
                style={{ marginTop: 16 }}
                onClick={() => { setView("status"); setAcmeStep("domain"); setSuccess(""); }}
              >
                Done
              </button>
            </div>
          )}
        </>
      )}

      {/* ─── Upload View ─── */}
      {view === "upload" && (
        <>
          <div className="tls-alert tls-alert-info">
            Upload a PEM-encoded certificate and private key. Optionally include the CA chain.
          </div>

          <div className="embed-card">
            <div style={{ marginBottom: 12 }}>
              <label className="tls-label">Certificate (PEM)</label>
              <div style={{ display: "flex", gap: 6 }}>
                <textarea
                  className="tls-textarea"
                  value={uploadCert}
                  onChange={(e) => setUploadCert(e.target.value)}
                  placeholder={"-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"}
                />
                <label className="tls-file-btn">
                  &#128193;
                  <input type="file" style={{ display: "none" }} accept=".pem,.crt,.cer" onChange={(e) => readFile(e, setUploadCert)} />
                </label>
              </div>
            </div>

            <div style={{ marginBottom: 12 }}>
              <label className="tls-label">Private Key (PEM)</label>
              <div style={{ display: "flex", gap: 6 }}>
                <textarea
                  className="tls-textarea"
                  value={uploadKey}
                  onChange={(e) => setUploadKey(e.target.value)}
                  placeholder={"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"}
                />
                <label className="tls-file-btn">
                  &#128193;
                  <input type="file" style={{ display: "none" }} accept=".pem,.key" onChange={(e) => readFile(e, setUploadKey)} />
                </label>
              </div>
            </div>

            <button
              className="embed-btn"
              style={{ fontSize: 12, marginBottom: showChain ? 8 : 0 }}
              onClick={() => setShowChain(!showChain)}
            >
              {showChain ? "\u25BC" : "\u25B6"} CA Chain (optional)
            </button>

            {showChain && (
              <div style={{ marginTop: 8 }}>
                <div style={{ display: "flex", gap: 6 }}>
                  <textarea
                    className="tls-textarea"
                    style={{ minHeight: 80 }}
                    value={uploadChain}
                    onChange={(e) => setUploadChain(e.target.value)}
                    placeholder={"-----BEGIN CERTIFICATE-----\n(intermediate CA)\n-----END CERTIFICATE-----"}
                  />
                  <label className="tls-file-btn">
                    &#128193;
                    <input type="file" style={{ display: "none" }} accept=".pem,.crt" onChange={(e) => readFile(e, setUploadChain)} />
                  </label>
                </div>
              </div>
            )}
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button className="tls-btn-primary" onClick={handleUpload} disabled={uploadLoading || !uploadCert.trim() || !uploadKey.trim()}>
              {uploadLoading && <span className="tls-spinner" />}
              Upload &amp; Apply
            </button>
            <button className="embed-btn" onClick={() => { setView("status"); setError(""); }}>Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}

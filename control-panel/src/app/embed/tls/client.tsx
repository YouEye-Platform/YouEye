"use client";

import {useLocale} from "next-intl";



import { useTranslations as useInterfaceTranslations } from "next-intl";
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
  const locale = useLocale();

  const translateInterface = useInterfaceTranslations("interface");

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
      setError(translateInterface("m3d2301d732a7"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [translateInterface]);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  useEffect(() => {
    if (!acmeDomain && status?.subjects?.length) {
      const base = status.subjects.find((s) => !s.startsWith("*"));
      if (base) setAcmeDomain(base);
    }
  }, [status, acmeDomain]);

  const handleStartAcme = async () => {
    if (!acmeDomain.trim()) { setError(translateInterface("m025f3d105c5c")); return; }
    setAcmeLoading(true);
    setError("");
    try {
      const res = await fetch("/api/tls/acme", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: acmeDomain.trim(), includeWildcard: acmeWildcard }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || translateInterface("m2f673d027cb1"));
      setAcmeOrderId(data.orderId);
      setAcmeChallenges(data.challenges);
      setAcmeStep("records");
    } catch (e) {
      setError(translateInterface("mc1b00659ebeb"));
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
      if (!res.ok) throw new Error(data.error || translateInterface("mf0f2383f8af8"));
      setAcmeStep("done");
      setSuccess(data.message || translateInterface("m26b80c3c27f9"));
      fetchStatus();
    } catch (e) {
      setError(translateInterface("m9cb66c320c50"));
      setAcmeStep("records");
    } finally {
      setAcmeLoading(false);
    }
  };

  const handleUpload = async () => {
    if (!uploadCert.trim() || !uploadKey.trim()) {
      setError(translateInterface("m6e1528a08a73"));
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
      if (!res.ok) throw new Error(data.error || translateInterface("m6efc5d27f30b"));
      setSuccess(data.message || translateInterface("mae8524ccf5dc"));
      setView("status");
      setUploadCert("");
      setUploadKey("");
      setUploadChain("");
      fetchStatus();
    } catch (e) {
      setError(translateInterface("m6efc5d27f30b"));
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
      if (!res.ok) throw new Error(data.error || translateInterface("m6ee282348d7c"));
      setSuccess(data.message || translateInterface("mf820d9da0b90"));
      setShowRevert(false);
      fetchStatus();
    } catch (e) {
      setError(translateInterface("m6ee282348d7c"));
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
            {translateInterface("maff037d4fc15")}<span className="embed-badge" style={{ color: modeColor, borderColor: `color-mix(in srgb, ${modeColor} 40%, transparent)` }}>
              {modeLabel}
            </span>
          </div>
          <div className="embed-subtitle">{translateInterface("m147c93ae09fe")}</div>
        </div>
        <button className="embed-btn" onClick={() => { setRefreshing(true); fetchStatus(); }} disabled={refreshing}>
          {refreshing ? "..." : translateInterface("m0e9161011702")}
        </button>
      </div>

      {/* Alerts */}
      {error && <div className="tls-alert tls-alert-error">{error}</div>}
      {success && <div className="tls-alert tls-alert-success">{success}</div>}
      {status?.expiryWarning && status.cert?.expiresAt && (
        <div className="tls-alert tls-alert-warn">
          <div>
            <strong>{translateInterface("m5f5c32cc9753")}</strong>
            <div style={{ marginTop: 2 }}>{translateInterface("m8353d67bd934")}{" "}{new Date(status.cert.expiresAt).toLocaleDateString(locale)}. {translateInterface("m63de71afc9c7")}</div>
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
                  {translateInterface("m1ce41b83b068")}</div>
                <div className="tls-grid-info">
                  <span className="embed-muted">{translateInterface("m7930901f3c02")}</span>
                  <span className="embed-value">{status.cert.issuer}</span>
                  <span className="embed-muted">{translateInterface("mc989877eb709")}</span>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {status.cert.domains.map((d) => (
                      <span key={d} className="embed-badge embed-mono" style={{ fontSize: 11 }}>{d}</span>
                    ))}
                  </div>
                  {status.cert.expiresAt && (
                    <>
                      <span className="embed-muted">{translateInterface("m8353d67bd934")}</span>
                      <span className="embed-value">{new Date(status.cert.expiresAt).toLocaleDateString(locale)}</span>
                    </>
                  )}
                  {status.cert.issuedAt && (
                    <>
                      <span className="embed-muted">{translateInterface("m2b7dcdb1716b")}</span>
                      <span>{new Date(status.cert.issuedAt).toLocaleDateString(locale)}</span>
                    </>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="embed-card-title">
                  <span>&#128274;</span>
                  {translateInterface("m835da8135cf3")}</div>
                <div className="embed-muted" style={{ fontSize: 13 }}>
                  {translateInterface("ma663083e1e2b")}</div>
              </>
            )}
          </div>

          {/* Actions */}
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button
              className="tls-btn-primary"
              onClick={() => { setView("acme"); setAcmeStep("domain"); setError(""); setSuccess(""); }}
            >
              {status?.mode === "acme" ? translateInterface("m3bcbc096dc74") : translateInterface("m07e839232f04")}
            </button>
            <button
              className="embed-btn"
              onClick={() => { setView("upload"); setError(""); setSuccess(""); }}
            >
              {translateInterface("m3bf168da3ad5")}</button>
          </div>

          {/* Downloads */}
          <hr className="tls-divider" />
          <div className="embed-card-title" style={{ marginBottom: 8 }}>{translateInterface("md5fdc1af021e")}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {status?.hasExternalCert && (
              <>
                <button className="embed-btn" onClick={() => handleDownload("zip")} style={{ borderColor: "var(--embed-primary)", color: "var(--embed-primary)" }}>&#128230; {translateInterface("m804e7816254a")}</button>
                <button className="embed-btn" onClick={() => handleDownload("cert")}>&#128196; {translateInterface("m2a93a8a442e3")}</button>
                <button className="embed-btn" onClick={() => handleDownload("key")}>&#128273; {translateInterface("m477bf990a2b3")}</button>
                <button className="embed-btn" onClick={() => handleDownload("bundle")}>&#128230; {translateInterface("mefdb4951bd3c")}</button>
              </>
            )}
            <button className="embed-btn" onClick={() => handleDownload("ca")}>&#128737; {translateInterface("mf1bff5f5ecc2")}</button>
          </div>
          <div className="embed-muted" style={{ fontSize: 12, marginTop: 6 }}>
            {status?.hasExternalCert
              ? translateInterface("ma62502117021")
              : translateInterface("mdb5198eb86c0")}
          </div>

          {/* Revert */}
          {status?.hasExternalCert && (
            <>
              <hr className="tls-divider" />
              {showRevert ? (
                <div className="tls-alert tls-alert-warn" style={{ flexDirection: "column" }}>
                  <strong>{translateInterface("m56b7e3a9c9a2")}</strong>
                  <div style={{ fontSize: 12, marginTop: 4 }}>
                    {translateInterface("mcb8b1cb24ac4")}</div>
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <button className="tls-btn-danger" onClick={handleRevert} disabled={reverting}>
                      {reverting && <span className="tls-spinner" />}
                      {translateInterface("m4a30ea7978d0")}</button>
                    <button className="embed-btn" onClick={() => setShowRevert(false)}>{translateInterface("m19766ed6ccb2")}</button>
                  </div>
                </div>
              ) : (
                <button
                  className="embed-btn"
                  style={{ color: "var(--embed-text-muted)", fontSize: 12 }}
                  onClick={() => setShowRevert(true)}
                >
                  {translateInterface("m2f586608e495")}</button>
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
                <strong>{translateInterface("m9c870aa6e5e9")}</strong>
                <div style={{ marginTop: 4, opacity: 0.85 }}>
                  {translateInterface("m380027883d18")}</div>
              </div>

              <div className="embed-card">
                <div style={{ marginBottom: 12 }}>
                  <label className="tls-label">{translateInterface("m79fa33618d8e")}</label>
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
                  {translateInterface("m839a9fa3868f", {domain: acmeDomain || "example.com"})}
                </label>
              </div>

              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button className="tls-btn-primary" onClick={handleStartAcme} disabled={acmeLoading || !acmeDomain.trim()}>
                  {acmeLoading && <span className="tls-spinner" />}
                  {translateInterface("m6cc6d341a437")}</button>
                <button className="embed-btn" onClick={() => { setView("status"); setError(""); }}>{translateInterface("m19766ed6ccb2")}</button>
              </div>
            </>
          )}

          {acmeStep === "records" && (
            <>
              <div className="tls-alert tls-alert-warn" style={{ flexDirection: "column" }}>
                <strong>{translateInterface("m445521d814f4")}</strong>
                <div style={{ marginTop: 4, opacity: 0.85 }}>
                  {translateInterface("mac13c5005bbe")}</div>
              </div>

              {acmeChallenges.map((ch, i) => (
                <div key={i} className="embed-card" style={{ marginTop: 8 }}>
                  <div className="embed-card-title">
                    <span className="embed-badge embed-mono" style={{ fontSize: 11 }}>{ch.domain}</span>
                  </div>
                  <div className="tls-grid-info">
                    <span className="embed-muted">{translateInterface("m6cc5ad2e47e3")}</span>
                    <span className="embed-mono embed-value">TXT</span>
                    <span className="embed-muted">{translateInterface("m2683cad48a14")}</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span className="tls-code" style={{ flex: 1 }}>{ch.txtName}</span>
                      <button className="tls-copy-btn" onClick={() => copyText(ch.txtName, i * 2)}>
                        {copiedIndex === i * 2 ? "\u2713" : "\u2398"}
                      </button>
                    </div>
                    <span className="embed-muted">{translateInterface("m224a3369a5c9")}</span>
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
                  {translateInterface("m31ca065bcea0")}</button>
                <button className="embed-btn" onClick={() => { setView("status"); setAcmeStep("domain"); setError(""); }}>{translateInterface("m19766ed6ccb2")}</button>
              </div>
            </>
          )}

          {acmeStep === "verifying" && (
            <div style={{ textAlign: "center", padding: "40px 0" }}>
              <div className="tls-spinner" style={{ width: 32, height: 32, borderWidth: 3, marginBottom: 12 }} />
              <div style={{ fontSize: 14 }}>{translateInterface("m4cbac8317690")}</div>
              <div className="embed-muted" style={{ fontSize: 12, marginTop: 4 }}>{translateInterface("m9fba4a2b677a")}</div>
            </div>
          )}

          {acmeStep === "done" && (
            <div style={{ textAlign: "center", padding: "32px 0" }}>
              <div style={{ fontSize: 48, marginBottom: 8 }}>&#128994;</div>
              <div style={{ fontSize: 16, fontWeight: 600 }}>{translateInterface("mef62371032e6")}</div>
              <div className="embed-muted" style={{ fontSize: 13, marginTop: 4 }}>
                {translateInterface("m6e65cac27aa0")}</div>
              <button
                className="tls-btn-primary"
                style={{ marginTop: 16 }}
                onClick={() => { setView("status"); setAcmeStep("domain"); setSuccess(""); }}
              >
                {translateInterface("m11a6767d5674")}</button>
            </div>
          )}
        </>
      )}

      {/* ─── Upload View ─── */}
      {view === "upload" && (
        <>
          <div className="tls-alert tls-alert-info">
            {translateInterface("mc2334e188834")}</div>

          <div className="embed-card">
            <div style={{ marginBottom: 12 }}>
              <label className="tls-label">{translateInterface("m294125f6aa9a")}</label>
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
              <label className="tls-label">{translateInterface("m8c1f7dceb586")}</label>
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
              {showChain ? "\u25BC" : "\u25B6"} {translateInterface("m719ac07a0200")}</button>

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
              {translateInterface("me95bc9836710")}</button>
            <button className="embed-btn" onClick={() => { setView("status"); setError(""); }}>{translateInterface("m19766ed6ccb2")}</button>
          </div>
        </>
      )}
    </div>
  );
}

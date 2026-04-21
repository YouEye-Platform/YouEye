"use client";

/**
 * Embed Auth Error Component
 *
 * When a user loads a CP embed without a session, this component
 * automatically triggers a silent SSO redirect. Since the user is
 * already authenticated with Authentik (they logged into YE-UI via SSO),
 * Authentik grants immediately — no login form shown.
 *
 * The redirect chain (all inside the iframe):
 *   1. /embed/... → no session → this component renders
 *   2. Auto-redirect to /api/auth/sso?redirect=/embed/...
 *   3. → Authentik authorize (instant grant, user already has session)
 *   4. → /api/auth/callback → creates ye-session cookie
 *   5. → Redirects back to /embed/... → now has session, renders content
 *
 * If the user is NOT authenticated with Authentik at all (e.g. PAM-only
 * login on localhost), falls back to a manual sign-in button.
 */

import { useEffect, useState, useRef } from "react";

interface EmbedAuthErrorProps {
  reason: string;
  showSignIn?: boolean;
}

export function EmbedAuthError({ reason, showSignIn = true }: EmbedAuthErrorProps) {
  const [controlUrl, setControlUrl] = useState("");
  const [autoRedirectFailed, setAutoRedirectFailed] = useState(false);
  const redirectAttempted = useRef(false);

  useEffect(() => {
    setControlUrl(window.location.origin);
  }, []);

  // Auto-redirect to SSO on mount (silent — no user interaction needed)
  useEffect(() => {
    if (!showSignIn || !controlUrl || redirectAttempted.current) return;
    redirectAttempted.current = true;

    // Build the redirect URL back to the current embed page
    const currentPath = window.location.pathname + window.location.search;
    const ssoUrl = `${controlUrl}/api/auth/sso?redirect=${encodeURIComponent(currentPath)}`;

    // Set a timeout — if we're still here after 8s, SSO didn't work
    // (e.g. user is PAM-only, or Authentik is down)
    const timeout = setTimeout(() => {
      setAutoRedirectFailed(true);
    }, 8000);

    // Navigate the iframe to the SSO endpoint
    window.location.href = ssoUrl;

    return () => clearTimeout(timeout);
  }, [showSignIn, controlUrl]);

  const handleSignIn = () => {
    const popup = window.open(
      `${controlUrl}/login?redirect=/api/auth/popup-close`,
      "youeye-login",
      "width=500,height=700,menubar=no,toolbar=no"
    );

    const checkClosed = setInterval(() => {
      if (popup?.closed) {
        clearInterval(checkClosed);
        window.location.reload();
      }
    }, 500);
  };

  // During auto-redirect, show a minimal loading state
  if (showSignIn && !autoRedirectFailed) {
    return (
      <div className="embed-auth-error">
        <div className="embed-auth-spinner" />
        <div className="embed-auth-message">Connecting...</div>
        <style jsx>{`
          .embed-auth-error {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 48px 24px;
            text-align: center;
            min-height: 200px;
          }
          .embed-auth-spinner {
            width: 24px;
            height: 24px;
            border: 2px solid var(--embed-border, #27272a);
            border-top-color: var(--embed-primary, #3b82f6);
            border-radius: 50%;
            animation: embed-spin 0.6s linear infinite;
            margin-bottom: 16px;
          }
          @keyframes embed-spin {
            to { transform: rotate(360deg); }
          }
          .embed-auth-message {
            color: var(--embed-text-muted, #a1a1aa);
            font-size: 13px;
          }
        `}</style>
      </div>
    );
  }

  // Fallback: manual sign-in (PAM users or SSO failure)
  return (
    <div className="embed-auth-error">
      <div className="embed-auth-icon">
        <svg
          width="48"
          height="48"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <circle cx="12" cy="8" r="4" />
          <path d="M6 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2" />
        </svg>
      </div>
      <div className="embed-auth-message">{reason}</div>
      {(showSignIn || autoRedirectFailed) && (
        <button className="embed-auth-btn" onClick={handleSignIn}>
          Sign In
        </button>
      )}
      <style jsx>{`
        .embed-auth-error {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 48px 24px;
          text-align: center;
          min-height: 200px;
        }
        .embed-auth-icon {
          color: var(--embed-text-muted, #a1a1aa);
          margin-bottom: 16px;
        }
        .embed-auth-message {
          color: var(--embed-text-muted, #a1a1aa);
          font-size: 14px;
          margin-bottom: 24px;
          max-width: 280px;
        }
        .embed-auth-btn {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 10px 20px;
          border-radius: 8px;
          border: none;
          background: var(--embed-primary, #3b82f6);
          color: white;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          transition: opacity 0.15s;
        }
        .embed-auth-btn:hover {
          opacity: 0.9;
        }
      `}</style>
    </div>
  );
}

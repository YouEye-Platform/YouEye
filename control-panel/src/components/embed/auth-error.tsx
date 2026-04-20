"use client";

/**
 * Embed Auth Error Component
 *
 * Displayed when user needs to authenticate to view an embed.
 * Shows a sign-in button that opens CP login in a popup.
 */

import { useEffect, useState } from "react";

interface EmbedAuthErrorProps {
  reason: string;
  showSignIn?: boolean;
}

export function EmbedAuthError({ reason, showSignIn = true }: EmbedAuthErrorProps) {
  const [controlUrl, setControlUrl] = useState("");

  useEffect(() => {
    // Get the control panel URL from the current window location
    // The embed is served from control.devvm.test, so we can use the current origin
    setControlUrl(window.location.origin);
  }, []);

  const handleSignIn = () => {
    // Open login in a popup - when user completes SSO, they'll be logged into CP
    // Then they can refresh the embed to see the content
    const popup = window.open(
      `${controlUrl}/login?redirect=/api/auth/popup-close`,
      "youeye-login",
      "width=500,height=700,menubar=no,toolbar=no"
    );

    // Listen for popup close and reload
    const checkClosed = setInterval(() => {
      if (popup?.closed) {
        clearInterval(checkClosed);
        window.location.reload();
      }
    }, 500);
  };

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
      {showSignIn && (
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

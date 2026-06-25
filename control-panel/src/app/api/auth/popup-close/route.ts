/**
 * Popup Close Route
 *
 * After SSO login from an embed's sign-in popup, redirect here.
 * This page shows a "You can close this window" message and auto-closes.
 */

import { NextResponse } from "next/server";

export async function GET() {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Sign In Complete</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: #18181b;
      color: #e4e4e7;
    }
    .container {
      text-align: center;
      padding: 24px;
    }
    .icon {
      color: #22c55e;
      margin-bottom: 16px;
    }
    h1 {
      font-size: 20px;
      font-weight: 600;
      margin: 0 0 8px;
    }
    p {
      color: #a1a1aa;
      font-size: 14px;
      margin: 0;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
        <polyline points="22 4 12 14.01 9 11.01" />
      </svg>
    </div>
    <h1>Sign in complete</h1>
    <p>You can close this window now.</p>
  </div>
  <script>
    // Try to close the popup automatically
    setTimeout(function() {
      window.close();
    }, 1500);
  </script>
</body>
</html>
`;

  return new NextResponse(html, {
    headers: { "Content-Type": "text/html" },
  });
}

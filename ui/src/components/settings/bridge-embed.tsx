"use client";

/**
 * Bridge Embed — iframes the CP bridge management page.
 * Admin-only component shown in Settings > Apps > [appId].
 * The iframe loads CP's /embed/app-network/{appId} page
 * which has no CP chrome (bare layout).
 */

export function BridgeEmbed({ appId }: { appId: string }) {
  const cpUrl =
    process.env.NEXT_PUBLIC_CP_EMBED_URL ||
    `${typeof window !== "undefined" ? window.location.origin : ""}/control`;

  return (
    <iframe
      src={`${cpUrl}/embed/app-network/${appId}`}
      style={{
        width: "100%",
        minHeight: 200,
        border: "1px solid hsl(var(--border))",
        borderRadius: 8,
        background: "transparent",
      }}
      title="App Network Bridges"
      sandbox="allow-scripts allow-same-origin allow-forms"
    />
  );
}

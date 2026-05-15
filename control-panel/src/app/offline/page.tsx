/**
 * Offline Fallback Page — Control Panel
 *
 * Shown by the service worker when the admin is offline and the
 * requested page isn't cached. Minimal inline styles — no external deps.
 */

export default function OfflinePage() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "#f9fafb",
        color: "#111827",
        fontFamily: "system-ui, -apple-system, sans-serif",
        padding: "2rem",
        textAlign: "center",
      }}
    >
      <div
        style={{
          width: 64,
          height: 64,
          borderRadius: 14,
          background: "#2563eb",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          marginBottom: "1.5rem",
          fontSize: 28,
          fontWeight: 700,
          color: "#fff",
        }}
      >
        Control
      </div>
      <h1 style={{ fontSize: "1.5rem", fontWeight: 600, margin: "0 0 0.5rem" }}>
        You&apos;re offline
      </h1>
      <p style={{ color: "#6b7280", maxWidth: 320, lineHeight: 1.5 }}>
        The Control Panel requires a network connection. This page will reload
        automatically when connectivity is restored.
      </p>
      <script
        dangerouslySetInnerHTML={{
          __html: `window.addEventListener('online', () => location.reload())`,
        }}
      />
    </div>
  );
}

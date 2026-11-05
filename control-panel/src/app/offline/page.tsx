import { useTranslations as useInterfaceTranslations } from "next-intl";
/**
 * Offline Fallback Page — Control Panel
 *
 * Shown by the service worker when the admin is offline and the
 * requested page isn't cached. Minimal inline styles — no external deps.
 */

export default function OfflinePage() {
  const translateInterface = useInterfaceTranslations("interface");

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
        {translateInterface("m32d7e8208247")}</div>
      <h1 style={{ fontSize: "1.5rem", fontWeight: 600, margin: "0 0 0.5rem" }}>
        {translateInterface("m050be7950a63")}</h1>
      <p style={{ color: "#6b7280", maxWidth: 320, lineHeight: 1.5 }}>
        {translateInterface("mc8bbc24999c8")}</p>
      <script
        dangerouslySetInnerHTML={{
          __html: `window.addEventListener('online', () => location.reload())`,
        }}
      />
    </div>
  );
}

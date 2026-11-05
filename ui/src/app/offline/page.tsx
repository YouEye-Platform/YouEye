import { useTranslations as useInterfaceTranslations } from "next-intl";
/**
 * Offline Fallback Page
 *
 * Shown by the service worker when the user is offline and the requested
 * page isn't in the cache. Uses minimal styling that works without
 * external resources (no font loads, no API calls).
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
        background: "#0a0a0f",
        color: "#e4e4e7",
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
          background: "#8B5CF6",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          marginBottom: "1.5rem",
          fontSize: 28,
          fontWeight: 700,
          color: "#fff",
        }}
      >
        Y
      </div>
      <h1 style={{ fontSize: "1.5rem", fontWeight: 600, margin: "0 0 0.5rem" }}>
        {translateInterface("m050be7950a63")}</h1>
      <p style={{ color: "#a1a1aa", maxWidth: 320, lineHeight: 1.5 }}>
        {translateInterface("m73d83566ec0c")}</p>
      <script
        dangerouslySetInnerHTML={{
          __html: `window.addEventListener('online', () => location.reload())`,
        }}
      />
    </div>
  );
}

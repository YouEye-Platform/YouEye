/**
 * Embed Layout — bare HTML, no CP chrome.
 * Used when CP pages are iframed into YE-UI.
 */
export default function EmbedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0, background: "transparent" }}>
        {children}
      </body>
    </html>
  );
}

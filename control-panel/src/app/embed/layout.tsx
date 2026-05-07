/**
 * Embed Layout — wraps all /embed/* pages.
 * Used when CP pages are iframed into YE-UI settings.
 *
 * CSS is in embed-globals.css (compiled into the CSS bundle, survives React
 * hydration — unlike inline <style> tags in nested layouts which get stripped).
 *
 * Runtime behavior (theme, height reporting, postMessage) is handled by the
 * EmbedShell client component.
 *
 * IMPORTANT: This layout must NOT render <html> or <body> tags — those belong
 * to the root layout only. Nested <html>/<body> tags cause React hydration to
 * strip all inline <style> and <script> tags, breaking CSS overrides.
 */

import type { Metadata } from "next";
import "./embed-globals.css";
import { EmbedShell } from "./embed-shell";

export const metadata: Metadata = {
  title: "YouEye Embed",
};

export default function EmbedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <EmbedShell>{children}</EmbedShell>;
}

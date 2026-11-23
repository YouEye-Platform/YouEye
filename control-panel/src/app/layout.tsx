import { LocaleRefresh } from "@/components/locale-refresh";
import { localeDirection } from "@/i18n/config";
import type { Metadata, Viewport } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages, getTranslations as getInterfaceTranslations } from "next-intl/server";
import "./globals.css";
import { getSiteConfig } from "@/lib/site-config";
import { BrandingLocaleProvider } from "@youeye/branding/locale";

// Phone: draw to the screen edges (pages pad with env(safe-area-inset-*)), let the keyboard resize the page rather
// than cover it, and colour the status bar for each scheme (mobile-native, Emil Kowalski's skills).
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#11171b" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

export async function generateMetadata(): Promise<Metadata> {
  const config = await getSiteConfig();
  const translateInterface = await getInterfaceTranslations("interface");
  return {
    title: config.site_name,
    description: translateInterface("me650b9f859f9", {site: config.site_name}),
    icons: {
      icon: [
        { url: '/api/branding/favicon?size=32', sizes: '32x32', type: 'image/png' },
        { url: '/api/branding/favicon?size=16', sizes: '16x16', type: 'image/png' },
      ],
      apple: [
        { url: '/api/branding/favicon?size=180', sizes: '180x180', type: 'image/png' },
      ],
    },
    appleWebApp: {
      capable: true,
      statusBarStyle: "default",
      title: config.site_name,
    },
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    <html lang={locale} dir={localeDirection(locale)} suppressHydrationWarning>
      <body className="antialiased min-h-screen bg-background">
        {/* Apply the saved light/dark/system mode before first paint to avoid a
            flash. Reads the same localStorage("theme") key the dashboard's
            next-themes writes (same origin), so /settings matches the rest of
            the product immediately; control-header reconciles against the bridge
            value on mount. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var m=localStorage.getItem('theme');var s=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches;if(m==='dark'||((m==='system'||!m)&&s)){document.documentElement.classList.add('dark');}}catch(e){}})();",
          }}
        />
        <NextIntlClientProvider locale={locale} messages={messages}>
          <LocaleRefresh locale={locale} />
          <BrandingLocaleProvider locale={locale}>{children}</BrandingLocaleProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}

import { localeDirection } from "@/i18n/config";
import { LocaleRefresh } from "@/components/locale-refresh";
import type { Metadata, Viewport } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages, getTranslations } from "next-intl/server";
import { Providers } from "@/components/providers";
import "./globals.css";
import { getSiteName } from "@/lib/site-config";
import { BrandingLocaleProvider } from "@youeye/branding/locale";

export const viewport: Viewport = {
  themeColor: "#8B5CF6",
  width: "device-width",
  initialScale: 1,
};

export async function generateMetadata(): Promise<Metadata> {
  const siteName = await getSiteName();
  const translateInterface = await getTranslations("interface");
  return {
    title: siteName,
    description: translateInterface("m0374fb2f3056"),
    appleWebApp: {
      capable: true,
      statusBarStyle: "black-translucent",
      title: siteName,
    },
  };
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    <html lang={locale} dir={localeDirection(locale)} suppressHydrationWarning>
      <body className="min-h-screen antialiased">
        <NextIntlClientProvider locale={locale} messages={messages}>
          <LocaleRefresh locale={locale} endpoint="/api/v1/user/language" />
          <BrandingLocaleProvider locale={locale}><Providers>{children}</Providers></BrandingLocaleProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}

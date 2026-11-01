import { createTranslator } from "next-intl";
import type { NextPageContext } from "next";
import { resolveLocale } from "../i18n/config";
import en from "../../messages/en.json";
import ru from "../../messages/ru.json";
import es from "../../messages/es.json";
import de from "../../messages/de.json";
import fr from "../../messages/fr.json";

const messages = { en, ru, es, de, fr };

// Pages errors also render outside the App Router and its translation provider.
// Keep this path self-contained so reporting an error cannot trigger another one.
function Error({ statusCode, locale = "en" }: { statusCode?: number; locale?: string }) {
  const resolved = resolveLocale(locale) as keyof typeof messages;
  const translateInterface = createTranslator({ locale: resolved, messages: messages[resolved], namespace: "interface" });

  return (
    <div style={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center" }}>
      <div style={{ textAlign: "center" }}>
        <h1 style={{ fontSize: "2rem", fontWeight: "bold" }}>{statusCode || translateInterface("m54a0e8c17ebb")}</h1>
        <p style={{ color: "#666", marginTop: "0.5rem" }}>
          {statusCode === 404 ? translateInterface("ma469ab4ca4e5") : translateInterface("mddf785b79c42")}
        </p>
      </div>
    </div>
  );
}

Error.getInitialProps = ({ res, err, locale, req }: NextPageContext) => {
  const statusCode = res ? res.statusCode : err ? err.statusCode : 404;
  const preferred = typeof document === "undefined"
    ? locale ?? req?.headers["accept-language"]?.split(",")[0]?.split(";")[0]?.trim()
    : document.documentElement.lang;
  return { statusCode, locale: resolveLocale(preferred) };
};

export default Error;

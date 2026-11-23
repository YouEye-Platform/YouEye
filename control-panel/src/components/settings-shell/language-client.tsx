"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { languages as LANGUAGES } from "@/i18n/config";
import { PageHeader } from "./page-header";
import { uiSettingsApi } from "./api-base";

const FALLBACK_ZONES = ["UTC", "America/New_York", "Europe/London", "Europe/Berlin", "Asia/Tokyo", "Australia/Sydney"];

function deviceZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

/** "America/Argentina/Buenos_Aires" reads as "Argentina / Buenos Aires" under the "America" group. */
function zoneCity(zone: string): string {
  const slash = zone.indexOf("/");
  return (slash < 0 ? zone : zone.slice(slash + 1)).replace(/_/g, " ").replace(/\//g, " / ");
}

/** The current offset of a zone, like "GMT+2"; empty when the browser cannot say. */
function zoneOffset(zone: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: "shortOffset" })
      .formatToParts(new Date()).find((part) => part.type === "timeZoneName")?.value ?? "";
  } catch { return ""; }
}

/** Language & region: your language, your time zone, and how dates and times then read. Each choice saves at once. */
export function LanguageClient() {
  const t = useTranslations("languageSettings");
  const y = useTranslations("settingsYou.language");
  const locale = useLocale();

  const [language, setLanguage] = useState<string | null>(null);
  const [systemLanguage, setSystemLanguage] = useState<string | null>(null);
  const [languageReady, setLanguageReady] = useState(false);
  const [savingLanguage, setSavingLanguage] = useState<string | null | undefined>(undefined);
  const [languageStatus, setLanguageStatus] = useState("");

  const [timezone, setTimezone] = useState<string | null>(null);
  const [device, setDevice] = useState<string | null>(null);
  const [savingZone, setSavingZone] = useState(false);
  const [zoneStatus, setZoneStatus] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    fetch(uiSettingsApi("language"))
      .then((r) => r.json())
      .then((data) => {
        setLanguage(data.language ?? null);
        setSystemLanguage(data.systemLanguage ?? "en");
        setLanguageReady(true);
      })
      .catch(() => setLanguageStatus(t("loadFailed")));
  }, [t]);

  useEffect(() => {
    const here = deviceZone();
    setDevice(here);
    fetch(uiSettingsApi("profile"))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("profile"))))
      .then((data) => setTimezone(data?.timezone || here))
      .catch(() => { setTimezone(here); setZoneStatus({ text: y("timezoneLoadFailed"), error: true }); });
  }, [y]);

  async function chooseLanguage(next: string | null) {
    if (savingLanguage !== undefined || next === language) return;
    setSavingLanguage(next);
    setLanguageStatus("");
    try {
      const res = await fetch(uiSettingsApi("language"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language: next }),
      });
      if (!res.ok) throw new Error("save");
      setLanguage(next);
      // Signal other same-origin views. They re-read their own authenticated locale.
      if (typeof BroadcastChannel !== "undefined") {
        const channel = new BroadcastChannel("youeye-language");
        channel.postMessage({ type: "changed" });
        channel.close();
      }
      window.location.reload();
    } catch {
      setLanguageStatus(t("saveFailed"));
      setSavingLanguage(undefined);
    }
  }

  // Same save as Profile used: the profile PATCH takes the fields it is given.
  async function chooseZone(next: string) {
    if (savingZone || next === timezone) return;
    const previous = timezone;
    setTimezone(next);
    setSavingZone(true);
    setZoneStatus(null);
    try {
      const res = await fetch(uiSettingsApi("profile"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: next }),
      });
      if (!res.ok) throw new Error("save");
      setZoneStatus({ text: y("timezoneSaved"), error: false });
    } catch {
      setTimezone(previous);
      setZoneStatus({ text: y("timezoneSaveFailed"), error: true });
    } finally {
      setSavingZone(false);
    }
  }

  const activeLocale = language || systemLanguage || locale;

  // Zones grouped by region, so the list of about 400 can be scanned (and typed into: the browser's own type-ahead).
  // Built in the browser only (after mount), as the server's list of zones can differ from the browser's.
  const zoneGroups = useMemo(() => {
    if (!device) return [];
    let zones: string[];
    try { zones = Intl.supportedValuesOf("timeZone"); } catch { zones = FALLBACK_ZONES; }
    if (timezone && !zones.includes(timezone)) zones = [timezone, ...zones];
    const groups = new Map<string, Array<{ zone: string; label: string }>>();
    for (const zone of zones) {
      const region = zone.includes("/") ? zone.slice(0, zone.indexOf("/")) : "";
      const offset = zoneOffset(zone, "en");
      groups.set(region, [...(groups.get(region) ?? []), { zone, label: `${zoneCity(zone)}${offset ? ` (${offset})` : ""}` }]);
    }
    return [...groups.entries()].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
  }, [timezone, device]);

  // Formats follow the language; the clock follows the time zone. Worked out in the browser, once both are known.
  const formats = useMemo(() => {
    if (!languageReady || !timezone) return null;
    try {
      const now = new Date();
      const zoned = { timeZone: timezone };
      const hour12 = new Intl.DateTimeFormat(activeLocale, { hour: "numeric" }).resolvedOptions().hour12;
      return {
        date: new Intl.DateTimeFormat(activeLocale, { dateStyle: "full", ...zoned }).format(now),
        time: new Intl.DateTimeFormat(activeLocale, { timeStyle: "short", ...zoned }).format(now),
        clock: hour12 ? t("hour12") : t("hour24"),
        number: new Intl.NumberFormat(activeLocale).format(1234567.89),
      };
    } catch {
      return null;
    }
  }, [activeLocale, languageReady, timezone, t]);

  const serverLanguage = LANGUAGES.find((item) => item.code === (systemLanguage || "en"));
  const options: Array<{ code: string | null; label: string; detail: string }> = [
    { code: null, label: y("serverDefault"), detail: serverLanguage?.native ?? "" },
    ...LANGUAGES.map((item) => ({ code: item.code, label: item.native, detail: item.native !== item.english ? item.english : "" })),
  ];

  return (
    <div>
      <PageHeader title={y("title")} description={y("description")} />
      <div className="settings-sections">
        <section className="settings-section" aria-labelledby="language-yours">
          <h2 id="language-yours" className="settings-section-title">{t("personal")}</h2>
          <div role="radiogroup" aria-labelledby="language-yours" className="settings-group">
            {options.map((option) => {
              const active = languageReady && language === option.code;
              const saving = savingLanguage !== undefined && savingLanguage === option.code;
              return (
                <button
                  key={option.code ?? "default"}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={!languageReady || savingLanguage !== undefined}
                  onClick={() => void chooseLanguage(option.code)}
                  className="settings-row settings-row-compact"
                  lang={option.code ?? undefined}
                >
                  <span className="min-w-0 flex-1">
                    <span className={active ? "font-medium text-foreground" : "text-foreground"}>{option.label}</span>
                    {option.detail && <span className="ml-2 text-[13px] text-muted-foreground">{option.detail}</span>}
                  </span>
                  {saving
                    ? <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
                    : active && <Check className="size-4 shrink-0 text-primary" aria-hidden="true" />}
                </button>
              );
            })}
          </div>
          <p role="status" className="settings-note empty:hidden">{languageStatus}</p>
        </section>

        <section className="settings-section" aria-labelledby="language-region">
          <h2 id="language-region" className="settings-section-title">{y("region")}</h2>
          <div className="settings-group">
            <div className="settings-item">
              <label htmlFor="settings-timezone" className="settings-item-text">
                <span className="settings-item-label">{y("timezone")}</span>
                <span className="settings-item-hint">{y("timezoneHint")}</span>
              </label>
              <div className="w-full min-w-0 sm:w-72">
                <select
                  id="settings-timezone"
                  className="settings-select"
                  value={timezone ?? ""}
                  disabled={!timezone || !device || savingZone}
                  onChange={(event) => void chooseZone(event.target.value)}
                >
                  {!timezone && <option value="">{y("loading")}</option>}
                  {zoneGroups.map(([region, zones]) => (
                    <optgroup key={region || "other"} label={region || y("timezoneOther")}>
                      {zones.map(({ zone, label }) => <option key={zone} value={zone}>{label}</option>)}
                    </optgroup>
                  ))}
                </select>
              </div>
            </div>
            {timezone && device && device !== timezone && (
              <div className="settings-item">
                <span className="settings-item-text">
                  <span className="settings-item-hint">{y("timezoneDevice", { zone: device.replace(/_/g, " ") })}</span>
                </span>
                <button type="button" className="settings-link" disabled={savingZone} onClick={() => void chooseZone(device)}>{y("timezoneUseDevice")}</button>
              </div>
            )}
            {formats && (
              <div className="settings-item settings-item-top">
                <span className="settings-item-text">
                  <span className="settings-item-label">{y("formats")}</span>
                  <span className="settings-item-hint">{t("formatsHint")}</span>
                </span>
                <span className="block w-full min-w-0 text-sm tabular-nums text-foreground sm:w-72">
                  <span className="block">{formats.date}</span>
                  <span className="block">{formats.time} <span className="text-muted-foreground">({formats.clock})</span></span>
                  <span className="block">{formats.number}</span>
                </span>
              </div>
            )}
          </div>
          <p role="status" className={`settings-note empty:hidden ${zoneStatus?.error ? "text-destructive" : ""}`}>{zoneStatus?.text ?? ""}</p>
        </section>
      </div>
    </div>
  );
}

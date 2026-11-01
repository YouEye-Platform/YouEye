'use client';
import {useLocale} from "next-intl";

import {useTranslations as useInterfaceTranslations} from "next-intl";


interface HealthDotProps {
  healthStatus?: 'healthy' | 'unhealthy' | 'unknown';
  healthCheckedAt?: string | null;
  className?: string;
}



export function HealthDot({ healthStatus, healthCheckedAt, className = '' }: HealthDotProps) {
 const translateInterface = useInterfaceTranslations("interface");
  const locale = useLocale();

const CONFIG: Record<string, { color: string; pulse: boolean; tooltip: string }> = {
  healthy: { color: 'bg-green-500', pulse: false, tooltip: translateInterface("m7f1e323b6272") },
  unhealthy: { color: 'bg-red-500', pulse: true, tooltip: translateInterface("m19d0d2cbe249") },
  unknown: { color: 'bg-gray-300', pulse: false, tooltip: translateInterface("m6a5465ac1dd5") },
};

function formatTimeAgo(date: Date): string {
  const minutes = Math.round((date.getTime() - Date.now()) / 60000);
  if (!Number.isFinite(minutes)) return "";
  return new Intl.RelativeTimeFormat(locale, {numeric: "auto"}).format(Math.abs(minutes) < 60 ? minutes : Math.round(minutes / 60), Math.abs(minutes) < 60 ? "minute" : "hour");
}

  if (!healthStatus || healthStatus === 'unknown') return null;

  const cfg = CONFIG[healthStatus] ?? CONFIG.unknown;

  const timeAgo = healthCheckedAt
    ? formatTimeAgo(new Date(healthCheckedAt))
    : null;

  return (
    <span
      className={`relative inline-flex ${className}`}
      title={timeAgo ? translateInterface("m7a10fa0f811f", {status: cfg.tooltip, time: timeAgo}) : cfg.tooltip}
    >
      {cfg.pulse && (
        <span
          className={`absolute inline-flex h-full w-full rounded-full ${cfg.color} opacity-75 animate-ping`}
        />
      )}
      <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${cfg.color}`} />
    </span>
  );
}

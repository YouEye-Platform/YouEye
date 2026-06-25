'use client';

interface HealthDotProps {
  healthStatus?: 'healthy' | 'unhealthy' | 'unknown';
  healthCheckedAt?: string | null;
  className?: string;
}

const CONFIG: Record<string, { color: string; pulse: boolean; tooltip: string }> = {
  healthy: { color: 'bg-green-500', pulse: false, tooltip: 'Healthy' },
  unhealthy: { color: 'bg-red-500', pulse: true, tooltip: 'Unhealthy — app not responding' },
  unknown: { color: 'bg-gray-300', pulse: false, tooltip: 'Health unknown' },
};

export function HealthDot({ healthStatus, healthCheckedAt, className = '' }: HealthDotProps) {
  if (!healthStatus || healthStatus === 'unknown') return null;

  const cfg = CONFIG[healthStatus] ?? CONFIG.unknown;

  const timeAgo = healthCheckedAt
    ? formatTimeAgo(new Date(healthCheckedAt))
    : null;

  return (
    <span
      className={`relative inline-flex ${className}`}
      title={`${cfg.tooltip}${timeAgo ? ` — checked ${timeAgo}` : ''}`}
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

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

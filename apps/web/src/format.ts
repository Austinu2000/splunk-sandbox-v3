import type { HealthState } from '@sandbox/shared';

export const HEALTH_COLORS: Record<HealthState, string> = {
  healthy: '#53a051',
  stale_phonehome: '#f8be34',
  blocked_queue: '#f1813f',
  offline: '#dc4e41',
  version_drift: '#1e93c6',
  wrong_serverclass: '#a870ef',
};

const nf = new Intl.NumberFormat('en-US');
export const fmtInt = (n: number) => nf.format(n);

export function fmtPct(part: number, whole: number): string {
  if (whole === 0) return '0%';
  const p = (part / whole) * 100;
  return `${p < 1 && p > 0 ? p.toFixed(2) : p.toFixed(1)}%`;
}

/** Sim time is shown in UTC so it matches the sim's own timestamps everywhere. */
export function fmtClock(ms: number): string {
  const d = new Date(ms);
  return d.toUTCString().replace(' GMT', ' UTC').replace(/^\w+, /, '');
}

export function fmtAgo(then: number, now: number): string {
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

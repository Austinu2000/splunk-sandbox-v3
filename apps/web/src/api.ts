import type { ClockSpeed, FleetFilter, FleetSummary, HostPage, HostSortKey, WorldInfo } from '@sandbox/shared';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body as T;
}

function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

export const api = {
  world: () => request<WorldInfo>('/api/world'),
  setClock: (patch: { paused?: boolean; speed?: ClockSpeed }) =>
    request<WorldInfo>('/api/world/clock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  summary: (filter: FleetFilter) => request<FleetSummary>(`/api/fleet/summary${query({ ...filter })}`),
  hosts: (
    filter: FleetFilter,
    page: { offset: number; limit: number; sort: HostSortKey; dir: 'asc' | 'desc' },
  ) => request<HostPage>(`/api/fleet/hosts${query({ ...filter, ...page })}`),
};

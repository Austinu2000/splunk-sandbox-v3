import type {
  ClockSpeed,
  ScenarioDto,
  TicketDto,
  FleetFilter,
  FleetSummary,
  HostPage,
  HostSortKey,
  PageDto,
  ResultValue,
  SearchEventDto,
  SearchJobDto,
  SearchRequestDto,
  WorldInfo,
} from '@sandbox/shared';

export interface RosterEntry {
  hostname: string;
  role: string;
  site: string;
  detailed: boolean;
}

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
  scenarios: () => request<ScenarioDto[]>('/api/scenarios'),
  tickets: () => request<TicketDto[]>('/api/tickets'),
  startScenario: (id: string) =>
    request<TicketDto>(`/api/scenarios/${encodeURIComponent(id)}/start`, { method: 'POST' }),
  closeTicket: (id: string, note: string) =>
    request<TicketDto>(`/api/tickets/${encodeURIComponent(id)}/close`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note }),
    }),
  world: () => request<WorldInfo>('/api/world'),
  search: (req: SearchRequestDto) =>
    request<{
      job: SearchJobDto;
      events: PageDto<SearchEventDto>;
      results: PageDto<Record<string, ResultValue>>;
    }>('/api/search/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    }),
  searchEvents: (sid: string, offset: number, count: number) =>
    request<PageDto<SearchEventDto>>(
      `/api/search/jobs/${encodeURIComponent(sid)}/events${query({ offset, count })}`,
    ),
  searchResults: (sid: string, offset: number, count: number) =>
    request<PageDto<Record<string, ResultValue>>>(
      `/api/search/jobs/${encodeURIComponent(sid)}/results${query({ offset, count })}`,
    ),
  roster: () => request<RosterEntry[]>('/api/hosts/roster'),
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

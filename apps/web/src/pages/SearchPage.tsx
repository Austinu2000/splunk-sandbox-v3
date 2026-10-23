import { useCallback, useEffect, useRef, useState } from 'react';
import type { PageDto, ResultValue, SearchEventDto, SearchJobDto } from '@sandbox/shared';
import { api } from '../api';
import {
  EventsList,
  FieldsSidebar,
  Pager,
  StatsTable,
  Timeline,
  Visualization,
} from '../components/SearchResults';
import { fmtEventTime, fmtInt } from '../format';
import { searchHash } from '../links';

const PRESETS = [
  { label: 'Last 15 minutes', earliest: '-15m', latest: 'now' },
  { label: 'Last 60 minutes', earliest: '-60m', latest: 'now' },
  { label: 'Last 4 hours', earliest: '-4h', latest: 'now' },
  { label: 'Last 24 hours', earliest: '-24h', latest: 'now' },
  { label: 'Today', earliest: '@d', latest: 'now' },
  { label: 'All time (24 h retained)', earliest: '0', latest: 'now' },
];

const EXAMPLES = [
  'index=_internal source=*metrics.log group=queue blocked=true | stats dc(host) as blocked_forwarders by name',
  'index=_internal sourcetype=splunkd log_level=WARN | stats count by component | sort - count',
  '| metadata type=hosts index=_internal | eval minutes_silent=round((now()-lastTime)/60) | where minutes_silent > 5 | sort - minutes_silent',
  'index=app sourcetype=access_combined | timechart count by status',
  '| inputlookup forwarder_inventory | stats count by site, health',
  '| rest /services/server/info | table splunk_server version server_roles',
];

type Tab = 'events' | 'statistics' | 'visualization';
const EVENTS_PAGE = 20;
const RESULTS_PAGE = 50;

/** Reads #/search?q=...&earliest=...&latest=... */
export function searchFromHash(): { q: string; earliest: string; latest: string } | null {
  const m = /^#\/search\??(.*)$/.exec(window.location.hash);
  if (!m) return null;
  const p = new URLSearchParams(m[1]);
  return { q: p.get('q') ?? '', earliest: p.get('earliest') ?? '-15m', latest: p.get('latest') ?? 'now' };
}

function quoteValue(v: string): string {
  return /^[\w.:/-]+$/.test(v) ? v : `"${v.replace(/"/g, '\\"')}"`;
}

function JobInspector({ job, onClose }: { job: SearchJobDto; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-label="Search job inspector"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>Search job inspector</h2>
          <button onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <p>
          This search has {job.status === 'done' ? 'completed' : 'failed'} and has returned{' '}
          <strong>{fmtInt(job.kind === 'events' ? job.eventCount : job.resultCount)}</strong>{' '}
          {job.kind === 'events' ? 'events' : 'results'} by scanning <strong>{fmtInt(job.scanCount)}</strong>{' '}
          events on <strong>{fmtInt(job.hostsScanned)}</strong> hosts in{' '}
          <strong>{(job.runMs / 1000).toFixed(3)}</strong> seconds.
        </p>
        {job.truncated && (
          <p className="warn-text">
            The scan stopped early at the sandbox's limit, so results may be incomplete.
          </p>
        )}
        <h3>Execution costs</h3>
        <table className="results">
          <thead>
            <tr>
              <th>Phase</th>
              <th className="num">Duration (s)</th>
              <th className="num">Output rows</th>
            </tr>
          </thead>
          <tbody>
            {job.phases.map((p, i) => (
              <tr key={i}>
                <td className="mono">{p.name}</td>
                <td className="num">{(p.ms / 1000).toFixed(3)}</td>
                <td className="num">{fmtInt(p.rows)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h3>Search job properties</h3>
        <table className="results props">
          <tbody>
            {(
              [
                ['sid', job.sid],
                ['search', job.search],
                ['earliestTime', new Date(job.earliest).toISOString()],
                ['latestTime', new Date(job.latest).toISOString()],
                ['eventCount', fmtInt(job.eventCount)],
                ['resultCount', fmtInt(job.resultCount)],
                ['scanCount', fmtInt(job.scanCount)],
                ['isTransforming', String(job.kind === 'statistics')],
                ['runDuration', `${(job.runMs / 1000).toFixed(3)}s`],
              ] as [string, string][]
            ).map(([k, v]) => (
              <tr key={k}>
                <td className="mono">{k}</td>
                <td className="mono wrap">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function SearchPage({ visible }: { visible: boolean }) {
  const initial = searchFromHash();
  const [query, setQuery] = useState(initial?.q ?? '');
  const [range, setRange] = useState(
    () => PRESETS.find((p) => p.earliest === initial?.earliest) ?? PRESETS[0]!,
  );
  const [job, setJob] = useState<SearchJobDto | null>(null);
  const [events, setEvents] = useState<PageDto<SearchEventDto> | null>(null);
  const [results, setResults] = useState<PageDto<Record<string, ResultValue>> | null>(null);
  const [allResults, setAllResults] = useState<Record<string, ResultValue>[] | null>(null);
  const [tab, setTab] = useState<Tab>('events');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inspect, setInspect] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const lastHashRun = useRef<string | null>(null);

  const run = useCallback(
    async (q: string, r = range) => {
      if (!q.trim()) return;
      setRunning(true);
      setError(null);
      const hash = searchHash(q, r.earliest, r.latest);
      lastHashRun.current = hash;
      if (window.location.hash !== hash) window.history.replaceState(null, '', hash);
      try {
        const res = await api.search({ search: q, earliest: r.earliest, latest: r.latest });
        setJob(res.job);
        setEvents(res.events);
        setResults(res.results);
        setAllResults(null);
        setTab(res.job.kind === 'events' ? 'events' : 'statistics');
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setRunning(false);
      }
    },
    [range],
  );

  // Run the search in the URL when the page opens (or another page links here).
  useEffect(() => {
    if (!visible) return;
    const h = searchFromHash();
    if (h?.q && window.location.hash !== lastHashRun.current) {
      setQuery(h.q);
      const r = PRESETS.find((p) => p.earliest === h.earliest) ?? PRESETS[0]!;
      setRange(r);
      void run(h.q, r);
    }
    input.current?.focus();
  }, [visible, run]);

  // The visualization works on the full result set (up to 500 rows).
  useEffect(() => {
    if (tab !== 'visualization' || !job || allResults) return;
    api.searchResults(job.sid, 0, 500).then(
      (p) => setAllResults(p.items),
      () => setAllResults([]),
    );
  }, [tab, job, allResults]);

  const addTerm = (field: string, value: string) => {
    const pipe = query.indexOf('|');
    const term = `${field}=${quoteValue(value)}`;
    const next =
      pipe >= 0
        ? `${query.slice(0, pipe).trimEnd()} ${term} ${query.slice(pipe)}`
        : `${query.trimEnd()} ${term}`;
    setQuery(next);
    void run(next);
  };

  const errors = job?.messages.filter((m) => m.type === 'error') ?? [];
  const notes = job?.messages.filter((m) => m.type !== 'error') ?? [];
  const [eDate, eTime] = job ? fmtEventTime(job.earliest / 1000) : ['', ''];
  const [lDate, lTime] = job ? fmtEventTime(job.latest / 1000) : ['', ''];

  return (
    <main className="search-page" style={{ display: visible ? undefined : 'none' }}>
      <h1 className="page-title">New Search</h1>
      <form
        className="search-bar"
        onSubmit={(e) => {
          e.preventDefault();
          void run(query);
        }}
      >
        <textarea
          ref={input}
          className="search-input mono"
          value={query}
          placeholder="enter search here..."
          rows={Math.min(6, Math.max(1, query.split('\n').length))}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void run(query);
            }
          }}
          aria-label="Search"
        />
        <select
          className="time-picker"
          value={range.label}
          onChange={(e) => {
            const r = PRESETS.find((p) => p.label === e.target.value)!;
            setRange(r);
            if (query.trim()) void run(query, r);
          }}
          aria-label="Time range"
        >
          {PRESETS.map((p) => (
            <option key={p.label}>{p.label}</option>
          ))}
        </select>
        <button className="search-go" type="submit" disabled={running} aria-label="Run search">
          {running ? '…' : '⌕'}
        </button>
      </form>

      {!job && !running && !error && (
        <section className="panel examples">
          <h2>Try a search</h2>
          <p className="side-hint">
            Everything here is generated from the same simulated world as the Fleet Overview and the terminal.
            Time is sim time (UTC).
          </p>
          <ul>
            {EXAMPLES.map((q) => (
              <li key={q}>
                <button
                  className="link-btn mono"
                  onClick={() => {
                    setQuery(q);
                    void run(q);
                  }}
                >
                  {q}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {error && <div className="error">Search failed: {error}</div>}
      {running && <div className="job-status">Searching…</div>}

      {job && !running && (
        <>
          <div className="job-status">
            <span className={job.status === 'done' ? 'ok' : 'bad'}>{job.status === 'done' ? '✓' : '✕'}</span>{' '}
            {job.kind === 'events'
              ? `${fmtInt(job.eventCount)} events`
              : `${fmtInt(job.eventCount)} events → ${fmtInt(job.resultCount)} results`}{' '}
            ({eDate} {eTime} to {lDate} {lTime})
            <button className="link-btn job-btn" onClick={() => setInspect(true)}>
              Job ▾ Inspect
            </button>
          </div>
          {errors.map((m, i) => (
            <div key={i} className="error">
              {m.text}
            </div>
          ))}
          {notes.map((m, i) => (
            <div key={i} className={m.type === 'warn' ? 'notice warn' : 'notice'}>
              {m.text}
            </div>
          ))}

          {errors.length === 0 && (
            <>
              <div className="tabs" role="tablist">
                <button
                  role="tab"
                  aria-selected={tab === 'events'}
                  className={tab === 'events' ? 'active' : ''}
                  onClick={() => setTab('events')}
                >
                  Events ({fmtInt(job.eventCount)})
                </button>
                <button
                  role="tab"
                  aria-selected={tab === 'statistics'}
                  className={tab === 'statistics' ? 'active' : ''}
                  onClick={() => setTab('statistics')}
                >
                  Statistics ({fmtInt(job.kind === 'statistics' ? job.resultCount : 0)})
                </button>
                <button
                  role="tab"
                  aria-selected={tab === 'visualization'}
                  className={tab === 'visualization' ? 'active' : ''}
                  onClick={() => setTab('visualization')}
                >
                  Visualization
                </button>
              </div>

              {tab === 'events' &&
                (job.kind === 'events' && events ? (
                  <div className="events-layout">
                    <FieldsSidebar job={job} onAdd={addTerm} />
                    <div className="events-main">
                      {job.timeline.length > 0 && <Timeline job={job} />}
                      <div className="table-meta">
                        <span>
                          {fmtInt(events.total)} events
                          {events.total < job.eventCount ? ` (first ${fmtInt(events.total)} kept)` : ''}
                        </span>
                        <Pager
                          page={events}
                          size={EVENTS_PAGE}
                          onPage={(o) => job && api.searchEvents(job.sid, o, EVENTS_PAGE).then(setEvents)}
                        />
                      </div>
                      {events.total === 0 ? (
                        <div className="empty-state">
                          No results found. Try a wider time range or fewer terms.
                        </div>
                      ) : (
                        <EventsList page={events} onAddTerm={addTerm} />
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="empty-state">
                    This search uses transforming commands, so events are not shown.{' '}
                    {job.eventCount ? `It matched ${fmtInt(job.eventCount)} events.` : ''} See the Statistics
                    tab.
                  </div>
                ))}

              {tab === 'statistics' &&
                (job.kind === 'statistics' && results ? (
                  <div className="panel flat">
                    <div className="table-meta">
                      <span>{fmtInt(results.total)} results</span>
                      <Pager
                        page={results}
                        size={RESULTS_PAGE}
                        onPage={(o) => job && api.searchResults(job.sid, o, RESULTS_PAGE).then(setResults)}
                      />
                    </div>
                    {results.total === 0 ? (
                      <div className="empty-state">No results found.</div>
                    ) : (
                      <StatsTable columns={job.columns} page={results} />
                    )}
                  </div>
                ) : (
                  <div className="empty-state">
                    Your search isn&apos;t generating statistics. Add a transforming command such as{' '}
                    <code>| stats count by host</code> or <code>| table _time host source</code>.
                  </div>
                ))}

              {tab === 'visualization' &&
                (job.kind === 'statistics' ? (
                  <div className="panel flat">
                    {allResults ? <Visualization columns={job.columns} rows={allResults} /> : 'Loading…'}
                  </div>
                ) : (
                  <div className="empty-state">
                    Visualizations need a transforming search, e.g. <code>| timechart count</code>.
                  </div>
                ))}
            </>
          )}
          {inspect && <JobInspector job={job} onClose={() => setInspect(false)} />}
        </>
      )}
    </main>
  );
}

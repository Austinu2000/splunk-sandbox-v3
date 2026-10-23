import { TicketsPage } from './pages/TicketsPage';
import { useEffect, useState } from 'react';
import { api } from './api';
import { TopBar, type Route } from './components/TopBar';
import { FleetOverview } from './pages/FleetOverview';
import { SearchPage } from './pages/SearchPage';
import { TerminalPage } from './pages/TerminalPage';
import { usePoll } from './usePoll';
import { MonitoringConsole, MC_TABS } from './pages/MonitoringConsole';
import { ForwarderManagement, DS_TABS, type DsTab } from './pages/ForwarderManagement';
import type { McView } from '@sandbox/shared';
import { InterviewPage } from './pages/InterviewPage';
import { SessionsPage } from './pages/SessionsPage';
import { InterviewBar } from './components/InterviewBar';

/** The page id recorded in the action log: the route plus its sub-view, without query strings. */
function pageId(hash: string): string {
  const parts = hash.replace(/^#\/?/, '').split('?')[0]!.split('/').filter(Boolean);
  return (parts.slice(0, 2).join('/') || 'fleet').toLowerCase().replace(/[^a-z0-9/-]/g, '');
}

/** The sub-view in #/route/<sub>, if it is one of `allowed`. */
function subRoute<T extends string>(allowed: readonly T[], fallback: T): T {
  const sub = window.location.hash.split('/')[2] as T | undefined;
  return sub && allowed.includes(sub) ? sub : fallback;
}

function routeFromHash(): Route {
  const h = window.location.hash;
  if (h === '#/tickets') return 'tickets';
  if (h.startsWith('#/monitoring')) return 'monitoring';
  if (h.startsWith('#/forwarders')) return 'forwarders';
  if (h.startsWith('#/interview')) return 'interview';
  if (h.startsWith('#/sessions')) return 'sessions';
  if (h === '#/terminal') return 'terminal';
  if (h.startsWith('#/search')) return 'search';
  return 'fleet';
}

export function App() {
  const world = usePoll(() => api.world(), [], 2000);
  const current = usePoll(() => api.currentInterview(), [], 2000);
  const [route, setRoute] = useState<Route>(routeFromHash);
  const [hash, setHash] = useState(window.location.hash);
  // The terminal mounts on first visit and then stays mounted, so its session survives navigation.
  const [terminalOpened, setTerminalOpened] = useState(route === 'terminal');
  const [searchOpened, setSearchOpened] = useState(route === 'search');

  useEffect(() => {
    const onHash = () => {
      setRoute(routeFromHash());
      setHash(window.location.hash);
      void api.logPage(pageId(window.location.hash)).catch(() => undefined);
    };
    void api.logPage(pageId(window.location.hash)).catch(() => undefined);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    if (route === 'terminal') setTerminalOpened(true);
    if (route === 'search') setSearchOpened(true);
  }, [route]);

  return (
    <>
      <TopBar
        world={world.data}
        route={route}
        onClock={async (patch) => {
          await api.setClock(patch);
          await world.refresh();
        }}
      />
      {current.data?.interview && (
        <InterviewBar interview={current.data.interview} onInterviewPage={route === 'interview'} />
      )}
      {world.error && !world.data && (
        <div className="error page-error">
          Cannot reach the sandbox server ({world.error}). Is <code>npm run dev</code> running?
        </div>
      )}
      {world.data && route === 'fleet' && <FleetOverview world={world.data} />}
      {world.data && route === 'tickets' && <TicketsPage world={world.data} />}
      {world.data && route === 'monitoring' && (
        <MonitoringConsole
          key={hash}
          view={subRoute<McView>(
            MC_TABS.map((t) => t.view),
            'indexing',
          )}
        />
      )}
      {world.data && route === 'sessions' && (
        <SessionsPage
          world={world.data}
          onWorldChanged={() => {
            void world.refresh();
            void current.refresh();
          }}
        />
      )}
      {world.data && route === 'interview' && (
        <InterviewPage
          view={window.location.hash.split('/')[2]}
          current={current.data?.interview ?? null}
          onChange={() => void current.refresh()}
        />
      )}
      {world.data && route === 'forwarders' && (
        <ForwarderManagement
          tab={subRoute<DsTab>(
            DS_TABS.map((t) => t.tab),
            'clients',
          )}
          now={world.data.now}
        />
      )}
      {terminalOpened && <TerminalPage visible={route === 'terminal'} />}
      {searchOpened && <SearchPage visible={route === 'search'} />}
    </>
  );
}

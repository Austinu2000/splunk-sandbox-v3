import { useEffect, useState } from 'react';
import { api } from './api';
import { TopBar, type Route } from './components/TopBar';
import { FleetOverview } from './pages/FleetOverview';
import { SearchPage } from './pages/SearchPage';
import { TerminalPage } from './pages/TerminalPage';
import { usePoll } from './usePoll';

function routeFromHash(): Route {
  const h = window.location.hash;
  if (h === '#/terminal') return 'terminal';
  if (h.startsWith('#/search')) return 'search';
  return 'fleet';
}

export function App() {
  const world = usePoll(() => api.world(), [], 2000);
  const [route, setRoute] = useState<Route>(routeFromHash);
  // The terminal mounts on first visit and then stays mounted, so its session survives navigation.
  const [terminalOpened, setTerminalOpened] = useState(route === 'terminal');
  const [searchOpened, setSearchOpened] = useState(route === 'search');

  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
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
      {world.error && !world.data && (
        <div className="error page-error">
          Cannot reach the sandbox server ({world.error}). Is <code>npm run dev</code> running?
        </div>
      )}
      {world.data && route === 'fleet' && <FleetOverview world={world.data} />}
      {terminalOpened && <TerminalPage visible={route === 'terminal'} />}
      {searchOpened && <SearchPage visible={route === 'search'} />}
    </>
  );
}

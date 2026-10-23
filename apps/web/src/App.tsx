import { api } from './api';
import { TopBar } from './components/TopBar';
import { FleetOverview } from './pages/FleetOverview';
import { usePoll } from './usePoll';

export function App() {
  const world = usePoll(() => api.world(), [], 2000);

  return (
    <>
      <TopBar
        world={world.data}
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
      {world.data && <FleetOverview world={world.data} />}
    </>
  );
}

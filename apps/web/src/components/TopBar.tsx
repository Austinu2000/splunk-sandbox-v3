import { CLOCK_SPEEDS, type ClockSpeed, type WorldInfo } from '@sandbox/shared';
import { fmtClock } from '../format';

export type Route = 'fleet' | 'terminal' | 'search' | 'tickets';

const NAV: { label: string; route?: Route; milestone?: number }[] = [
  { label: 'Fleet Overview', route: 'fleet' },
  { label: 'Terminal', route: 'terminal' },
  { label: 'Search & Reporting', route: 'search' },
  { label: 'Incidents & Tickets', route: 'tickets' },
  { label: 'Monitoring Console', milestone: 6 },
  { label: 'Forwarder Management', milestone: 6 },
  { label: 'Settings', milestone: 6 },
];

export function TopBar({
  world,
  route,
  onClock,
}: {
  world: WorldInfo | null;
  route: Route;
  onClock: (patch: { paused?: boolean; speed?: ClockSpeed }) => void;
}) {
  return (
    <header>
      <div className="systembar">
        <div className="brand">
          <span className="brand-mark">&gt;</span> Sandbox Web
        </div>
        <div className="systembar-right">
          {world && (
            <>
              <span className="sim-clock" title={`Tick ${world.tick} · ${world.tickMs / 1000}s per tick`}>
                {fmtClock(world.now)}
              </span>
              <button
                className="sys-btn"
                onClick={() => onClock({ paused: !world.paused })}
                title={world.paused ? 'Resume simulation' : 'Pause simulation'}
              >
                {world.paused ? '▶ Resume' : '❚❚ Pause'}
              </button>
              <div className="speed" role="group" aria-label="Simulation speed">
                {CLOCK_SPEEDS.map((s) => (
                  <button
                    key={s}
                    className={world.speed === s ? 'active' : ''}
                    onClick={() => onClock({ speed: s })}
                  >
                    {s}×
                  </button>
                ))}
              </div>
              <span className="seed" title="World seed">
                seed: {world.seed}
              </span>
            </>
          )}
        </div>
      </div>
      <nav className="appbar">
        {NAV.map((item) =>
          item.route ? (
            <a
              key={item.label}
              href={`#/${item.route}`}
              className={`nav-item ${route === item.route ? 'active' : ''}`}
            >
              {item.label}
            </a>
          ) : (
            <span
              key={item.label}
              className="nav-item disabled"
              title={`Coming in milestone ${item.milestone}`}
            >
              {item.label}
            </span>
          ),
        )}
      </nav>
    </header>
  );
}

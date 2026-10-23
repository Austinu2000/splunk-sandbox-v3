import { CLOCK_SPEEDS, type ClockSpeed, type WorldInfo } from '@sandbox/shared';
import { fmtClock } from '../format';

const NAV: { label: string; milestone?: number }[] = [
  { label: 'Fleet Overview' },
  { label: 'Search & Reporting', milestone: 4 },
  { label: 'Monitoring Console', milestone: 6 },
  { label: 'Forwarder Management', milestone: 6 },
  { label: 'Settings', milestone: 6 },
  { label: 'Terminal', milestone: 2 },
];

export function TopBar({
  world,
  onClock,
}: {
  world: WorldInfo | null;
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
        {NAV.map((item) => (
          <span
            key={item.label}
            className={item.milestone ? 'nav-item disabled' : 'nav-item active'}
            title={item.milestone ? `Coming in milestone ${item.milestone}` : undefined}
          >
            {item.label}
          </span>
        ))}
      </nav>
    </header>
  );
}

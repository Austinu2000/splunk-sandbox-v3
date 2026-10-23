# Splunk Engineer Sandbox

A browser-based, fully simulated Splunk environment for practising engineer work and interview scenarios. It looks like a 35,000-forwarder enterprise, but nothing is real: no Splunk binaries, no real shell, no networking beyond localhost.

- `SPEC.md`: what we're building
- `PLAN.md`: architecture, data models, risks
- `CLAUDE.md`: rules every change must follow

**Status:** milestone 1 of 8 (seeded fleet generator and Fleet Overview).

## Requirements

Node 20.19 or newer. Node 22 LTS is recommended (`.nvmrc`).

## Run it

```bash
npm install
npm run dev
```

Then open <http://127.0.0.1:5173>. The API server listens on `127.0.0.1:5174`, and Vite proxies `/api` to it. Both bind to loopback only.

| Env var | Default | Meaning |
|---|---|---|
| `SANDBOX_SEED` | `sandbox` | World seed. The same seed always gives the same world. |
| `SANDBOX_FLEET_SIZE` | `35000` | Number of simulated forwarders |
| `SANDBOX_PORT` | `5174` | API port |

## Other commands

```bash
npm test            # Vitest, all packages
npm run typecheck   # tsc in every workspace
npm run lint        # ESLint (also blocks child_process, eval, Math.random/Date.now in sim code)
```

## Layout

```
packages/shared   types shared by server and web
packages/sim      the simulated world: seeded RNG, fleet tables, health evolution, queries
apps/server       Fastify API, ticks the world in wall-clock time
apps/web          React + Vite UI (Fleet Overview)
scenarios/        incident files (milestone 5+)
```

## How the fleet works (milestone 1)

- The fleet is a set of typed-array columns (site, server class, version, health and so on), not 35,000 objects. Hostnames, IPs, output groups, phone-home times, queue fill and throughput are computed from the row and the seed when they're read.
- Every tick (10 s of sim time), a small random slice of forwarders fails or recovers. The long-run unhealthy rate is about 1.5 %, so the fleet is never perfectly clean.
- Counts by site, server class and health are updated on every transition. Tests check they always equal a full scan, and that every dashboard number equals the matching host-list total.
- A ring buffer keeps 24 h of health transitions, so later milestones can answer "what state was this host in at time T" (for example, gaps in a blocked forwarder's events).
- The clock control in the top bar pauses the sim or runs it at 1×, 5× or 30×. Speed only changes pacing: tick N is identical at any speed.

## API (milestone 1)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/world` | seed, clock, sites, server classes, infra nodes |
| POST | `/api/world/clock` | `{ "paused"?: boolean, "speed"?: 1 \| 5 \| 30 }` |
| GET | `/api/fleet/summary` | counts by health, site and class; filters: `site`, `serverClass`, `health`, `os`, `q` |
| GET | `/api/fleet/hosts` | same filters plus `offset`, `limit` (≤500), `sort` (`hostname`\|`lastPhoneHome`\|`health`\|`site`), `dir` |

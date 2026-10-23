# Splunk Engineer Sandbox

A browser-based, fully simulated Splunk environment for practising engineer work and interview scenarios. It looks like a 35,000-forwarder enterprise, but nothing is real: no Splunk binaries, no real shell, no networking beyond localhost.

- `SPEC.md`: what we're building
- `PLAN.md`: architecture, data models, risks
- `CLAUDE.md`: rules every change must follow

**Status:** milestone 2 of 8: Fleet Overview, plus a simulated SSH terminal with a shell emulator and virtual filesystem.

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
packages/sim      the simulated world: seeded RNG, fleet tables, health evolution, queries,
                  host profiles, log generators, virtual filesystem, shell emulator
apps/server       Fastify API, ticks the world in wall-clock time
apps/web          React + Vite UI (Fleet Overview, Terminal)
scenarios/        incident files (milestone 5+)
```

## How the fleet works (milestone 1)

- The fleet is a set of typed-array columns (site, server class, version, health and so on), not 35,000 objects. Hostnames, IPs, output groups, phone-home times, queue fill and throughput are computed from the row and the seed when they're read.
- Every tick (10 s of sim time), a small random slice of forwarders fails or recovers. The long-run unhealthy rate is about 1.5 %, so the fleet is never perfectly clean.
- Counts by site, server class and health are updated on every transition. Tests check they always equal a full scan, and that every dashboard number equals the matching host-list total.
- A ring buffer keeps 24 h of health transitions, so later milestones can answer "what state was this host in at time T" (for example, gaps in a blocked forwarder's events).
- The clock control in the top bar pauses the sim or runs it at 1×, 5× or 30×. Speed only changes pacing: tick N is identical at any speed.

## Terminal (milestone 2)

Open **Terminal** in the top bar. You start on `bastion01` as `engineer`; `cat README.txt` lists the hosts.

```
ssh splunk@ds01            # deployment server (detailed)
ssh splunk@idx01           # indexer (detailed)
ssh splunk@dal-app-0001    # Linux universal forwarder (detailed)
ssh splunk@ash-web-0012    # any other Linux forwarder or infra node: same layout, thinner
```

The terminal is an emulator in `packages/sim/src/shell`. Every command is parsed and answered from the simulated world. Nothing runs on your machine, and lint plus a test check that no source can spawn processes or evaluate code.

**Login:** only the bastion has keys, and only the `splunk` account accepts them. Root SSH is refused, Windows forwarders refuse port 22, and unknown names fail DNS. `splunk` has passwordless sudo (`sudo -i`, `sudo cmd`). The bastion user does not have sudo.

**Shell:** quotes, `$VAR` (expanded per command, so `$?` works), `~`, globs, `|`, `;`, `&&`, `||`, `>`, `>>`, `<`, `2>`, `2>&1`, aliases, history (↑/↓), tab completion, and Ctrl-C/D/L/U/W/A/E. Command substitution and background jobs are rejected with a bash-style message.

**Commands:** `pwd cd ls cat head tail (-f) less more grep egrep find wc sort uniq cut awk tee echo touch mkdir rm cp mv chmod chown stat vi vim nano ps top df free uptime systemctl ss netstat ping nc ip uname hostname whoami id date env which history export alias type source clear sudo su ssh exit`, plus `splunk status|version|help`.

**Filesystem:** each host's tree is generated from the seed and hostname (`/etc`, `/home/splunk`, `/var/log`, and `/opt/splunk` or `/opt/splunkforwarder` with `etc/system/{default,local}`, apps, `deployment-apps` on the DS, `peer-apps` on indexers, and `var/log/splunk`). Your edits are stored as an overlay in the world, so they survive logging out and back in. Permissions apply: for example, `splunk` can't write `/etc/hosts` or read `/etc/shadow`.

**Logs are live and consistent with the fleet.** `splunkd.log`, `metrics.log`, `/var/log/messages`, `/var/log/secure` and the app logs are generated for any time range from the same state the dashboards use:
- a blocked forwarder logs `TcpOutputProc ... blocked_seconds=` and `blocked=true` queues;
- an offline forwarder logs a shutdown, then nothing, and `splunk status`, `systemctl`, `ps` and `ss` all agree it is down;
- a wrong-server-class forwarder logs installing the other class's app, which then appears under `etc/apps`.

`tail -f` prints new lines on every simulation tick. Try it at 30×.

**Not yet:** the config layer (`btool`, effective config, restart/reload effects) is milestone 3. Until then `splunk btool|restart|reload|list ...` reply that they are not simulated yet, and `systemctl restart` as root succeeds without changing state. A PowerShell-style shell for Windows forwarders is deferred to when Windows hosts join the detailed roster.

## API

### Fleet (milestone 1)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/world` | seed, clock, sites, server classes, infra nodes |
| POST | `/api/world/clock` | `{ "paused"?: boolean, "speed"?: 1 \| 5 \| 30 }` |
| GET | `/api/fleet/summary` | counts by health, site and class; filters: `site`, `serverClass`, `health`, `os`, `q` |
| GET | `/api/fleet/hosts` | same filters plus `offset`, `limit` (≤500), `sort` (`hostname`\|`lastPhoneHome`\|`health`\|`site`), `dir` |

### Terminal (milestone 2)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/hosts/roster` | SSH-able infrastructure hosts and the detailed forwarder |
| WS | `/ws/term?cols=&rows=` | client sends `{type:"input",data}` / `{type:"resize",cols,rows}`; server sends `{type:"output",data}` and `{type:"location",host,user}`. Only local origins are accepted, with at most 8 sessions. |

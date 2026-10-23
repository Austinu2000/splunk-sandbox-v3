# Splunk Engineer Sandbox

A browser-based, fully simulated Splunk environment for practising engineer work and interview scenarios. It looks like a 35,000-forwarder enterprise, but nothing is real: no Splunk binaries, no real shell, no networking beyond localhost.

- `SPEC.md`: what we're building
- `PLAN.md`: architecture, data models, risks
- `CLAUDE.md`: rules every change must follow

**Status:** milestone 3 of 8: Fleet Overview, a simulated SSH terminal, and a config layer where edits take effect only after the right restart or reload.

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
                  host profiles, log generators, virtual filesystem, shell emulator,
                  .conf parser/btool, running config, config → fleet derivation
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

**Commands:** `pwd cd ls cat head tail (-f) less more grep egrep find wc sort uniq cut awk tee echo touch mkdir rm cp mv chmod chown stat vi vim nano ps top df free uptime systemctl ss netstat ping nc ip uname hostname whoami id date env which history export alias type source clear sudo su ssh exit`, plus the `splunk` CLI (see below).

**Filesystem:** each host's tree is generated from the seed and hostname (`/etc`, `/home/splunk`, `/var/log`, and `/opt/splunk` or `/opt/splunkforwarder` with `etc/system/{default,local}`, apps, `deployment-apps` on the DS, `peer-apps` on indexers, and `var/log/splunk`). Your edits are stored as an overlay in the world, so they survive logging out and back in. Permissions apply: for example, `splunk` can't write `/etc/hosts` or read `/etc/shadow`.

**Logs are live and consistent with the fleet.** `splunkd.log`, `metrics.log`, `/var/log/messages`, `/var/log/secure` and the app logs are generated for any time range from the same state the dashboards use:
- a blocked forwarder logs `TcpOutputProc ... blocked_seconds=` and `blocked=true` queues;
- an offline forwarder logs a shutdown, then nothing, and `splunk status`, `systemctl`, `ps` and `ss` all agree it is down;
- a wrong-server-class forwarder logs installing the other class's app, which then appears under `etc/apps`.

`tail -f` prints new lines on every simulation tick. Try it at 30×.

A PowerShell-style shell for Windows forwarders is deferred to when Windows hosts join the detailed roster.

## Config layer (milestone 3)

**Files on disk vs. running config.** Saving a `.conf` file changes the disk immediately, and `btool` sees it straight away, as in real Splunk. What splunkd *runs* is a snapshot taken when it last started. Only these change the running config:

| Action | Re-reads |
|---|---|
| `splunk restart` / `splunk start`, `sudo systemctl restart Splunkd` / `SplunkForwarder` | everything on that host |
| `splunk reload deploy-server` (on `ds01`) | `serverclass.conf` and `etc/deployment-apps` |

**Precedence (global context):** `peer-apps/*/local` (indexers) → `system/local` → `apps/*/local` (ASCII order, so `A` beats `a`) → `peer-apps/*/default` → `apps/*/default` → `system/default`. Every stanza inherits `[default]` settings it doesn't set itself.

**`splunk` CLI:**

| Command | Reads |
|---|---|
| `splunk btool <conf> list [stanza] [--debug] [--app=X]` | disk; `--debug` prefixes each line with its source file |
| `splunk btool check` | disk; flags unknown keys (typos) for inputs, outputs, props, server, serverclass, deploymentclient |
| `splunk start / stop / restart / status / version` | `restart` also runs the conf check and prints any invalid keys |
| `splunk list forward-server` | running outputs, split into active and inactive by real reachability |
| `splunk list monitor` | running `inputs.conf` monitor stanzas, expanded against the filesystem |
| `splunk show deploy-poll` | running `deploymentclient.conf` |
| `splunk reload deploy-server [-class X]` | deployment server only |

**Config drives the fleet** (`packages/sim/src/derive`). The 35,000 forwarders share the deployment server's config instead of each having their own:
- Each forwarder is matched against `ds01`'s running `serverclass.conf`. Patterns are case-insensitive; `.` is a literal dot and `*` is a wildcard. A forwarder whose class loses its inputs app shows as *wrong server class* with no assigned class, and its `etc/apps` loses the app.
- The deployed outputs app decides where each forwarder sends data. A forwarder is *blocked* when none of its servers resolves to a running indexer or heavy forwarder that listens on that port. Listening ports come from the receiver's running `inputs.conf` (`[splunktcp://9997]`).
- `splunk stop` on a forwarder makes it *offline* at once. On an indexer it removes that indexer as a target.
- Changes reach each forwarder at its next check-in, so a reload rolls across the fleet over about a minute of sim time. Rows held in a state by config are excluded from background churn.
- Logs follow the same state. Blocked forwarders log `Unable to resolve host=...` or `Cooked connection to ip=... timed out`. Restarts log shutdown and startup lines. `ds01` logs each reload with the client count per server class, which is the clue for a whitelist typo.

The Fleet Overview, the terminal and the logs all read this one state. For example, stop `idx01` and `idx02` at 30× and the Dallas forwarders turn blocked within a minute.

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

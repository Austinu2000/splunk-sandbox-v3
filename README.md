# Splunk Engineer Sandbox

A browser-based, fully simulated Splunk environment for practising engineer work and interview scenarios. It looks like a 35,000-forwarder enterprise, but nothing is real: no Splunk binaries, no real shell, no networking beyond localhost.

- `SPEC.md`: what we're building
- `PLAN.md`: architecture, data models, risks
- `CLAUDE.md`: rules every change must follow

**Status:** milestone 5 of 8: Fleet Overview, simulated SSH, running config, Search & Reporting, and a data-driven incident engine with tickets and three solution-tested incidents.

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
                  .conf parser/btool, running config, config → fleet derivation,
                  SPL parser/executor and the indexed-event view (src/spl)
apps/server       Fastify API, ticks the world in wall-clock time
apps/web          React + Vite UI (Fleet Overview, Terminal, Search & Reporting, Incidents & Tickets)
scenarios/        validated YAML incidents
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

## Search & Reporting (milestone 4)

Open **Search & Reporting**, or click any hostname in the Fleet Overview. The page has:
- a search bar and time-range presets (default: last 15 minutes of sim time);
- an events view with a timeline histogram, a fields sidebar (top values, click to add to the search) and expandable events;
- Statistics and Visualization tabs (line, column, bar, pie, single value);
- a job inspector showing scan count, run time and per-phase costs.

**Data.** Events are generated on demand by the same log generators the terminal reads, so `tail` on a host and a search for that host return the same lines. Indexes:

| Index | Contents |
|---|---|
| `_internal` | `splunkd.log`, `metrics.log` and `health.log` from every forwarder and infrastructure node (sourcetype `splunkd`, as in real Splunk) |
| `_audit` | `audit.log` (`audittrail`) |
| `os` | `/var/log/messages` (`syslog`) and `/var/log/secure` (`linux_secure`) from Linux forwarders with `Splunk_TA_nix`; `WinEventLog:*` from Windows forwarders |
| `app` | `app:log`, `access_combined` and `mysqld` from the class's monitored file |
| `network` | ASA syslog via the syslog relays (`host` is the firewall, from `host_segment`) |

What gets indexed follows the world:
- Nothing arrives while a forwarder is offline.
- A blocked forwarder delivers nothing until it unblocks, and then its backlog arrives with the original timestamps.
- Removing an inputs app on the deployment server stops that data, while `_internal` carries on.
- `splunk_server` is the indexer the forwarder was connected to at the time.

**SPL subset.** The base search supports terms, `"phrases"`, `field=value` with wildcards, `!= < <= > >=`, `AND`/`OR`/`NOT` (OR binds tighter than AND, as in Splunk), and `earliest=`/`latest=` (relative, snapped, epoch or absolute). Commands:

| Kind | Commands |
|---|---|
| Streaming | `search` `where` `eval` `rex` (named groups, `field=`, `max_match=`) `rename` |
| Ordering and reshaping | `fields` `table` `sort` `head` `tail` `dedup` `fillnull` `lookup` |
| Transforming | `stats` (count dc sum avg min max range median mode stdev var values list first last earliest latest percN, `by`) `timechart` (span, limit, OTHER) `top` `rare` |
| Generating | `inputlookup` `rest` `metadata` `makeresults` |

- `eval`/`where` support arithmetic, `.` concatenation, comparisons, `AND`/`OR`/`NOT`/`XOR`, `LIKE`, and functions such as `if` `case` `coalesce` `len` `lower` `upper` `substr` `replace` `match` `like` `round` `tonumber` `tostring` `strftime` `strptime` `relative_time` `now` `split` `mvcount` `mvindex` `mvjoin` `cidrmatch` `isnull` `isnotnull`.
- Unsupported commands, subsearches and `tstats` return Splunk-style errors (`tstats` is planned).
- Lookups: `forwarder_inventory` (built live from the fleet, so it agrees with the dashboard), `site_contacts` and `indexer_inventory`.
- `rest` endpoints: `server/info`, `search/distributed/peers`, `cluster/manager/peers`, `data/indexes` and `deployment/server/clients`.
- `metadata type=hosts|sources|sourcetypes`: `lastTime` is exact; `totalCount` is an estimate from the recent event rate.

**Scale.** A full fleet-wide raw scan is too much to generate, so the scan uses pushdown. If a search still exceeds the budget (3M events or 8 s), it stops with Splunk's "results may be incomplete" warning.
- **Indexed-field filtering:** `index`, `sourcetype`, `source` and `host` constraints skip hosts and sources before any events are generated.
- **Gates:** words such as `blocked`, `WARN` or `HttpPubSubConnection` only appear while a host is in certain states. Hosts that were never in those states during the time range are skipped. Tests check that this never changes results.

Typical full-scale times (35,000 forwarders, 15 minutes): fleet-wide `blocked=true` about 0.6 s, `log_level=WARN | stats count by component` about 1 s, `| metadata type=hosts index=_internal` about 2.5 s.

## Incidents & Tickets (milestone 5)

Open **Incidents & Tickets** and start an incident. Investigate with the fleet, search and terminal views, fix the cause, apply the right restart or reload, and close the ticket with a resolution note.

**Nothing starts on its own.** Every incident is manual by default. A scenario file can opt in to a scheduled start with `trigger: { afterMinutes: N }`.

**Limits:**
- At most two tickets can be active at once.
- Two scenarios that edit the same config file can't overlap.
- Each incident can start once per session.
- Tickets and world changes stay in memory until the server restarts. Saving sessions and resetting them is milestone 8.

**What you see is the symptom, not the cause.**
- Cards and tickets show the requester's view ("Dallas web access logs went quiet") and the difficulty only.
- Each scenario's `summary` holds the root cause for authors and the future debrief. The API never returns it, nor the changes or fix checks.

### Scenario files

`scenarios/*.yaml` are read at server startup and checked with Zod. Writing a new incident means writing one file:

| Field | Purpose |
|---|---|
| `title`, `ticket` | The symptom: what the requester reports |
| `summary` | The root cause (hidden from the UI) |
| `changes` | Stanza edits through the virtual filesystem, applied with `restart` or `deploy-server` (reload) |
| `redHerrings` | Real log lines written to a host's `splunkd.log` or `/var/log/messages` every N minutes until the ticket closes. They are greppable and searchable like any other line. A forwarder with injected lines skips search gating, so search results stay exact. |
| `fixChecks` | Outcomes, combinable with `all` / `any` |
| `clues` | Notes for authors and hints |
| `recovery` | Seconds the fix must hold before the ticket counts as resolved |

**Fix checks test outcomes, so any correct fix passes:**
- `fleet`: at most N% of a site or server class is in a given health state.
- `parsingQueue`: whether an indexer's parsing queue is blocked.
- `eventBreaking`: whether an indexer's running props keep consecutive events of a sourcetype separate.
- `effectiveConf`: one exact running setting, for incidents where that really is the point.

All checks read running state, so saving a file alone never resolves a ticket.

**Ticket states:** open → recovering → resolved → closed. If the problem comes back before the ticket is closed, it reopens and the recovery timer resets.

### The three incidents (spoilers)

| Ticket | Cause | One correct fix |
|---|---|---|
| Dallas web access logs went quiet | `serverClass:linux_web` whitelist typo `dal-wbe-*` on ds01 | Fix the whitelist (`dal-web-*` or any pattern matching the Dallas web servers), then `splunk reload deploy-server` |
| Dallas forwarders are backing up | idx01 `[queue=parsingQueue] maxSize = 1KB` in system/local/server.conf | Give the queue an adequate size (for example the 6MB default or more), then restart idx01 |
| Application search results look jumbled | idx01 cluster props for `app:log` set to `SHOULD_LINEMERGE = true` with a `LINE_BREAKER` that never matches | Turn line merging off or restore a working `LINE_BREAKER`, then restart idx01 |

Each has a solution-run test in `packages/sim/test/scenario.test.ts`, including alternative fixes. At 30×, recovery takes a few wall-clock seconds. Events indexed before a parsing fix stay merged, so check new data. The original application files always keep their individual lines.

**Simulation limits:**
- Line merging models an unmatched breaker in fixed two-minute windows on the receiving indexer. It isn't a full implementation of Splunk parsing.
- Queues below 512KB saturate under the simulated steady load. Backpressure blocks the whole upstream output group, even when another receiver is reachable.
- Monitoring Console alerts and cluster-bundle commands come in later milestones.

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

### Search (milestone 4)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/search/jobs` | `{ search, earliest?, latest? }`; runs synchronously and returns the job summary plus the first page of events and results |
| GET | `/api/search/jobs/:sid/events` | `offset`, `count` (≤500) |
| GET | `/api/search/jobs/:sid/results` | `offset`, `count` (≤500); the last 20 jobs are kept |

### Incidents (milestone 5)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/scenarios` | Public catalog: id, symptom title, topics, difficulty (no cause, changes or fix checks) |
| POST | `/api/scenarios/:id/start` | Apply an incident and open a ticket |
| GET | `/api/tickets` | Tickets and current recovery status |
| POST | `/api/tickets/:id/close` | `{ "note": "Root cause, fix, verification" }`; requires resolved state |

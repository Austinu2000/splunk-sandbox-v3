import Database from 'better-sqlite3';
import type { SavedSessionDto, InterviewHistoryDto } from '@sandbox/shared';
import type { SavedWorld, World } from '@sandbox/sim';
import { saveWorld } from '@sandbox/sim';

/**
 * SQLite persistence for sessions, action logs and interview scores. The `sessions.save_json`
 * journal is the source of truth (loading replays it); `actions` and `interviews` are copies kept
 * queryable, so history and scores can be read without replaying anything.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  kind       TEXT    NOT NULL CHECK (kind IN ('manual', 'autosave')),
  seed       TEXT    NOT NULL,
  fleet_size INTEGER NOT NULL,
  tick       INTEGER NOT NULL,
  sim_time   INTEGER NOT NULL,
  saved_at   INTEGER NOT NULL,
  version    INTEGER NOT NULL,
  save_json  TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS one_autosave ON sessions (kind) WHERE kind = 'autosave';
CREATE TABLE IF NOT EXISTS actions (
  session_id INTEGER NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  kind       TEXT    NOT NULL,
  sim_time   INTEGER NOT NULL,
  wall_time  INTEGER NOT NULL,
  host       TEXT,
  user       TEXT,
  text       TEXT    NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE TABLE IF NOT EXISTS interviews (
  session_id   INTEGER NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  id           TEXT    NOT NULL,
  scenario_id  TEXT    NOT NULL,
  title        TEXT    NOT NULL,
  difficulty   TEXT    NOT NULL,
  started_at   INTEGER NOT NULL,
  submitted_at INTEGER,
  total        INTEGER,
  answer_json  TEXT,
  debrief_json TEXT,
  PRIMARY KEY (session_id, id)
);
`;

interface SessionRow {
  id: number;
  name: string;
  kind: 'manual' | 'autosave';
  seed: string;
  fleet_size: number;
  tick: number;
  sim_time: number;
  saved_at: number;
  interviews: number;
  best: number | null;
}

export class SessionStore {
  private readonly db: Database.Database;

  /** `path` is a file, or ':memory:' for tests. */
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Save a world as a new manual session, or replace the single autosave. */
  save(world: World, name: string, kind: 'manual' | 'autosave', savedAt: number): number {
    const saved = saveWorld(world);
    const tx = this.db.transaction(() => {
      if (kind === 'autosave') this.db.prepare(`DELETE FROM sessions WHERE kind = 'autosave'`).run();
      const { lastInsertRowid } = this.db
        .prepare(
          `INSERT INTO sessions (name, kind, seed, fleet_size, tick, sim_time, saved_at, version, save_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          name,
          kind,
          saved.seed,
          saved.fleetSize,
          saved.tick,
          world.clock.now,
          savedAt,
          saved.version,
          JSON.stringify(saved),
        );
      const id = Number(lastInsertRowid);
      const action = this.db.prepare(
        `INSERT INTO actions (session_id, seq, kind, sim_time, wall_time, host, user, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const a of world.actions)
        action.run(id, a.seq, a.kind, a.simTime, a.wallTime, a.host ?? null, a.user ?? null, a.text);
      const interview = this.db.prepare(
        `INSERT INTO interviews (session_id, id, scenario_id, title, difficulty, started_at, submitted_at, total, answer_json, debrief_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const i of world.interviews)
        interview.run(
          id,
          i.id,
          i.scenarioId,
          i.title,
          i.difficulty,
          i.startedAt,
          i.submittedAt ?? null,
          i.debrief?.total ?? null,
          i.answer ? JSON.stringify(i.answer) : null,
          i.debrief ? JSON.stringify(i.debrief) : null,
        );
      return id;
    });
    return tx();
  }

  list(): SavedSessionDto[] {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.name, s.kind, s.seed, s.fleet_size, s.tick, s.sim_time, s.saved_at,
                COUNT(i.submitted_at) AS interviews, MAX(i.total) AS best
           FROM sessions s LEFT JOIN interviews i ON i.session_id = s.id
          GROUP BY s.id
          ORDER BY s.kind = 'autosave' DESC, s.saved_at DESC`,
      )
      .all() as SessionRow[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      seed: r.seed,
      fleetSize: r.fleet_size,
      tick: r.tick,
      simTime: r.sim_time,
      savedAt: r.saved_at,
      interviews: r.interviews,
      bestScore: r.best,
    }));
  }

  get(id: number): SavedWorld | null {
    const row = this.db.prepare(`SELECT save_json FROM sessions WHERE id = ?`).get(id) as
      { save_json: string } | undefined;
    return row ? (JSON.parse(row.save_json) as SavedWorld) : null;
  }

  delete(id: number): boolean {
    return this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id).changes > 0;
  }

  /**
   * Submitted interviews across all saved sessions, newest first. The same interview saved in
   * several sessions (or the autosave) appears once.
   */
  interviewHistory(limit = 100): InterviewHistoryDto[] {
    const rows = this.db
      .prepare(
        `SELECT i.scenario_id, i.title, i.difficulty, i.started_at, i.submitted_at, i.total, s.name AS session, s.id AS session_id
           FROM interviews i JOIN sessions s ON s.id = i.session_id
          WHERE i.submitted_at IS NOT NULL
          GROUP BY i.scenario_id, i.started_at
          ORDER BY i.submitted_at DESC
          LIMIT ?`,
      )
      .all(limit) as {
      scenario_id: string;
      title: string;
      difficulty: 'easy' | 'medium' | 'hard';
      started_at: number;
      submitted_at: number;
      total: number;
      session: string;
      session_id: number;
    }[];
    return rows.map((r) => ({
      scenarioId: r.scenario_id,
      title: r.title,
      difficulty: r.difficulty,
      startedAt: r.started_at,
      submittedAt: r.submitted_at,
      total: r.total,
      session: r.session,
      sessionId: r.session_id,
    }));
  }

  /** Scenario ids with a submitted interview in any saved session. */
  practisedScenarios(): string[] {
    return (
      this.db.prepare(`SELECT DISTINCT scenario_id FROM interviews WHERE submitted_at IS NOT NULL`).all() as {
        scenario_id: string;
      }[]
    ).map((r) => r.scenario_id);
  }
}

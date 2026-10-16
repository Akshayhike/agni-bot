/**
 * Schema migrations. Append only: never edit an applied migration — add a new
 * numbered one instead. Applied inside a transaction; ids are recorded in
 * `schema_migrations`.
 *
 * FTS5 note: the search indexes are standalone (not external-content), so the
 * write path inserts into both the table and its index — one obvious write
 * path, no trigger magic. See docs/architecture.md (S2/S4).
 */

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: "initial",
    sql: `
      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_seen_at TEXT,
        revoked_at TEXT
      );

      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        title TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE turns (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        state TEXT NOT NULL,              -- running | done
        stop_reason TEXT,                 -- end | cancelled | error | timeout | budget
        provider TEXT,
        model TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        latency_ms INTEGER,
        started_at TEXT NOT NULL,
        ended_at TEXT
      );
      CREATE INDEX idx_turns_thread ON turns(thread_id, started_at);

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        turn_id TEXT,
        role TEXT NOT NULL,               -- user | assistant | system | tool
        text TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_messages_thread ON messages(thread_id, created_at);

      CREATE TABLE usage_ledger (
        id TEXT PRIMARY KEY,
        turn_id TEXT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        latency_ms INTEGER,
        day TEXT NOT NULL,                -- YYYY-MM-DD (UTC) for per-day caps
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_usage_day ON usage_ledger(day, provider);

      CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        thread_id TEXT,
        turn_id TEXT,
        action TEXT NOT NULL,
        preview TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',   -- pending | decided
        decision TEXT,                            -- once | always | reject
        created_at TEXT NOT NULL,
        decided_at TEXT
      );

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        due_at TEXT,
        priority TEXT NOT NULL DEFAULT 'normal',
        status TEXT NOT NULL DEFAULT 'open',      -- open | done | snoozed
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE links (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        title TEXT,
        summary TEXT,
        note TEXT,
        tags TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        summary TEXT,
        tags TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        payload TEXT,
        state TEXT NOT NULL DEFAULT 'queued',     -- queued | running | done | failed
        run_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_jobs_state ON jobs(state, run_at);

      -- Write-time search indexes (S2: memory is a tool, S4: index at ingest).
      CREATE VIRTUAL TABLE memories_fts USING fts5(id UNINDEXED, text, summary);
      CREATE VIRTUAL TABLE links_fts USING fts5(id UNINDEXED, title, summary, note, tags);
    `,
  },
  {
    id: 2,
    name: "jobs_result",
    sql: `
      ALTER TABLE jobs ADD COLUMN result TEXT;
    `,
  },
  {
    id: 3,
    name: "jobs_enabled",
    sql: `
      -- Routines can be paused from the client without deleting them.
      ALTER TABLE jobs ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
    `,
  },
];

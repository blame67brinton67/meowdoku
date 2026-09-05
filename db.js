const Database = require('better-sqlite3');

// Each entry is one step of `PRAGMA user_version`; a fresh file replays them
// all inside one transaction per step, an existing file only the new tail.
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash BLOB NOT NULL,
    salt BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    display_name TEXT,
    avatar TEXT,
    frame TEXT,
    settings_json TEXT
  );
  CREATE TABLE guests (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    guest_id TEXT REFERENCES guests(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    user_agent TEXT,
    CHECK ((user_id IS NULL) <> (guest_id IS NULL))
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE INDEX sessions_guest ON sessions(guest_id);
  CREATE TABLE progress (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    level_id TEXT NOT NULL,
    cleared_at INTEGER NOT NULL,
    ms INTEGER,
    hints_used INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, level_id)
  );
  CREATE TABLE match_history (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    match_id TEXT NOT NULL,
    finished_at INTEGER NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (user_id, match_id)
  );
  CREATE TABLE login_attempts (
    ip TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX login_attempts_ip ON login_attempts(ip, at);
  CREATE TABLE claimed_visitors (
    visitor_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    claimed_at INTEGER NOT NULL
  );
  `
];

function migrate(db) {
  for (let version = db.pragma('user_version', { simple: true }); version < MIGRATIONS.length; version++) {
    db.transaction(() => { db.exec(MIGRATIONS[version]); db.pragma(`user_version = ${version + 1}`); })();
  }
}

function openDb(file = ':memory:') {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

module.exports = { openDb, migrate, MIGRATIONS };

CREATE TABLE IF NOT EXISTS investigations (
  candidate_id TEXT PRIMARY KEY,
  candidate_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'analyzing', 'approved', 'rejected', 'uncertain', 'quota_paused', 'error')
  ),
  report_json TEXT,
  error_message TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  analyzed_at INTEGER,
  lease_until INTEGER
);

CREATE INDEX IF NOT EXISTS investigations_status_updated
  ON investigations(status, updated_at, candidate_id);

CREATE TABLE IF NOT EXISTS investigation_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id TEXT NOT NULL,
  status TEXT NOT NULL,
  report_json TEXT NOT NULL,
  attempt_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(candidate_id) REFERENCES investigations(candidate_id)
);

CREATE INDEX IF NOT EXISTS investigation_history_candidate
  ON investigation_history(candidate_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_daily_usage (
  day_utc TEXT PRIMARY KEY,
  estimated_neurons INTEGER NOT NULL DEFAULT 0,
  actual_neurons INTEGER NOT NULL DEFAULT 0,
  call_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS investigation_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  lease_id TEXT,
  expires_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS investigation_queue_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS investigation_cron_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_started_at INTEGER,
  last_finished_at INTEGER,
  last_status TEXT,
  last_error TEXT,
  last_candidate_id TEXT,
  invocation_count INTEGER NOT NULL DEFAULT 0
);

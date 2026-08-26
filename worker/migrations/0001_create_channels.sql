CREATE TABLE IF NOT EXISTS channels (
    name TEXT PRIMARY KEY,
    desired_request_id TEXT,
    desired_ports TEXT,
    desired_created_at INTEGER,
    desired_expires_at INTEGER,
    applied_request_id TEXT,
    applied_at INTEGER
);

DROP TABLE IF EXISTS channels;

CREATE TABLE channels (
    name TEXT PRIMARY KEY,
    port INTEGER CHECK (port BETWEEN 1 AND 65535),
    updated_at INTEGER,
    failed_port INTEGER CHECK (failed_port BETWEEN 1 AND 65535),
    failed_at INTEGER
);

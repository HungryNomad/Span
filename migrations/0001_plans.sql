-- A plan is one JSON document (stays, visas, trip options, costs).
-- Its shape lives in the app; D1 only checks that it is valid JSON.
CREATE TABLE plans (
  id         TEXT    PRIMARY KEY,
  name       TEXT    NOT NULL,
  body       TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(body)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX plans_updated_at ON plans (updated_at DESC);

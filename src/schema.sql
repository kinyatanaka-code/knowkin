CREATE TABLE IF NOT EXISTS memos (
  id          SERIAL PRIMARY KEY,
  source      TEXT NOT NULL DEFAULT 'text',          -- text / voice / claude
  text        TEXT NOT NULL,                          -- 原本（必ず残す）
  classified  BOOLEAN NOT NULL DEFAULT FALSE,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS units (
  id          SERIAL PRIMARY KEY,
  memo_id     INTEGER REFERENCES memos(id) ON DELETE SET NULL,
  type        TEXT NOT NULL,                          -- event/input/lesson/idea/decision/value/question/task/goal/person
  content     TEXT NOT NULL,
  quote       TEXT NOT NULL DEFAULT '',               -- 言われた言葉そのまま
  reason      TEXT NOT NULL DEFAULT '',               -- 判断の理由
  people      TEXT[] NOT NULL DEFAULT '{}',
  tags        TEXT[] NOT NULL DEFAULT '{}',
  due         DATE,
  importance  INTEGER NOT NULL DEFAULT 2,             -- 1〜3
  count       INTEGER NOT NULL DEFAULT 1,             -- 同じ内容が繰り返された回数
  dates       DATE[] NOT NULL DEFAULT '{}',
  done        BOOLEAN NOT NULL DEFAULT FALSE,
  done_at     TIMESTAMPTZ,
  reviewed    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS units_type_idx ON units(type);
CREATE INDEX IF NOT EXISTS units_created_idx ON units(created_at DESC);

CREATE TABLE IF NOT EXISTS core (
  id          INTEGER PRIMARY KEY DEFAULT 1,
  data        JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (id = 1)
);

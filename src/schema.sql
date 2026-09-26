CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  link_token    TEXT NOT NULL UNIQUE,                 -- コネクタURL・ショートカット用の連携キー
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS memos (
  id          SERIAL PRIMARY KEY,
  source      TEXT NOT NULL DEFAULT 'text',          -- text / voice / claude
  text        TEXT NOT NULL,                          -- 原本（必ず残す）
  classified  BOOLEAN NOT NULL DEFAULT FALSE,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE memos ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '';
ALTER TABLE memos ADD COLUMN IF NOT EXISTS summary TEXT[] NOT NULL DEFAULT '{}';

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

-- アカウントごとにデータを分ける
ALTER TABLE memos ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE units ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS memos_user_idx ON memos(user_id);
CREATE INDEX IF NOT EXISTS units_user_idx ON units(user_id);

CREATE TABLE IF NOT EXISTS cores (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data        JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Claude.aiのコネクタ用 OAuth
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id     TEXT PRIMARY KEY,
  client_name   TEXT NOT NULL DEFAULT '',
  redirect_uris TEXT[] NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash  TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,                          -- access / refresh
  client_id   TEXT NOT NULL,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL
);

-- 取り込み元の識別子（kinbot・kincallからの二重取り込みを防ぐ）
ALTER TABLE memos ADD COLUMN IF NOT EXISTS ref TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS memos_user_ref_idx ON memos(user_id, ref) WHERE ref IS NOT NULL;

-- 写真のメモ
CREATE TABLE IF NOT EXISTS memo_images (
  memo_id     INTEGER PRIMARY KEY REFERENCES memos(id) ON DELETE CASCADE,
  mime        TEXT NOT NULL,
  data        BYTEA NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 既存の種類に当てはまらない記憶のために、Claudeが自動で作るカテゴリ
CREATE TABLE IF NOT EXISTS categories (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key          TEXT NOT NULL,                         -- 英小文字の識別子（units.type に入る）
  label        TEXT NOT NULL,                         -- 表示名
  description  TEXT NOT NULL DEFAULT '',              -- どんな記憶を入れるか
  layer        TEXT NOT NULL,                         -- 既存の層（event/know/think/act/rel）か 'new'
  layer_label  TEXT NOT NULL DEFAULT '',              -- layer が new のときの新しい層の名前
  reviewed     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, key)
);

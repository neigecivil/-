/* 资源分享站 · 云端版建表脚本
   用法：在 Cloudflare 控制台的 D1 页面里执行整份内容。

   注意：本文件只用块注释，不用行注释。
   原因：有些控制台的输入框是单行的，粘贴时换行会被压成空格，
   而行注释一旦失去换行，就会把它后面的整份 SQL 都注释掉。 */

/* 账号 */
CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  username       TEXT NOT NULL,
  username_lower TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  salt           TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('admin', 'member', 'guest')),
  created_at     TEXT NOT NULL,
  disabled_at    TEXT
);

/* 邀请码 */
CREATE TABLE IF NOT EXISTS invites (
  code       TEXT PRIMARY KEY,
  role       TEXT NOT NULL CHECK (role IN ('admin', 'member', 'guest')),
  max_uses   INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  revoked_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

/* 资源 */
CREATE TABLE IF NOT EXISTS resources (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES users(id),
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL,
  platform    TEXT NOT NULL DEFAULT '',
  visibility  TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'members')),
  r2_key      TEXT NOT NULL,
  file_name   TEXT NOT NULL,
  file_size   INTEGER NOT NULL,
  mime        TEXT NOT NULL DEFAULT 'application/octet-stream',
  downloads   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_resources_created  ON resources(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_resources_owner    ON resources(owner_id);
CREATE INDEX IF NOT EXISTS idx_resources_category ON resources(category);

/* 登录状态 */
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

/* 登录失败记录，用来做锁定 */
CREATE TABLE IF NOT EXISTS login_failures (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username_lower TEXT NOT NULL,
  occurred_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_failures_lookup ON login_failures(username_lower, occurred_at);

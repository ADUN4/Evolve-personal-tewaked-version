-- Evolve 服务端 D1 表结构（阶段 0：邮箱验证码）
-- 应用方式：
--   npx wrangler d1 execute evolve --remote --file=deploy/schema.sql
-- 本地调试：
--   npx wrangler d1 execute evolve --local --file=deploy/schema.sql

-- 验证码本体（每个邮箱一条，重新请求就覆盖）
-- 只存 sha256(code:salt:email)，不存明文；attempts 限制试错
CREATE TABLE IF NOT EXISTS verify_codes (
  email      TEXT PRIMARY KEY,
  code_hash  TEXT    NOT NULL,
  salt       TEXT    NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0
);

-- 限流状态：必须与 verify_codes 分开存。
-- 验证成功后 verify_codes 那行会被删掉，如果限流计数也在那行里，
-- 攻击者"请求 → 验证成功 → 再请求"就能无限发信（本地实测踩过这个坑）。
CREATE TABLE IF NOT EXISTS verify_rate (
  email           TEXT PRIMARY KEY,
  last_request_at INTEGER NOT NULL,
  hour_window     INTEGER NOT NULL,
  hour_count      INTEGER NOT NULL DEFAULT 1
);

-- 按来源 IP 的限流，防同一网络批量轰炸
CREATE TABLE IF NOT EXISTS verify_ip_rate (
  ip          TEXT PRIMARY KEY,
  hour_window INTEGER NOT NULL,
  hour_count  INTEGER NOT NULL DEFAULT 1
);

-- 验证通过的邮箱 + 一次性 token（客户端拿它去走 PlayFab 注册）
CREATE TABLE IF NOT EXISTS verified_emails (
  email            TEXT PRIMARY KEY,
  verified_at      INTEGER NOT NULL,
  token            TEXT    NOT NULL,
  token_expires_at INTEGER NOT NULL
);

-- 玩家 ↔ 邮箱 ↔ 世界 的绑定（阶段 1 起使用）
CREATE TABLE IF NOT EXISTS players (
  playfab_id   TEXT PRIMARY KEY,
  email        TEXT,
  display_name TEXT,
  world_id     TEXT,
  created_at   INTEGER NOT NULL
);

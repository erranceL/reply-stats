import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS teams (
  team_id      TEXT PRIMARY KEY,
  name         TEXT,
  url          TEXT,
  bot_token    TEXT NOT NULL,
  bot_user_id  TEXT,
  installed_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS user_tokens (
  team_id       TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  token         TEXT NOT NULL,
  scopes        TEXT,
  authorized_at REAL NOT NULL,
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE IF NOT EXISTS users (
  team_id    TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  name       TEXT,
  is_bot     INTEGER NOT NULL DEFAULT 0,
  is_admin   INTEGER NOT NULL DEFAULT 0,
  fetched_at REAL NOT NULL,
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE IF NOT EXISTS dm_channels (
  team_id    TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  user_a     TEXT NOT NULL,
  user_b     TEXT NOT NULL,
  PRIMARY KEY (team_id, channel_id)
);

-- 每一行是一次“某人被 @ 或被私聊，需要回复”的记录；reply_at 为空表示还没回复。
-- 只保存时间和人员等元数据，不保存消息内容。
CREATE TABLE IF NOT EXISTS items (
  id           INTEGER PRIMARY KEY,
  team_id      TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('mention', 'dm')),
  channel_id   TEXT NOT NULL,
  root_ts      TEXT,
  in_thread    INTEGER NOT NULL DEFAULT 0,
  trigger_ts   TEXT NOT NULL,
  trigger_at   REAL NOT NULL,
  from_user    TEXT NOT NULL,
  target_user  TEXT NOT NULL,
  reply_ts     TEXT,
  reply_at     REAL,
  work_seconds REAL,
  wall_seconds REAL,
  UNIQUE (team_id, channel_id, trigger_ts, target_user)
);
CREATE INDEX IF NOT EXISTS items_open
  ON items (team_id, channel_id, target_user) WHERE reply_at IS NULL;
CREATE INDEX IF NOT EXISTS items_by_time ON items (team_id, trigger_at);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function openStore(path, cipher) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);

  const now = () => Date.now() / 1000;

  const q = {
    saveTeam: db.prepare(`
      INSERT INTO teams (team_id, name, url, bot_token, bot_user_id, installed_at)
      VALUES (@teamId, @name, @url, @botToken, @botUserId, @installedAt)
      ON CONFLICT (team_id) DO UPDATE SET
        name = excluded.name, url = excluded.url,
        bot_token = excluded.bot_token, bot_user_id = excluded.bot_user_id`),
    getTeam: db.prepare('SELECT * FROM teams WHERE team_id = ?'),
    listTeams: db.prepare('SELECT * FROM teams'),
    deleteTeam: db.prepare('DELETE FROM teams WHERE team_id = ?'),

    saveUserToken: db.prepare(`
      INSERT INTO user_tokens (team_id, user_id, token, scopes, authorized_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (team_id, user_id) DO UPDATE SET
        token = excluded.token, scopes = excluded.scopes, authorized_at = excluded.authorized_at`),
    getUserToken: db.prepare('SELECT token FROM user_tokens WHERE team_id = ? AND user_id = ?'),
    deleteUserToken: db.prepare('DELETE FROM user_tokens WHERE team_id = ? AND user_id = ?'),
    deleteTeamUserTokens: db.prepare('DELETE FROM user_tokens WHERE team_id = ?'),
    countUserTokens: db.prepare('SELECT COUNT(*) AS n FROM user_tokens WHERE team_id = ?'),

    saveUser: db.prepare(`
      INSERT INTO users (team_id, user_id, name, is_bot, is_admin, fetched_at)
      VALUES (@teamId, @userId, @name, @isBot, @isAdmin, @fetchedAt)
      ON CONFLICT (team_id, user_id) DO UPDATE SET
        name = excluded.name, is_bot = excluded.is_bot,
        is_admin = excluded.is_admin, fetched_at = excluded.fetched_at`),
    getUser: db.prepare('SELECT * FROM users WHERE team_id = ? AND user_id = ?'),

    saveDm: db.prepare(`
      INSERT OR REPLACE INTO dm_channels (team_id, channel_id, user_a, user_b) VALUES (?, ?, ?, ?)`),
    getDm: db.prepare('SELECT user_a, user_b FROM dm_channels WHERE team_id = ? AND channel_id = ?'),

    insertItem: db.prepare(`
      INSERT OR IGNORE INTO items
        (team_id, kind, channel_id, root_ts, in_thread, trigger_ts, trigger_at, from_user, target_user)
      VALUES
        (@teamId, @kind, @channel, @rootTs, @inThread, @triggerTs, @triggerAt, @fromUser, @targetUser)`),
    openItems: db.prepare(`
      SELECT * FROM items
      WHERE team_id = ? AND channel_id = ? AND target_user = ? AND reply_at IS NULL`),
    resolveItem: db.prepare(`
      UPDATE items SET reply_ts = ?, reply_at = ?, work_seconds = ?, wall_seconds = ?
      WHERE id = ? AND reply_at IS NULL`),
    deleteOpenByTrigger: db.prepare(`
      DELETE FROM items
      WHERE team_id = ? AND channel_id = ? AND trigger_ts = ? AND reply_at IS NULL`),
    listItems: db.prepare(`
      SELECT * FROM items
      WHERE team_id = @teamId AND trigger_at >= @from AND trigger_at < @to
        AND (@targetUser IS NULL OR target_user = @targetUser)
      ORDER BY trigger_at`),

    getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: db.prepare(`
      INSERT INTO meta (key, value) VALUES (?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`),
  };

  const teamFromRow = (row) =>
    row && {
      teamId: row.team_id,
      name: row.name,
      url: row.url,
      botToken: cipher.decrypt(row.bot_token),
      botUserId: row.bot_user_id,
    };

  return {
    close: () => db.close(),

    saveTeam({ teamId, name, url, botToken, botUserId }) {
      q.saveTeam.run({
        teamId,
        name: name ?? null,
        url: url ?? null,
        botToken: cipher.encrypt(botToken),
        botUserId: botUserId ?? null,
        installedAt: now(),
      });
    },
    getTeam: (teamId) => teamFromRow(q.getTeam.get(teamId)) ?? null,
    listTeams: () => q.listTeams.all().map(teamFromRow),
    deleteTeam: db.transaction((teamId) => {
      q.deleteTeam.run(teamId);
      q.deleteTeamUserTokens.run(teamId);
    }),

    saveUserToken(teamId, userId, token, scopes) {
      q.saveUserToken.run(teamId, userId, cipher.encrypt(token), scopes ?? null, now());
    },
    getUserToken(teamId, userId) {
      const row = q.getUserToken.get(teamId, userId);
      return row ? cipher.decrypt(row.token) : null;
    },
    deleteUserToken: (teamId, userId) => q.deleteUserToken.run(teamId, userId),
    countUserTokens: (teamId) => q.countUserTokens.get(teamId).n,

    saveUser({ teamId, userId, name, isBot, isAdmin }) {
      q.saveUser.run({
        teamId,
        userId,
        name: name ?? null,
        isBot: isBot ? 1 : 0,
        isAdmin: isAdmin ? 1 : 0,
        fetchedAt: now(),
      });
    },
    getUser(teamId, userId) {
      const row = q.getUser.get(teamId, userId);
      return row
        ? {
            userId: row.user_id,
            name: row.name,
            isBot: !!row.is_bot,
            isAdmin: !!row.is_admin,
            fetchedAt: row.fetched_at,
          }
        : null;
    },

    saveDm: (teamId, channel, userA, userB) => q.saveDm.run(teamId, channel, userA, userB),
    getDm(teamId, channel) {
      const row = q.getDm.get(teamId, channel);
      return row ? [row.user_a, row.user_b] : null;
    },

    insertItem(item) {
      return q.insertItem.run({ rootTs: null, inThread: 0, ...item }).changes > 0;
    },
    openItems: (teamId, channel, targetUser) => q.openItems.all(teamId, channel, targetUser),
    resolveItem: (id, replyTs, replyAt, workSeconds, wallSeconds) =>
      q.resolveItem.run(replyTs, replyAt, workSeconds, wallSeconds, id),
    deleteOpenByTrigger: (teamId, channel, triggerTs) =>
      q.deleteOpenByTrigger.run(teamId, channel, triggerTs).changes,
    listItems: ({ teamId, from, to, targetUser = null }) =>
      q.listItems.all({ teamId, from, to, targetUser }),

    getMeta: (key) => q.getMeta.get(key)?.value ?? null,
    setMeta: (key, value) => q.setMeta.run(key, String(value)),
  };
}

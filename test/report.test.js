import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeStats,
  formatDuration,
  formatRanking,
  formatUserDetail,
  parsePeriod,
} from '../src/report.js';
import { latestSchedule } from '../src/scheduler.js';
import { TEAM, at, setup, ts } from './helpers.js';

const NOW = at('2026-11-18 12:00'); // 周三中午

function seed() {
  const ctx = setup();
  const { tracker } = ctx;
  const say = (channel, time, user, mentions, threadTs) =>
    tracker.onChannelMessage({ teamId: TEAM, channel, ts: ts(time), user, mentions, threadTs: threadTs && ts(threadTs) });

  // UB：一次按时（10 分钟）、一次超时后回复（50 分钟）、一次至今未回复
  say('C1', '2026-11-16 11:00', 'UA', ['UB']);
  say('C1', '2026-11-16 11:10', 'UB');
  say('C1', '2026-11-16 14:00', 'UA', ['UB']);
  say('C1', '2026-11-16 14:50', 'UB');
  say('C2', '2026-11-17 16:00', 'UA', ['UB']);
  // UC：私聊，隔夜回复：周一 16:00 -> 周二 11:00 = 90 分 + 30 分 = 2 小时
  tracker.onDmMessage({ teamId: TEAM, channel: 'D1', ts: ts('2026-11-16 16:00'), user: 'UA', otherUser: 'UC' });
  tracker.onDmMessage({ teamId: TEAM, channel: 'D1', ts: ts('2026-11-17 11:00'), user: 'UC', otherUser: 'UA' });
  // UD：刚被 @ 10 分钟，还没到阈值，不算超时
  say('C1', '2026-11-18 11:50', 'UA', ['UD']);
  return ctx;
}

function stats(ctx, extra = {}) {
  const period = parsePeriod('week', 'Asia/Shanghai', NOW);
  return computeStats({
    store: ctx.store,
    clock: ctx.clock,
    teamId: TEAM,
    from: period.from,
    to: period.to,
    now: NOW,
    thresholdSeconds: ctx.config.thresholdSeconds,
    ...extra,
  });
}

test('computeStats 会跳过排除名单里的成员', () => {
  const ranked = stats(seed(), { excludeUsers: new Set(['UB', 'UC']) });
  assert.ok(!ranked.some((s) => s.userId === 'UB' || s.userId === 'UC'));
  assert.ok(ranked.some((s) => s.userId === 'UA' || s.userId === 'UD'));
});

test('computeStats 统计超时次数、未回复数和回复时长', () => {
  const byUser = Object.fromEntries(stats(seed()).map((s) => [s.userId, s]));

  assert.equal(byUser.UB.total, 3);
  assert.equal(byUser.UB.overdue, 2);
  assert.equal(byUser.UB.unanswered, 1);
  assert.equal(byUser.UB.avgReply, 50 * 60);
  assert.equal(byUser.UB.maxReply, 50 * 60);
  // 未回复那条：周二 16:00 -> 周三 12:00 = 1.5 小时 + 1.5 小时
  assert.equal(byUser.UB.overdueItems.find((i) => !i.replied).seconds, 3 * 3600);

  assert.equal(byUser.UC.overdue, 1);
  assert.equal(byUser.UC.unanswered, 0);
  assert.equal(byUser.UC.avgReply, 2 * 3600);

  assert.equal(byUser.UD.total, 1);
  assert.equal(byUser.UD.overdue, 0);

  // UA 被 UC 私聊回复后也挂着一条：周二 11:00 -> 周三 12:00，已超时未回复
  assert.equal(byUser.UA.unanswered, 1);
});

test('computeStats 按超时次数排序，并可只看一个人', () => {
  const ctx = seed();
  assert.equal(stats(ctx)[0].userId, 'UB');
  const only = stats(ctx, { targetUser: 'UC' });
  assert.deepEqual(only.map((s) => s.userId), ['UC']);
});

test('恰好等于阈值不算超时', () => {
  const ctx = setup();
  ctx.tracker.onChannelMessage({ teamId: TEAM, channel: 'C1', ts: ts('2026-11-16 11:00'), user: 'UA', mentions: ['UB'] });
  ctx.tracker.onChannelMessage({ teamId: TEAM, channel: 'C1', ts: ts('2026-11-16 11:30'), user: 'UB' });
  assert.equal(stats(ctx)[0].overdue, 0);
});

test('formatRanking 输出排行和说明', () => {
  const ctx = seed();
  const text = formatRanking({
    stats: stats(ctx),
    period: parsePeriod('week', 'Asia/Shanghai', NOW),
    config: ctx.config,
    names: new Map([['UB', '小白'], ['UC', '小陈'], ['UA', '小安']]),
    dmAuthorizedCount: 2,
  });
  assert.match(text, /回复速率统计 · 本周（11-16 ~ 11-22）/);
  assert.match(text, /超过 30 分钟未回复记为超时，时长只计工作时间（周一至周五 10:30–12:00、14:00–17:30）/);
  assert.match(text, /1\. \*小白\* — 超时 \*2\* 次（其中 1 次至今未回复） · 超时后平均 50 分钟回复，最长 50 分钟 · 共收到 3 条/);
  assert.match(text, /\*小陈\* — 超时 \*1\* 次 · 超时后平均 2 小时回复，最长 2 小时 · 共收到 1 条/);
  assert.match(text, /另有 1 人没有超时/);
  assert.match(text, /目前已授权 2 人/);
});

test('formatRanking 处理空数据', () => {
  const ctx = setup();
  const text = formatRanking({
    stats: [],
    period: parsePeriod('today', 'Asia/Shanghai', NOW),
    config: ctx.config,
    names: new Map(),
  });
  assert.match(text, /今天（11-18）/);
  assert.match(text, /没有记录到需要回复的/);
});

test('formatUserDetail 列出超时明细和消息链接', () => {
  const ctx = seed();
  const [stat] = stats(ctx, { targetUser: 'UB' });
  const text = formatUserDetail({
    stat,
    userId: 'UB',
    period: parsePeriod('week', 'Asia/Shanghai', NOW),
    config: ctx.config,
    names: new Map([['UB', '小白'], ['UA', '小安']]),
    teamUrl: 'https://acme.slack.com/',
  });
  const lines = text.split('\n');
  assert.match(lines[0], /小白 · 本周/);
  // 最近的排在前面
  assert.match(lines.at(-2), /^• 11-17 16:00 <#C2> 被 小安 @ → 至今未回复（已过 3 小时） <https:\/\/acme\.slack\.com\/archives\/C2\/p\d+\|查看>$/);
  assert.match(lines.at(-1), /^• 11-16 14:00 <#C1> 被 小安 @ → 50 分钟后回复 /);
});

test('formatUserDetail：私聊不带链接；没有数据时给出说明', () => {
  const ctx = seed();
  const period = parsePeriod('week', 'Asia/Shanghai', NOW);
  const [stat] = stats(ctx, { targetUser: 'UC' });
  const text = formatUserDetail({ stat, userId: 'UC', period, config: ctx.config, names: new Map([['UA', '小安']]), teamUrl: 'https://acme.slack.com/' });
  assert.match(text, /• 11-16 16:00 小安 的私聊 → 2 小时后回复$/);

  const none = formatUserDetail({ stat: undefined, userId: 'UZ', period, config: ctx.config, names: new Map() });
  assert.match(none, /没有记录到需要回复的/);
});

test('parsePeriod 识别各种时间范围', () => {
  const p = (w) => parsePeriod(w, 'Asia/Shanghai', NOW);
  assert.deepEqual([p('today').from, p('today').to], [at('2026-11-18 00:00'), at('2026-11-19 00:00')]);
  assert.deepEqual([p('昨天').from, p('昨天').to], [at('2026-11-17 00:00'), at('2026-11-18 00:00')]);
  assert.deepEqual([p(undefined).from, p(undefined).to], [at('2026-11-16 00:00'), at('2026-11-23 00:00')]);
  assert.deepEqual([p('last-week').from, p('last-week').to], [at('2026-11-09 00:00'), at('2026-11-16 00:00')]);
  assert.deepEqual([p('month').from, p('month').to], [at('2026-11-01 00:00'), at('2026-12-01 00:00')]);
  assert.deepEqual([p('上月').from, p('上月').to], [at('2026-10-01 00:00'), at('2026-11-01 00:00')]);
  assert.deepEqual([p('7d').from, p('7d').to], [at('2026-11-12 00:00'), at('2026-11-19 00:00')]);
  assert.equal(p('7d').label, '最近 7 天（11-12 ~ 11-18）');
  assert.equal(p('whatever'), null);
  assert.equal(p('0d'), null);
});

test('formatDuration', () => {
  assert.equal(formatDuration(31 * 60), '31 分钟');
  assert.equal(formatDuration(3600), '1 小时');
  assert.equal(formatDuration(3600 + 12 * 60 + 20), '1 小时 12 分');
  assert.equal(formatDuration(26 * 3600), '26 小时');
});

test('latestSchedule：周一 09:30 发，覆盖上周一到周日', () => {
  const { config } = setup();
  const monday = latestSchedule(config, at('2026-11-16 09:30'));
  assert.equal(monday.key, '2026-11-16');
  assert.deepEqual([monday.period.from, monday.period.to], [at('2026-11-09 00:00'), at('2026-11-16 00:00')]);
  assert.equal(monday.period.label, '过去一周（11-09 ~ 11-15）');

  // 周一 09:29 还没到点，仍是上一期；周三则是本周一那一期
  assert.equal(latestSchedule(config, at('2026-11-16 09:29')).key, '2026-11-09');
  assert.equal(latestSchedule(config, at('2026-11-18 12:00')).key, '2026-11-16');
});

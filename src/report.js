import { DateTime } from 'luxon';

const DAY_NAMES = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const MAX_RANKED_USERS = 50;
const MAX_DETAIL_ITEMS = 10;

/** 把 “week / 上周 / 7d” 这类词解析成时间范围；无法识别时返回 null。 */
export function parsePeriod(word, timezone, nowSec) {
  const now = DateTime.fromSeconds(nowSec, { zone: timezone });
  const day = now.startOf('day');
  const week = now.startOf('week');
  const month = now.startOf('month');

  let range;
  switch ((word || 'week').toLowerCase()) {
    case 'today':
    case '今天':
      range = ['今天', day, day.plus({ days: 1 })];
      break;
    case 'yesterday':
    case '昨天':
      range = ['昨天', day.minus({ days: 1 }), day];
      break;
    case 'week':
    case '本周':
      range = ['本周', week, week.plus({ weeks: 1 })];
      break;
    case 'last-week':
    case 'lastweek':
    case '上周':
      range = ['上周', week.minus({ weeks: 1 }), week];
      break;
    case 'month':
    case '本月':
      range = ['本月', month, month.plus({ months: 1 })];
      break;
    case 'last-month':
    case 'lastmonth':
    case '上月':
      range = ['上月', month.minus({ months: 1 }), month];
      break;
    default: {
      const m = /^(\d{1,3})d$/i.exec(word);
      if (!m || Number(m[1]) < 1) return null;
      range = [`最近 ${m[1]} 天`, day.minus({ days: Number(m[1]) - 1 }), day.plus({ days: 1 })];
    }
  }
  const [name, from, to] = range;
  return makePeriod(name, from, to);
}

export function makePeriod(name, from, to) {
  const lastDay = to.minus({ days: 1 });
  const dates = from.hasSame(lastDay, 'day')
    ? from.toFormat('MM-dd')
    : `${from.toFormat('MM-dd')} ~ ${lastDay.toFormat('MM-dd')}`;
  return { label: `${name}（${dates}）`, from: from.toSeconds(), to: to.toSeconds() };
}

/** 按被 @ / 被私聊的人汇总。超时 = 有效时长超过阈值（已回复的看回复用时，未回复的看到现在为止）。 */
export function computeStats({ store, clock, teamId, from, to, now, thresholdSeconds, targetUser }) {
  const byUser = new Map();
  for (const item of store.listItems({ teamId, from, to, targetUser })) {
    let stat = byUser.get(item.target_user);
    if (!stat) {
      stat = { userId: item.target_user, total: 0, overdue: 0, unanswered: 0, replyTimes: [], overdueItems: [] };
      byUser.set(item.target_user, stat);
    }
    stat.total += 1;

    const replied = item.reply_at != null;
    const seconds = replied ? item.work_seconds : clock.elapsed(item.trigger_at, now);
    if (seconds <= thresholdSeconds) continue;

    stat.overdue += 1;
    if (replied) stat.replyTimes.push(seconds);
    else stat.unanswered += 1;
    stat.overdueItems.push({ ...item, replied, seconds });
  }

  const stats = [...byUser.values()].map((s) => ({
    ...s,
    avgReply: s.replyTimes.length ? s.replyTimes.reduce((a, b) => a + b, 0) / s.replyTimes.length : null,
    maxReply: s.replyTimes.length ? Math.max(...s.replyTimes) : null,
  }));
  stats.sort((a, b) => b.overdue - a.overdue || (b.avgReply ?? 0) - (a.avgReply ?? 0));
  return stats;
}

export function formatDuration(seconds) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} 分钟`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (t) => `${pad(t.hour)}:${pad(t.minute)}`;

export function describeRules(config) {
  const threshold = `超过 ${Math.round(config.thresholdSeconds / 60)} 分钟未回复记为超时`;
  if (!config.work.enabled) return `${threshold}，时长按实际经过时间计算。`;
  const days = [...config.work.days].sort((a, b) => a - b);
  const dayText =
    days.join(',') === '1,2,3,4,5' ? '周一至周五' : days.map((d) => DAY_NAMES[d]).join('、');
  return `${threshold}，时长只计工作时间（${dayText} ${hhmm(config.work.start)}–${hhmm(config.work.end)}）。`;
}

function summaryLine(stat, name) {
  const parts = [`*${name}* — 超时 *${stat.overdue}* 次`];
  if (stat.unanswered) parts[0] += `（其中 ${stat.unanswered} 次至今未回复）`;
  if (stat.avgReply != null) {
    parts.push(`超时后平均 ${formatDuration(stat.avgReply)}回复，最长 ${formatDuration(stat.maxReply)}`);
  }
  parts.push(`共收到 ${stat.total} 条`);
  return parts.join(' · ');
}

/** 全员排行。names 是 userId -> 显示名 的 Map。 */
export function formatRanking({ stats, period, config, names, dmAuthorizedCount }) {
  const lines = [`*回复速率统计 · ${period.label}*`, describeRules(config), ''];
  const late = stats.filter((s) => s.overdue > 0);
  const onTime = stats.length - late.length;

  if (!stats.length) {
    lines.push('这段时间没有记录到需要回复的 @ 或私聊。');
  } else if (!late.length) {
    lines.push(`没有人超时，${onTime} 人全部按时回复。`);
  } else {
    late.slice(0, MAX_RANKED_USERS).forEach((stat, i) => {
      lines.push(`${i + 1}. ${summaryLine(stat, names.get(stat.userId) ?? stat.userId)}`);
    });
    if (late.length > MAX_RANKED_USERS) lines.push(`……另有 ${late.length - MAX_RANKED_USERS} 人未列出`);
    if (onTime) lines.push('', `另有 ${onTime} 人没有超时。`);
  }

  if (dmAuthorizedCount != null) {
    lines.push('', `_私聊统计只覆盖已授权的成员及其对话，目前已授权 ${dmAuthorizedCount} 人。_`);
  }
  return lines.join('\n');
}

function permalink(teamUrl, item) {
  if (!teamUrl || item.kind !== 'mention') return null;
  const base = `${teamUrl.replace(/\/+$/, '')}/archives/${item.channel_id}/p${item.trigger_ts.replace('.', '')}`;
  return item.in_thread ? `${base}?thread_ts=${item.root_ts}&cid=${item.channel_id}` : base;
}

/** 单个成员的明细：汇总 + 最近几条超时记录。 */
export function formatUserDetail({ stat, userId, period, config, names, teamUrl }) {
  const name = names.get(userId) ?? userId;
  const lines = [`*回复速率统计 · ${name} · ${period.label}*`, describeRules(config), ''];
  if (!stat) {
    lines.push('这段时间没有记录到需要回复的 @ 或私聊。');
    return lines.join('\n');
  }
  if (!stat.overdue) {
    lines.push(`共收到 ${stat.total} 条，没有超时。`);
    return lines.join('\n');
  }

  lines.push(summaryLine(stat, name), '');
  const recent = stat.overdueItems.slice(-MAX_DETAIL_ITEMS).reverse();
  for (const item of recent) {
    const when = DateTime.fromSeconds(item.trigger_at, { zone: config.work.timezone }).toFormat('MM-dd HH:mm');
    const from = names.get(item.from_user) ?? item.from_user;
    const where = item.kind === 'dm' ? `${from} 的私聊` : `<#${item.channel_id}> 被 ${from} @`;
    const outcome = item.replied
      ? `${formatDuration(item.seconds)}后回复`
      : `至今未回复（已过 ${formatDuration(item.seconds)}）`;
    const link = permalink(teamUrl, item);
    lines.push(`• ${when} ${where} → ${outcome}${link ? ` <${link}|查看>` : ''}`);
  }
  if (stat.overdueItems.length > recent.length) {
    lines.push(`……只显示最近 ${recent.length} 条，共 ${stat.overdueItems.length} 条超时`);
  }
  return lines.join('\n');
}

/** 报表里会出现的所有用户 ID，用来批量查显示名。 */
export function userIdsIn(stats) {
  const ids = new Set();
  for (const stat of stats) {
    ids.add(stat.userId);
    for (const item of stat.overdueItems) ids.add(item.from_user);
  }
  return [...ids];
}

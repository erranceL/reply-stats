import { DateTime, IANAZone } from 'luxon';

function parseTime(value, name) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
    throw new Error(`${name} 格式应为 HH:MM，当前值：${value}`);
  }
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

function parseList(value) {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseDates(value, name) {
  const dates = parseList(value);
  const bad = dates.filter((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d) || !DateTime.fromISO(d).isValid);
  if (bad.length) throw new Error(`${name} 里的日期应为 YYYY-MM-DD，无法识别：${bad.join(', ')}`);
  return new Set(dates);
}

function parseIds(value, name, pattern) {
  const ids = parseList(value);
  const bad = ids.filter((id) => !pattern.test(id));
  if (bad.length) throw new Error(`${name} 里有无法识别的 ID：${bad.join(', ')}`);
  return ids;
}

function parseBool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export function loadConfig(env = process.env) {
  const missing = [
    'SLACK_CLIENT_ID',
    'SLACK_CLIENT_SECRET',
    'SLACK_SIGNING_SECRET',
    'PUBLIC_URL',
    'TOKEN_ENCRYPTION_KEY',
  ].filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`缺少必填环境变量：${missing.join(', ')}（参考 .env.example）`);
  }
  if (!/^[0-9a-fA-F]{64}$/.test(env.TOKEN_ENCRYPTION_KEY)) {
    throw new Error('TOKEN_ENCRYPTION_KEY 必须是 64 位十六进制字符串，可用 `openssl rand -hex 32` 生成');
  }

  const timezone = env.TIMEZONE || 'Asia/Shanghai';
  if (!IANAZone.isValidZone(timezone)) {
    throw new Error(`TIMEZONE 不是有效的时区：${timezone}`);
  }

  const thresholdMinutes = Number(env.THRESHOLD_MINUTES || 30);
  if (!(thresholdMinutes > 0)) throw new Error('THRESHOLD_MINUTES 必须大于 0');

  const workDays = parseList(env.WORK_DAYS || '1,2,3,4,5').map(Number);
  if (workDays.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
    throw new Error('WORK_DAYS 应为 1-7 的数字（1=周一，7=周日），用逗号分隔');
  }

  // 优先用 WORK_HOURS（可多段，如 10:30-12:00,14:00-17:30）；否则退回 WORK_START/WORK_END 单段
  const toMinutes = (t) => t.hour * 60 + t.minute;
  let windows;
  if (env.WORK_HOURS?.trim()) {
    windows = env.WORK_HOURS.split(',').map((part, i) => {
      const m = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(part.trim());
      if (!m) throw new Error(`WORK_HOURS 第 ${i + 1} 段格式应为 HH:MM-HH:MM，当前：${part}`);
      const start = parseTime(m[1], `WORK_HOURS[${i}].start`);
      const end = parseTime(m[2], `WORK_HOURS[${i}].end`);
      if (toMinutes(end) <= toMinutes(start)) {
        throw new Error(`WORK_HOURS 第 ${i + 1} 段的结束时间必须晚于开始时间：${part}`);
      }
      return { start, end };
    });
  } else if (env.WORK_START || env.WORK_END) {
    const start = parseTime(env.WORK_START || '09:00', 'WORK_START');
    const end = parseTime(env.WORK_END || '18:00', 'WORK_END');
    if (toMinutes(end) <= toMinutes(start)) throw new Error('WORK_END 必须晚于 WORK_START');
    windows = [{ start, end }];
  } else {
    windows = [
      { start: parseTime('10:30', 'default'), end: parseTime('12:00', 'default') },
      { start: parseTime('14:00', 'default'), end: parseTime('17:30', 'default') },
    ];
  }
  for (let i = 1; i < windows.length; i += 1) {
    if (toMinutes(windows[i].start) < toMinutes(windows[i - 1].end)) {
      throw new Error('WORK_HOURS 各时段不能重叠，且需按时间先后排列');
    }
  }

  const reportWeekday = Number(env.REPORT_WEEKDAY || 1);
  if (!Number.isInteger(reportWeekday) || reportWeekday < 1 || reportWeekday > 7) {
    throw new Error('REPORT_WEEKDAY 应为 1-7（1=周一，7=周日）');
  }

  const userId = /^[UW][A-Z0-9]+$/;
  const [teamId = ''] = parseIds(env.SLACK_TEAM_ID, 'SLACK_TEAM_ID', /^T[A-Z0-9]+$/);

  const reportChannel = (env.REPORT_CHANNEL ?? '').trim();
  if (reportChannel && !/^[CG][A-Z0-9]+$/.test(reportChannel)) {
    throw new Error(`REPORT_CHANNEL 应为频道 ID（C 开头的一串字符，不是频道名），当前值：${reportChannel}`);
  }

  return {
    port: Number(env.PORT || 3000),
    publicUrl: env.PUBLIC_URL.replace(/\/+$/, ''),
    clientId: env.SLACK_CLIENT_ID,
    clientSecret: env.SLACK_CLIENT_SECRET,
    signingSecret: env.SLACK_SIGNING_SECRET,
    tokenKey: env.TOKEN_ENCRYPTION_KEY,
    teamId,
    dbPath: env.DB_PATH || './data/reply-stats.db',

    thresholdSeconds: thresholdMinutes * 60,
    closingPhrases: parseList(env.CLOSING_PHRASES),
    work: {
      enabled: parseBool(env.WORK_HOURS_ONLY, true),
      timezone,
      windows,
      // 兼容旧字段：取第一段开始、最后一段结束（报表展示用 windows）
      start: windows[0].start,
      end: windows[windows.length - 1].end,
      days: new Set(workDays),
      holidays: parseDates(env.HOLIDAYS, 'HOLIDAYS'),
      extraWorkdays: parseDates(env.EXTRA_WORKDAYS, 'EXTRA_WORKDAYS'),
    },

    adminUsers: new Set(parseIds(env.ADMIN_USERS, 'ADMIN_USERS', userId)),
    // 不纳入统计的账号：邮箱（需 users:read.email）或直接写成员 ID
    excludeEmails: parseList(env.EXCLUDE_EMAILS || 'tony@tf.xyz,wangdana@tf.xyz').map((e) => e.toLowerCase()),
    excludeUsers: new Set(parseIds(env.EXCLUDE_USERS, 'EXCLUDE_USERS', userId)),
    reportChannel,
    reportWeekday,
    reportTime: parseTime(env.REPORT_TIME || '09:30', 'REPORT_TIME'),
    autoJoinPublicChannels: parseBool(env.AUTO_JOIN_PUBLIC_CHANNELS, false),
    command: env.SLASH_COMMAND || '/reply-stats',
  };
}

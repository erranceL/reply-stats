import bolt from '@slack/bolt';
import { createClosingMatcher } from './closing.js';
import { registerOAuthRoutes } from './oauth.js';
import {
  computeStats,
  formatRanking,
  formatUserDetail,
  parsePeriod,
  userIdsIn,
} from './report.js';
import { extractMentions } from './tracker.js';

const { App, ExpressReceiver, LogLevel } = bolt;

const USER_CACHE_SECONDS = 24 * 3600;
const TRACKED_SUBTYPES = new Set([undefined, 'file_share', 'thread_broadcast']);
const USER_ARG_RE = /^<@([UW][A-Z0-9]+)(?:\|[^>]*)?>$/;

const escapeMrkdwn = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function createSlackApp({ config, store, tracker, clock, cipher, logLevel = LogLevel.INFO }) {
  const receiver = new ExpressReceiver({
    signingSecret: config.signingSecret,
    endpoints: { events: '/slack/events', commands: '/slack/commands' },
    logLevel,
  });

  const app = new App({
    receiver,
    logLevel,
    authorize: async ({ teamId }) => {
      const team = store.getTeam(teamId);
      if (!team) throw new Error(`工作区 ${teamId} 尚未安装应用`);
      return { botToken: team.botToken, botUserId: team.botUserId, teamId };
    },
  });
  const { logger, client } = app;

  registerOAuthRoutes({ router: receiver.router, config, store, cipher, client, logger });
  receiver.router.get('/healthz', (_req, res) => res.send('ok'));

  const nowSec = () => Date.now() / 1000;
  const botToken = (teamId) => store.getTeam(teamId)?.botToken;
  const isClosing = createClosingMatcher(config.closingPhrases);

  // 排除账号：配置的成员 ID + 按邮箱查到的成员 ID
  const excludedIds = new Set(config.excludeUsers);
  const emailLookup = new Map(); // email -> userId | null（null 表示查过但没有）
  async function refreshExcluded(teamId) {
    const token = botToken(teamId);
    if (!token || !config.excludeEmails.length) return excludedIds;
    for (const email of config.excludeEmails) {
      if (emailLookup.has(email)) continue;
      try {
        const { user } = await client.users.lookupByEmail({ token, email });
        emailLookup.set(email, user.id);
        excludedIds.add(user.id);
        logger.info(`已排除统计账号 ${email}（${user.id}）`);
      } catch (err) {
        emailLookup.set(email, null);
        logger.warn(`无法按邮箱排除 ${email}：${err.data?.error ?? err.message}`);
      }
    }
    return excludedIds;
  }
  async function isExcluded(teamId, userId) {
    if (excludedIds.has(userId)) return true;
    await refreshExcluded(teamId);
    return excludedIds.has(userId);
  }

  // 同一个会话里的事件按到达顺序逐个处理完，避免“回复”抢在“被 @”之前处理而漏记。
  const queues = new Map();
  function inOrder(teamId, channel, task) {
    const key = `${teamId}:${channel}`;
    const result = (queues.get(key) ?? Promise.resolve()).then(task);
    const tail = result.catch(() => {});
    queues.set(key, tail);
    tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key);
    });
    return result;
  }

  // ---- 成员信息（带缓存） ----

  async function getUser(teamId, userId, { fresh = false } = {}) {
    const cached = store.getUser(teamId, userId);
    if (cached && !fresh && nowSec() - cached.fetchedAt < USER_CACHE_SECONDS) return cached;
    try {
      const { user } = await client.users.info({ token: botToken(teamId), user: userId });
      store.saveUser({
        teamId,
        userId,
        name: user.profile?.display_name || user.real_name || user.name,
        isBot: user.is_bot || user.id === 'USLACKBOT',
        isAdmin: user.is_admin || user.is_owner,
      });
      return store.getUser(teamId, userId);
    } catch (err) {
      logger.warn(`查询成员 ${userId} 失败：${err.message}`);
      return cached ?? { userId, name: null, isBot: false, isAdmin: false };
    }
  }

  async function resolveNames(teamId, userIds) {
    const users = await Promise.all(userIds.map((id) => getUser(teamId, id)));
    return new Map(users.map((u) => [u.userId, escapeMrkdwn(u.name || u.userId)]));
  }

  // ---- 私聊：找出对话的另一方 ----

  async function lookupDmMembers(teamId, channel, sender, body) {
    // 私聊事件是凭某位已授权成员的身份收到的，authorizations 里就是这位成员
    const auth = (body.authorizations ?? []).find((a) => !a.is_bot && a.user_id);
    if (!auth) return null;
    const token = store.getUserToken(teamId, auth.user_id);
    if (token) {
      try {
        const info = await client.conversations.info({ token, channel });
        if (info.channel?.user) return [auth.user_id, info.channel.user];
      } catch (err) {
        logger.warn(`查询私聊 ${channel} 的成员失败：${err.message}`);
      }
    }
    return auth.user_id !== sender ? [auth.user_id, sender] : null;
  }

  async function dmPartner(teamId, channel, sender, body) {
    let members = store.getDm(teamId, channel);
    if (!members) {
      members = await lookupDmMembers(teamId, channel, sender, body);
      if (!members) return null;
      store.saveDm(teamId, channel, members[0], members[1]);
    }
    if (!members.includes(sender)) return null;
    return members[0] === sender ? members[1] : members[0];
  }

  // ---- 消息事件 ----

  app.event('message', ({ event, body }) =>
    inOrder(body.team_id, event.channel, () => handleMessage(event, body)),
  );

  async function handleMessage(event, body) {
    const teamId = body.team_id;

    if (event.subtype === 'message_deleted') {
      if (event.deleted_ts) tracker.onMessageDeleted({ teamId, channel: event.channel, ts: event.deleted_ts });
      return;
    }
    if (!TRACKED_SUBTYPES.has(event.subtype) || event.bot_id || !event.user) return;
    if ((await getUser(teamId, event.user)).isBot) return;

    // 带文件的消息即使没有文字也算有内容
    const closing = !event.files?.length && isClosing(event.text);

    if (event.channel_type === 'im') {
      const other = await dmPartner(teamId, event.channel, event.user, body);
      if (!other || other === event.user) return;
      if ((await getUser(teamId, other)).isBot) return;
      tracker.onDmMessage({
        teamId,
        channel: event.channel,
        ts: event.ts,
        user: event.user,
        otherUser: other,
        closing,
        trackOther: !(await isExcluded(teamId, other)),
      });
      return;
    }

    if (event.channel_type === 'channel' || event.channel_type === 'group') {
      const mentions = [];
      for (const id of extractMentions(event.text)) {
        if (id === event.user) continue;
        if ((await getUser(teamId, id)).isBot) continue;
        if (await isExcluded(teamId, id)) continue;
        mentions.push(id);
      }
      tracker.onChannelMessage({
        teamId,
        channel: event.channel,
        ts: event.ts,
        threadTs: event.thread_ts,
        user: event.user,
        mentions,
        closing,
      });
    }
  }

  // ---- 点表情算回复 ----

  app.event('reaction_added', ({ event, body }) => {
    if (event.item?.type !== 'message' || !event.user) return;
    return inOrder(body.team_id, event.item.channel, () => {
      tracker.onReaction({
        teamId: body.team_id,
        channel: event.item.channel,
        user: event.user,
        itemTs: event.item.ts,
        itemUser: event.item_user,
        eventTs: event.event_ts,
      });
    });
  });

  // ---- 授权被撤销 / 应用被卸载 ----

  app.event('tokens_revoked', async ({ event, body }) => {
    for (const userId of event.tokens?.oauth ?? []) store.deleteUserToken(body.team_id, userId);
  });

  app.event('app_uninstalled', async ({ body }) => {
    store.deleteTeam(body.team_id);
    logger.info(`工作区 ${body.team_id} 已卸载应用，已删除保存的 token`);
  });

  // ---- 自动加入公开频道（可选） ----

  async function joinPublicChannels(teamId) {
    const token = botToken(teamId);
    let cursor;
    let joined = 0;
    do {
      const page = await client.conversations.list({
        token,
        types: 'public_channel',
        exclude_archived: true,
        limit: 200,
        cursor,
      });
      for (const channel of page.channels ?? []) {
        if (channel.is_member) continue;
        try {
          await client.conversations.join({ token, channel: channel.id });
          joined += 1;
        } catch (err) {
          logger.warn(`加入频道 #${channel.name} 失败：${err.message}`);
        }
      }
      cursor = page.response_metadata?.next_cursor;
    } while (cursor);
    if (joined) logger.info(`已加入 ${joined} 个公开频道`);
  }

  app.event('channel_created', async ({ event, body }) => {
    if (!config.autoJoinPublicChannels) return;
    await client.conversations.join({ token: botToken(body.team_id), channel: event.channel.id });
  });

  // ---- 报表 ----

  async function buildRanking(teamId, period) {
    const excludeUsers = await refreshExcluded(teamId);
    const stats = computeStats({
      store,
      clock,
      teamId,
      from: period.from,
      to: period.to,
      now: nowSec(),
      thresholdSeconds: config.thresholdSeconds,
      excludeUsers,
    });
    const names = await resolveNames(teamId, stats.map((s) => s.userId));
    return formatRanking({
      stats,
      period,
      config,
      names,
      dmAuthorizedCount: store.countUserTokens(teamId),
    });
  }

  async function buildUserDetail(teamId, userId, period) {
    const excludeUsers = await refreshExcluded(teamId);
    const stats = computeStats({
      store,
      clock,
      teamId,
      from: period.from,
      to: period.to,
      now: nowSec(),
      thresholdSeconds: config.thresholdSeconds,
      targetUser: userId,
      excludeUsers,
    });
    const names = await resolveNames(teamId, [userId, ...userIdsIn(stats)]);
    return formatUserDetail({
      stat: stats[0],
      userId,
      period,
      config,
      names,
      teamUrl: store.getTeam(teamId)?.url,
    });
  }

  /** 把某个时间范围的全员排行发到 REPORT_CHANNEL。 */
  async function sendReport(teamId, period) {
    const token = botToken(teamId);
    const message = { token, channel: config.reportChannel, text: await buildRanking(teamId, period) };
    try {
      await client.chat.postMessage(message);
    } catch (err) {
      // 公开频道可以自己加入后重发；私有频道机器人看不到，只能等人邀请
      const reason = err.data?.error;
      if (reason === 'channel_not_found') {
        throw new Error('找不到周报频道。如果是私有频道，请先在频道里输入 /invite @reply-stats 邀请机器人；否则请检查 REPORT_CHANNEL', { cause: err });
      }
      if (reason !== 'not_in_channel') throw err;
      await client.conversations.join({ token, channel: config.reportChannel });
      await client.chat.postMessage(message);
    }
  }

  // ---- 斜杠命令 ----

  function helpText() {
    return [
      `用法：\`${config.command} [时间范围] [@成员]\``,
      '时间范围：`today`、`yesterday`、`week`（默认）、`last-week`、`month`、`last-month`、`7d`、`30d`，也可以写 今天、昨天、本周、上周、本月、上月。',
      `例：\`${config.command} last-week\` 看上周全员排行，\`${config.command} month @某人\` 看某人本月明细，\`${config.command} me\` 看自己。`,
      '全员排行和他人明细只有管理员能看，其他成员只能看自己的。',
      `私聊统计需要成员本人授权一次：${config.publicUrl}/slack/authorize`,
    ].join('\n');
  }

  app.command(config.command, async ({ command, ack, respond }) => {
    await ack();
    const teamId = command.team_id;
    const reply = (text) => respond({ response_type: 'ephemeral', text });

    let period = parsePeriod(undefined, config.work.timezone, nowSec());
    let target = null;
    for (const word of command.text.trim().split(/\s+/).filter(Boolean)) {
      const userArg = USER_ARG_RE.exec(word);
      if (userArg) target = userArg[1];
      else if (['me', '我'].includes(word.toLowerCase())) target = command.user_id;
      else if (['help', '帮助'].includes(word.toLowerCase())) return reply(helpText());
      else {
        const parsed = parsePeriod(word, config.work.timezone, nowSec());
        if (!parsed) return reply(`没看懂 \`${word}\`。\n${helpText()}`);
        period = parsed;
      }
    }

    const isAdmin =
      config.adminUsers.has(command.user_id) ||
      (await getUser(teamId, command.user_id, { fresh: true })).isAdmin;
    if (!isAdmin) {
      const note =
        target && target !== command.user_id ? '只有管理员可以查看其他人的数据，下面是你自己的统计。\n\n' : '';
      return reply(note + (await buildUserDetail(teamId, command.user_id, period)));
    }
    return reply(target ? await buildUserDetail(teamId, target, period) : await buildRanking(teamId, period));
  });

  app.error(async (error) => {
    logger.error(error);
  });

  return { app, receiver, sendReport, joinPublicChannels };
}

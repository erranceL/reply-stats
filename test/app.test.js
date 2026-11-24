import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import bolt from '@slack/bolt';
import { createSlackApp } from '../src/app.js';
import { parsePeriod } from '../src/report.js';
import { TEAM, setup, ts } from './helpers.js';

// 端到端：真实的 Bolt 接收器 + 签名校验，Slack API 调用用假实现替换。

const ctx = setup({ ADMIN_USERS: 'UADMIN' });
const { config, store } = ctx;
const slack = createSlackApp({ ...ctx, logLevel: bolt.LogLevel.ERROR });
const apiCalls = [];
let server;
let baseUrl;
let responses;
let responseServer;
let responseUrl;

const people = {
  UA: { real_name: '小安' },
  UB: { real_name: '小白' },
  UADMIN: { real_name: '管理员' },
  UBOT: { real_name: '机器人', is_bot: true },
  USLOW: { real_name: '查询很慢的人' },
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

before(async () => {
  const { client } = slack.app;
  client.users.info = async ({ user }) => {
    apiCalls.push(['users.info', user]);
    if (user === 'USLOW') await sleep(200);
    return { ok: true, user: { id: user, ...people[user] } };
  };
  client.conversations.info = async ({ token, channel }) => {
    apiCalls.push(['conversations.info', token, channel]);
    return { ok: true, channel: { id: channel, is_im: true, user: 'UB' } };
  };
  client.oauth.v2.access = async (args) => {
    apiCalls.push(['oauth.v2.access', args]);
    return {
      ok: true,
      team: { id: TEAM, name: 'Acme' },
      authed_user: { id: 'UB', access_token: 'xoxp-ub', scope: 'im:history,im:read' },
    };
  };

  store.saveTeam({ teamId: TEAM, name: 'Acme', url: 'https://acme.slack.com/', botToken: 'xoxb-test', botUserId: 'UBOTSELF' });
  store.saveUserToken(TEAM, 'UA', 'xoxp-ua', 'im:history,im:read');

  server = createServer(slack.receiver.app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  responses = [];
  responseServer = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      responses.push(JSON.parse(body));
      res.end('ok');
    });
  });
  await new Promise((resolve) => responseServer.listen(0, '127.0.0.1', resolve));
  responseUrl = `http://127.0.0.1:${responseServer.address().port}/respond`;
});

after(() => {
  server.close();
  responseServer.close();
  store.close();
});

function signedPost(path, body, contentType, { secret = config.signingSecret } = {}) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
  return fetch(baseUrl + path, {
    method: 'POST',
    headers: {
      'content-type': contentType,
      'x-slack-request-timestamp': String(timestamp),
      'x-slack-signature': signature,
    },
    body,
  });
}

let eventSeq = 0;
function sendEvent(event, { authUser, ...opts } = {}) {
  const body = JSON.stringify({
    type: 'event_callback',
    team_id: TEAM,
    api_app_id: 'A1',
    event_id: `Ev${++eventSeq}`,
    event_time: Math.floor(Date.now() / 1000),
    authorizations: [
      { enterprise_id: null, team_id: TEAM, user_id: authUser ?? 'UBOTSELF', is_bot: !authUser, is_enterprise_install: false },
    ],
    event,
  });
  return signedPost('/slack/events', body, 'application/json', opts);
}

async function sendCommand(userId, text) {
  const before = responses.length;
  const body = new URLSearchParams({
    command: config.command,
    text,
    team_id: TEAM,
    user_id: userId,
    channel_id: 'C1',
    response_url: responseUrl,
    trigger_id: 'trigger',
  }).toString();
  const res = await signedPost('/slack/commands', body, 'application/x-www-form-urlencoded');
  assert.equal(res.status, 200);
  await waitFor(() => responses.length > before);
  return responses.at(-1);
}

async function waitFor(condition, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const items = () => store.listItems({ teamId: TEAM, from: 0, to: 1e12 });
// 事件是先应答后处理的，这里给处理留一点时间
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

test('签名不对的请求被拒绝', async () => {
  const res = await sendEvent(
    { type: 'message', channel: 'C1', channel_type: 'channel', user: 'UA', text: '<@UB>', ts: ts('2026-11-16 10:00') },
    { secret: 'wrong' },
  );
  assert.equal(res.status, 401);
  await settle();
  assert.equal(items().length, 0);
});

test('Slack 的 URL 验证请求能通过', async () => {
  const body = JSON.stringify({ type: 'url_verification', challenge: 'abc123' });
  const res = await signedPost('/slack/events', body, 'application/json');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /abc123/);
});

test('频道 @：记录、忽略机器人、回复后结案', async () => {
  // 机器人发的消息不算
  await sendEvent({ type: 'message', subtype: 'bot_message', bot_id: 'B1', channel: 'C1', channel_type: 'channel', text: '<@UB>', ts: ts('2026-11-16 09:50') });
  // UA 同时 @ 了 UB 和一个机器人
  const res = await sendEvent({ type: 'message', channel: 'C1', channel_type: 'channel', user: 'UA', text: '<@UB> <@UBOT> 麻烦看下', ts: ts('2026-11-16 10:00') });
  assert.equal(res.status, 200);
  await waitFor(() => items().length === 1);
  assert.equal(items()[0].target_user, 'UB');

  // 编辑消息不算回复
  await sendEvent({ type: 'message', subtype: 'message_changed', channel: 'C1', channel_type: 'channel', message: { user: 'UB', text: 'x' }, ts: ts('2026-11-16 10:20') });
  await settle();
  assert.equal(items()[0].reply_at, null);

  await sendEvent({ type: 'message', channel: 'C1', channel_type: 'channel', user: 'UB', text: '好的', ts: ts('2026-11-16 10:45') });
  await waitFor(() => items()[0].reply_at !== null);
  assert.equal(items()[0].work_seconds, 45 * 60);
  assert.equal(items().length, 1);
});

test('私聊：用授权成员的 token 查出对方，之后走缓存', async () => {
  apiCalls.length = 0;
  // UA 已授权，事件凭 UA 的身份送达；发消息的也是 UA，所以要查私聊对象
  await sendEvent(
    { type: 'message', channel: 'D1', channel_type: 'im', user: 'UA', text: '在吗', ts: ts('2026-11-16 14:00') },
    { authUser: 'UA' },
  );
  await waitFor(() => items().length === 2);
  const dm = items().find((i) => i.kind === 'dm');
  assert.equal(dm.target_user, 'UB');
  assert.equal(dm.from_user, 'UA');
  assert.deepEqual(apiCalls.filter((c) => c[0] === 'conversations.info'), [['conversations.info', 'xoxp-ua', 'D1']]);

  await sendEvent(
    { type: 'message', channel: 'D1', channel_type: 'im', user: 'UB', text: '在，你把链接发我一下', ts: ts('2026-11-16 15:00') },
    { authUser: 'UA' },
  );
  await waitFor(() => items().find((i) => i.id === dm.id).reply_at !== null);
  assert.equal(items().find((i) => i.id === dm.id).work_seconds, 60 * 60);
  assert.equal(apiCalls.filter((c) => c[0] === 'conversations.info').length, 1);
});

test('消息被删除后撤销未回复的记录', async () => {
  const mention = ts('2026-11-16 16:00');
  await sendEvent({ type: 'message', channel: 'C9', channel_type: 'channel', user: 'UA', text: '<@UB>', ts: mention });
  await waitFor(() => items().some((i) => i.channel_id === 'C9'));
  await sendEvent({ type: 'message', subtype: 'message_deleted', channel: 'C9', channel_type: 'channel', deleted_ts: mention, ts: ts('2026-11-16 16:01') });
  await waitFor(() => !items().some((i) => i.channel_id === 'C9'));
});

test('斜杠命令：管理员看全员排行，普通成员只能看自己', async () => {
  const ranking = await sendCommand('UADMIN', '30d');
  assert.equal(ranking.response_type, 'ephemeral');
  assert.match(ranking.text, /回复速率统计 · 最近 30 天/);

  const detail = await sendCommand('UADMIN', `30d <@UB|xiaobai>`);
  assert.match(detail.text, /回复速率统计 · 小白 · 最近 30 天/);

  const own = await sendCommand('UA', '30d <@UB|xiaobai>');
  assert.match(own.text, /只有管理员可以查看其他人的数据/);
  assert.match(own.text, /回复速率统计 · 小安 · 最近 30 天/);

  const help = await sendCommand('UA', 'help');
  assert.match(help.text, /用法：`\/reply-stats/);
  assert.match(help.text, /https:\/\/stats\.example\.com\/slack\/authorize/);

  const bad = await sendCommand('UA', 'nonsense');
  assert.match(bad.text, /没看懂 `nonsense`/);
});

test('收尾语和纯表情不会让对方开始计时，但能算作回复', async () => {
  // 频道：“谢谢 @UB”不记，后面真正的请求才记
  await sendEvent({ type: 'message', channel: 'CC', channel_type: 'channel', user: 'UA', text: '谢谢 <@UB> :pray:', ts: ts('2026-11-17 10:00') });
  await sendEvent({ type: 'message', channel: 'CC', channel_type: 'channel', user: 'UA', text: '<@UB> 再帮忙看下这个', ts: ts('2026-11-17 10:05') });
  await waitFor(() => items().some((i) => i.channel_id === 'CC'));
  const inChannel = items().filter((i) => i.channel_id === 'CC');
  assert.equal(inChannel.length, 1);
  assert.equal(inChannel[0].trigger_ts, ts('2026-11-17 10:05'));

  // 私聊：前面的用例里 UB 回了“在，你把链接发我一下”，UA 欠着一条。UA 说“好的，谢谢”结掉自己这条，但不让 UB 开始计时
  const open = () => items().filter((i) => i.channel_id === 'D1' && i.reply_at === null);
  assert.deepEqual(open().map((i) => i.target_user), ['UA']);
  await sendEvent(
    { type: 'message', channel: 'D1', channel_type: 'im', user: 'UA', text: '好的，谢谢！', ts: ts('2026-11-16 15:10') },
    { authUser: 'UA' },
  );
  await waitFor(() => open().length === 0);
  await settle();
  assert.equal(open().length, 0);

  // 带了文件的消息算有内容，哪怕配的文字只是“好的”，照常计时
  await sendEvent(
    { type: 'message', subtype: 'file_share', channel: 'D1', channel_type: 'im', user: 'UA', text: '好的', files: [{ id: 'F1' }], ts: ts('2026-11-16 15:20') },
    { authUser: 'UA' },
  );
  await waitFor(() => open().length === 1);
  assert.equal(open()[0].target_user, 'UB');
});

test('点表情算回复：频道里点在 @ 自己的消息上，私聊里点在对方的消息上', async () => {
  const mention = ts('2026-11-17 11:00');
  await sendEvent({ type: 'message', channel: 'CR', channel_type: 'channel', user: 'UA', text: '<@UB> 文档更新了，看一下', ts: mention });
  await waitFor(() => items().some((i) => i.channel_id === 'CR'));
  const inChannel = () => items().find((i) => i.channel_id === 'CR');

  // 点在别的消息上、或者别人点的，都不算
  await sendEvent({ type: 'reaction_added', user: 'UB', reaction: '+1', item_user: 'UA', item: { type: 'message', channel: 'CR', ts: ts('2026-11-17 09:00') }, event_ts: ts('2026-11-17 11:05') });
  await sendEvent({ type: 'reaction_added', user: 'UADMIN', reaction: '+1', item_user: 'UA', item: { type: 'message', channel: 'CR', ts: mention }, event_ts: ts('2026-11-17 11:06') });
  await settle();
  assert.equal(inChannel().reply_at, null);

  await sendEvent({ type: 'reaction_added', user: 'UB', reaction: '+1', item_user: 'UA', item: { type: 'message', channel: 'CR', ts: mention }, event_ts: ts('2026-11-17 11:20') });
  await waitFor(() => inChannel().reply_at !== null);
  assert.equal(inChannel().work_seconds, 20 * 60);

  // 私聊：上一个用例里 UA 15:20 发了文件，UB 欠着一条。UB 给这条消息点了表情
  const dm = () => items().find((i) => i.channel_id === 'D1' && i.target_user === 'UB' && i.trigger_ts === ts('2026-11-16 15:20'));
  assert.equal(dm().reply_at, null);
  await sendEvent(
    { type: 'reaction_added', user: 'UB', reaction: 'white_check_mark', item_user: 'UA', item: { type: 'message', channel: 'D1', ts: ts('2026-11-16 15:20') }, event_ts: ts('2026-11-16 16:00') },
    { authUser: 'UA' },
  );
  await waitFor(() => dm().reply_at !== null);
  assert.equal(dm().work_seconds, 40 * 60);
});

test('同一频道的事件按到达顺序处理：回复不会抢在被 @ 之前', async () => {
  // 发 @ 的人需要查询成员信息（很慢），紧跟着的回复不需要查询
  const first = sendEvent({ type: 'message', channel: 'CQ', channel_type: 'channel', user: 'USLOW', text: '<@UB> 在吗', ts: ts('2026-11-17 14:00') });
  await sleep(30);
  const second = sendEvent({ type: 'message', channel: 'CQ', channel_type: 'channel', user: 'UB', text: '在', ts: ts('2026-11-17 14:10') });
  await Promise.all([first, second]);

  await waitFor(() => items().some((i) => i.channel_id === 'CQ'));
  await settle();
  const item = items().find((i) => i.channel_id === 'CQ');
  assert.equal(item.work_seconds, 10 * 60);
});

test('周报：发到指定频道；公开频道先加入再发，私有频道没被邀请时给出明确提示', async () => {
  const reporter = createSlackApp({ ...ctx, config: { ...config, reportChannel: 'C0REPORT' }, logLevel: bolt.LogLevel.ERROR });
  const { client } = reporter.app;
  const slackError = (error) => Object.assign(new Error(error), { data: { ok: false, error } });
  const posted = [];
  const joined = [];
  let state = 'not_in_channel';
  client.users.info = slack.app.client.users.info;
  client.conversations.join = async ({ channel }) => {
    joined.push(channel);
    state = 'member';
    return { ok: true };
  };
  client.chat.postMessage = async ({ token, channel, text }) => {
    if (state !== 'member') throw slackError(state);
    posted.push({ token, channel, text });
    return { ok: true };
  };
  const period = parsePeriod('30d', config.work.timezone, Date.now() / 1000);

  await reporter.sendReport(TEAM, period);
  assert.deepEqual(joined, ['C0REPORT']);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].token, 'xoxb-test');
  assert.equal(posted[0].channel, 'C0REPORT');
  assert.match(posted[0].text, /回复速率统计 · 最近 30 天/);

  state = 'channel_not_found';
  await assert.rejects(reporter.sendReport(TEAM, period), /\/invite @reply-stats/);
  assert.equal(posted.length, 1);
});

test('OAuth：安装链接带齐权限，成员授权后保存加密的 token', async () => {
  const install = await fetch(`${baseUrl}/slack/install`, { redirect: 'manual' });
  assert.equal(install.status, 302);
  const installUrl = new URL(install.headers.get('location'));
  assert.equal(installUrl.origin + installUrl.pathname, 'https://slack.com/oauth/v2/authorize');
  assert.equal(installUrl.searchParams.get('client_id'), 'client-id');
  assert.match(installUrl.searchParams.get('scope'), /channels:history/);
  assert.match(installUrl.searchParams.get('scope'), /reactions:read/);
  assert.match(installUrl.searchParams.get('scope'), /users:read\.email/);
  assert.equal(installUrl.searchParams.get('user_scope'), 'im:history,im:read,reactions:read');
  assert.equal(installUrl.searchParams.get('team'), null);
  assert.equal(installUrl.searchParams.get('redirect_uri'), 'https://stats.example.com/slack/oauth_redirect');

  const authorize = await fetch(`${baseUrl}/slack/authorize`, { redirect: 'manual' });
  const authorizeUrl = new URL(authorize.headers.get('location'));
  assert.equal(authorizeUrl.searchParams.get('scope'), null);
  const state = authorizeUrl.searchParams.get('state');
  const cookie = authorize.headers.get('set-cookie').split(';')[0];

  // 没带 cookie（比如别人伪造的回调链接）会被拒绝
  const forged = await fetch(`${baseUrl}/slack/oauth_redirect?code=c1&state=${encodeURIComponent(state)}`);
  assert.equal(forged.status, 400);
  assert.equal(store.getUserToken(TEAM, 'UB'), null);

  const ok = await fetch(`${baseUrl}/slack/oauth_redirect?code=c1&state=${encodeURIComponent(state)}`, { headers: { cookie } });
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /授权成功/);
  assert.equal(store.getUserToken(TEAM, 'UB'), 'xoxp-ub');
  assert.equal(store.countUserTokens(TEAM), 2);
});

test('成员撤销授权后删除其 token', async () => {
  await sendEvent({ type: 'tokens_revoked', tokens: { oauth: ['UB'], bot: [] } });
  await waitFor(() => store.getUserToken(TEAM, 'UB') === null);
  assert.equal(store.getUserToken(TEAM, 'UA'), 'xoxp-ua');
});

test('设置了 SLACK_TEAM_ID 后，其他工作区的安装被拒绝并作废 token', async () => {
  const other = setup({ SLACK_TEAM_ID: 'TMINE' });
  const restricted = createSlackApp({ ...other, logLevel: bolt.LogLevel.ERROR });
  const revoked = [];
  restricted.app.client.oauth.v2.access = async () => ({
    ok: true,
    access_token: 'xoxb-stranger',
    bot_user_id: 'UBOT9',
    team: { id: 'TSTRANGER', name: 'Stranger' },
    authed_user: { id: 'U9', access_token: 'xoxp-stranger', scope: 'im:history' },
  });
  restricted.app.client.auth.revoke = async ({ token }) => {
    revoked.push(token);
    return { ok: true, revoked: true };
  };
  const restrictedServer = createServer(restricted.receiver.app);
  await new Promise((resolve) => restrictedServer.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${restrictedServer.address().port}`;

  try {
    const install = await fetch(`${url}/slack/install`, { redirect: 'manual' });
    const installUrl = new URL(install.headers.get('location'));
    assert.equal(installUrl.searchParams.get('team'), 'TMINE');

    const state = installUrl.searchParams.get('state');
    const cookie = install.headers.get('set-cookie').split(';')[0];
    const res = await fetch(`${url}/slack/oauth_redirect?code=c1&state=${encodeURIComponent(state)}`, { headers: { cookie } });
    assert.equal(res.status, 403);
    assert.match(await res.text(), /工作区不匹配/);
    assert.deepEqual(revoked, ['xoxb-stranger', 'xoxp-stranger']);
    assert.equal(other.store.getTeam('TSTRANGER'), null);
    assert.equal(other.store.getUserToken('TSTRANGER', 'U9'), null);
  } finally {
    restrictedServer.close();
    other.store.close();
  }
});

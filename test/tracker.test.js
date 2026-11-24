import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractMentions } from '../src/tracker.js';
import { TEAM, at, setup, ts } from './helpers.js';

const all = (store) => store.listItems({ teamId: TEAM, from: 0, to: 1e12 });

test('extractMentions 只取用户，去重，忽略 @here 和用户组', () => {
  assert.deepEqual(
    extractMentions('<@U1> 和 <@U2|bob> 看一下 <!here> <!subteam^S1|@dev> <@U1> <#C1|general>'),
    ['U1', 'U2'],
  );
  assert.deepEqual(extractMentions(undefined), []);
});

test('频道主区被 @，在主区回复即结案并记录时长', () => {
  const { store, tracker } = setup();
  tracker.onChannelMessage({ teamId: TEAM, channel: 'C1', ts: ts('2026-11-16 10:00'), user: 'UA', mentions: ['UB'] });
  tracker.onChannelMessage({ teamId: TEAM, channel: 'C1', ts: ts('2026-11-16 10:50'), user: 'UB' });

  const [item] = all(store);
  assert.equal(item.kind, 'mention');
  assert.equal(item.target_user, 'UB');
  assert.equal(item.from_user, 'UA');
  assert.equal(item.work_seconds, 50 * 60);
  assert.equal(item.reply_at, at('2026-11-16 10:50'));
});

test('频道主区被 @，在那条消息下开线程回复也算', () => {
  const { store, tracker } = setup();
  const mention = ts('2026-11-16 10:00');
  tracker.onChannelMessage({ teamId: TEAM, channel: 'C1', ts: mention, user: 'UA', mentions: ['UB'] });
  tracker.onChannelMessage({ teamId: TEAM, channel: 'C1', ts: ts('2026-11-16 10:10'), threadTs: mention, user: 'UB' });
  assert.equal(all(store)[0].work_seconds, 10 * 60);
});

test('线程里被 @，必须在同一线程回复才算', () => {
  const { store, tracker } = setup();
  const root = ts('2026-11-16 09:30');
  tracker.onChannelMessage({ teamId: TEAM, channel: 'C1', ts: ts('2026-11-16 10:00'), threadTs: root, user: 'UA', mentions: ['UB'] });

  tracker.onChannelMessage({ teamId: TEAM, channel: 'C1', ts: ts('2026-11-16 10:05'), user: 'UB' });
  tracker.onChannelMessage({ teamId: TEAM, channel: 'C1', ts: ts('2026-11-16 10:06'), threadTs: ts('2026-11-16 08:00'), user: 'UB' });
  assert.equal(all(store)[0].reply_at, null);

  tracker.onChannelMessage({ teamId: TEAM, channel: 'C1', ts: ts('2026-11-16 10:40'), threadTs: root, user: 'UB' });
  assert.equal(all(store)[0].work_seconds, 40 * 60);
});

test('别的频道或别人的发言不算回复', () => {
  const { store, tracker } = setup();
  tracker.onChannelMessage({ teamId: TEAM, channel: 'C1', ts: ts('2026-11-16 10:00'), user: 'UA', mentions: ['UB'] });
  tracker.onChannelMessage({ teamId: TEAM, channel: 'C2', ts: ts('2026-11-16 10:05'), user: 'UB' });
  tracker.onChannelMessage({ teamId: TEAM, channel: 'C1', ts: ts('2026-11-16 10:06'), user: 'UC' });
  assert.equal(all(store)[0].reply_at, null);
});

test('同一个人连续 @ 多次只记一条，从第一次开始计时；不同的人各记一条', () => {
  const { store, tracker } = setup();
  tracker.onChannelMessage({ teamId: TEAM, channel: 'C1', ts: ts('2026-11-16 10:00'), user: 'UA', mentions: ['UB'] });
  tracker.onChannelMessage({ teamId: TEAM, channel: 'C1', ts: ts('2026-11-16 10:20'), user: 'UA', mentions: ['UB'] });
  tracker.onChannelMessage({ teamId: TEAM, channel: 'C1', ts: ts('2026-11-16 10:30'), user: 'UC', mentions: ['UB'] });
  assert.equal(all(store).length, 2);

  tracker.onChannelMessage({ teamId: TEAM, channel: 'C1', ts: ts('2026-11-16 11:00'), user: 'UB' });
  assert.deepEqual(all(store).map((i) => i.work_seconds), [60 * 60, 30 * 60]);
});

test('一条消息 @ 多人各记一条，@ 自己不记；回复的同时 @ 别人会开新记录', () => {
  const { store, tracker } = setup();
  tracker.onChannelMessage({ teamId: TEAM, channel: 'C1', ts: ts('2026-11-16 10:00'), user: 'UA', mentions: ['UA', 'UB', 'UC'] });
  assert.deepEqual(all(store).map((i) => i.target_user).sort(), ['UB', 'UC']);

  const result = tracker.onChannelMessage({ teamId: TEAM, channel: 'C1', ts: ts('2026-11-16 10:05'), user: 'UB', mentions: ['UA'] });
  assert.deepEqual(result, { resolved: 1, created: 1 });
});

test('同一事件重复投递不会重复记录', () => {
  const { store, tracker } = setup();
  const msg = { teamId: TEAM, channel: 'C1', ts: ts('2026-11-16 10:00'), user: 'UA', mentions: ['UB'] };
  tracker.onChannelMessage(msg);
  tracker.onChannelMessage(msg);
  assert.equal(all(store).length, 1);
});

test('私聊：对方第一条未回复消息开始计时，回复后结案', () => {
  const { store, tracker } = setup();
  tracker.onDmMessage({ teamId: TEAM, channel: 'D1', ts: ts('2026-11-16 14:00'), user: 'UA', otherUser: 'UB' });
  tracker.onDmMessage({ teamId: TEAM, channel: 'D1', ts: ts('2026-11-16 14:10'), user: 'UA', otherUser: 'UB' });
  assert.equal(all(store).length, 1);

  tracker.onDmMessage({ teamId: TEAM, channel: 'D1', ts: ts('2026-11-16 15:30'), user: 'UB', otherUser: 'UA' });
  const items = all(store);
  assert.equal(items[0].kind, 'dm');
  assert.equal(items[0].target_user, 'UB');
  assert.equal(items[0].work_seconds, 90 * 60);
  // UB 的回复同时让 UA 欠一条回复
  assert.equal(items[1].target_user, 'UA');
  assert.equal(items[1].reply_at, null);
});

test('trackOther=false 时只结案、不为对方开新记录', () => {
  const { store, tracker } = setup();
  assert.deepEqual(
    tracker.onDmMessage({
      teamId: TEAM,
      channel: 'D9',
      ts: ts('2026-11-16 14:00'),
      user: 'UA',
      otherUser: 'UB',
      trackOther: false,
    }),
    { resolved: 0, created: 0 },
  );
  assert.equal(all(store).length, 0);
});

test('收尾语能结掉自己欠的回复，但不会给对方开新记录', () => {
  const { store, tracker } = setup();
  // 频道
  tracker.onChannelMessage({ teamId: TEAM, channel: 'C1', ts: ts('2026-11-16 10:00'), user: 'UA', mentions: ['UB'] });
  const result = tracker.onChannelMessage({ teamId: TEAM, channel: 'C1', ts: ts('2026-11-16 10:05'), user: 'UB', mentions: ['UA'], closing: true });
  assert.deepEqual(result, { resolved: 1, created: 0 });
  // 私聊
  tracker.onDmMessage({ teamId: TEAM, channel: 'D1', ts: ts('2026-11-16 14:00'), user: 'UA', otherUser: 'UB' });
  assert.deepEqual(
    tracker.onDmMessage({ teamId: TEAM, channel: 'D1', ts: ts('2026-11-16 14:05'), user: 'UB', otherUser: 'UA', closing: true }),
    { resolved: 1, created: 0 },
  );
  assert.deepEqual(all(store).map((i) => i.reply_at === null), [false, false]);
});

test('频道里对 @ 自己的那条消息点表情算回复，点别的消息或别人点不算', () => {
  const { store, tracker } = setup();
  const mention = ts('2026-11-16 10:00');
  tracker.onChannelMessage({ teamId: TEAM, channel: 'C1', ts: mention, user: 'UA', mentions: ['UB'] });

  const react = (user, itemTs, channel = 'C1') =>
    tracker.onReaction({ teamId: TEAM, channel, user, itemTs, itemUser: 'UA', eventTs: ts('2026-11-16 10:40') });
  assert.equal(react('UB', ts('2026-11-16 09:00')), 0);
  assert.equal(react('UC', mention), 0);
  assert.equal(react('UB', mention, 'C2'), 0);
  assert.equal(all(store)[0].reply_at, null);

  assert.equal(react('UB', mention), 1);
  assert.equal(all(store)[0].work_seconds, 40 * 60);
  assert.equal(react('UB', mention), 0);
});

test('私聊里对对方计时起点之后的消息点表情算回复，点自己的或更早的消息不算', () => {
  const { store, tracker } = setup();
  tracker.onDmMessage({ teamId: TEAM, channel: 'D1', ts: ts('2026-11-16 14:00'), user: 'UA', otherUser: 'UB' });

  const react = (itemTs, itemUser) =>
    tracker.onReaction({ teamId: TEAM, channel: 'D1', user: 'UB', itemTs, itemUser, eventTs: ts('2026-11-16 15:00') });
  assert.equal(react(ts('2026-11-16 13:00'), 'UA'), 0);
  assert.equal(react(ts('2026-11-16 14:30'), 'UB'), 0);
  assert.equal(react(ts('2026-11-16 14:30'), undefined), 0);
  assert.equal(all(store)[0].reply_at, null);

  // UA 在 14:00 之后又补了一句（14:20），UB 给这句点了表情
  assert.equal(react(ts('2026-11-16 14:20'), 'UA'), 1);
  assert.equal(all(store)[0].work_seconds, 60 * 60);
});

test('发起消息被删除后，未回复的记录撤销，已回复的保留', () => {
  const { store, tracker } = setup();
  const first = ts('2026-11-16 10:00');
  const second = ts('2026-11-16 11:00');
  tracker.onChannelMessage({ teamId: TEAM, channel: 'C1', ts: first, user: 'UA', mentions: ['UB'] });
  tracker.onChannelMessage({ teamId: TEAM, channel: 'C1', ts: ts('2026-11-16 10:05'), user: 'UB' });
  tracker.onChannelMessage({ teamId: TEAM, channel: 'C1', ts: second, user: 'UA', mentions: ['UB'] });

  assert.equal(tracker.onMessageDeleted({ teamId: TEAM, channel: 'C1', ts: second }), 1);
  assert.equal(tracker.onMessageDeleted({ teamId: TEAM, channel: 'C1', ts: first }), 0);
  assert.equal(all(store).length, 1);
});

const MENTION_RE = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

/** 取出消息文本里被 @ 的用户 ID（不含 @here、@channel 和用户组）。 */
export function extractMentions(text) {
  return [...new Set([...(text ?? '').matchAll(MENTION_RE)].map((m) => m[1]))];
}

/**
 * 跟踪规则：
 * - 频道里被 @：从被 @ 的那条消息开始计时。在线程里被 @，要在同一线程回复才算；
 *   在频道主区被 @，在主区发言或在那条消息下开线程回复都算。
 * - 私聊：对方发来第一条未回复的消息开始计时，自己在该私聊里发消息即算回复。
 * - 同一个人在同一处连续催多次，只记一条，计时起点是第一次。
 * - 收尾语（closing，如“好的”“谢谢”）可以算作回复，但不会让对方开始计时。
 * - 点表情也算回复：频道里要点在 @ 自己的那条消息上，私聊里点在对方计时起点之后的任意消息上。
 */
export function createTracker({ store, clock }) {
  function resolve(items, replyTs) {
    const replyAt = Number(replyTs);
    let resolved = 0;
    for (const item of items) {
      if (item.trigger_at >= replyAt) continue;
      store.resolveItem(
        item.id,
        replyTs,
        replyAt,
        clock.elapsed(item.trigger_at, replyAt),
        replyAt - item.trigger_at,
      );
      resolved += 1;
    }
    return resolved;
  }

  function onChannelMessage({ teamId, channel, ts, threadTs, user, mentions = [], closing = false }) {
    const inThread = Boolean(threadTs && threadTs !== ts);

    // 1. 发言人自己欠着的回复：这条消息算不算回复
    const mine = store.openItems(teamId, channel, user).filter((item) =>
      inThread ? item.root_ts === threadTs : !item.in_thread,
    );
    const resolved = resolve(mine, ts);

    // 2. 这条消息 @ 了谁：给每个人开一条待回复记录
    let created = 0;
    for (const target of closing ? [] : mentions) {
      if (target === user) continue;
      const duplicate = store
        .openItems(teamId, channel, target)
        .some(
          (item) =>
            item.from_user === user &&
            (inThread ? item.in_thread && item.root_ts === threadTs : !item.in_thread),
        );
      if (duplicate) continue;
      const inserted = store.insertItem({
        teamId,
        kind: 'mention',
        channel,
        rootTs: inThread ? threadTs : ts,
        inThread: inThread ? 1 : 0,
        triggerTs: ts,
        triggerAt: Number(ts),
        fromUser: user,
        targetUser: target,
      });
      if (inserted) created += 1;
    }
    return { resolved, created };
  }

  function onDmMessage({ teamId, channel, ts, user, otherUser, closing = false }) {
    const resolved = resolve(store.openItems(teamId, channel, user), ts);

    let created = 0;
    if (!closing && otherUser !== user && store.openItems(teamId, channel, otherUser).length === 0) {
      const inserted = store.insertItem({
        teamId,
        kind: 'dm',
        channel,
        triggerTs: ts,
        triggerAt: Number(ts),
        fromUser: user,
        targetUser: otherUser,
      });
      if (inserted) created += 1;
    }
    return { resolved, created };
  }

  /** user 给 itemUser 发的那条消息（itemTs）点了表情。返回结案的记录数。 */
  function onReaction({ teamId, channel, user, itemTs, itemUser, eventTs }) {
    const answered = store.openItems(teamId, channel, user).filter((item) =>
      item.kind === 'dm'
        ? itemUser === item.from_user && Number(itemTs) >= item.trigger_at
        : item.trigger_ts === itemTs,
    );
    return resolve(answered, eventTs);
  }

  /** 发起消息被删除时，撤销还没回复的那条记录。 */
  function onMessageDeleted({ teamId, channel, ts }) {
    return store.deleteOpenByTrigger(teamId, channel, ts);
  }

  return { onChannelMessage, onDmMessage, onReaction, onMessageDeleted };
}

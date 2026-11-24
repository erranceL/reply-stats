import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClosingMatcher } from '../src/closing.js';

const isClosing = createClosingMatcher();

function expectAll(expected, texts) {
  const wrong = texts.filter((text) => isClosing(text) !== expected);
  assert.deepEqual(wrong, [], `这些消息应该${expected ? '' : '不'}算收尾语`);
}

test('应答和致谢：可以连着说，带标点、语气词、@ 和表情', () => {
  expectAll(true, [
    '好的', '好的，谢谢！', '好滴', '好嘞~', '好的呢', '嗯嗯好的', '行', '行吧', '可以的', '也行', '都可以', '那就这样',
    '收到', '收到~', '收到，谢谢', '已收到', '知道了', '明白了', '了解', '懂了', '清楚了', '晓得了', '已阅', '看到了',
    '没问题', '没事儿', '没关系', '不客气', '不用谢', '应该的', '小事',
    '谢谢', '谢谢你', '谢谢大家', '感谢各位', '多谢老板', '非常感谢', '太感谢了', '谢谢提醒', '感谢支持', '辛苦了', '辛苦大家了', '麻烦你了',
    '好的老板', '收到领导', '明白，谢谢老师',
    '同意', '没意见', '听你的', '你定', '对', '对对对', '是的', '没错', '确实',
    '抱歉', '不好意思', '打扰了',
    '<@U123> 谢谢', '好的 :pray:', '明白，谢谢你 <@U123>',
    '1', '111', '+1', '666', '3q', '欧了', '妥了', '妥妥的',
  ]);
});

test('已经办了、正在办、稍后办', () => {
  expectAll(true, [
    '已处理', '已完成', '已发送', '已更新，谢谢', '已确认', '搞定', '搞定了', '弄好了', '改好了', '处理完了', '发你了', '看过了', '确认了',
    '在', '在的', '稍等', '稍等一下', '马上', '马上来', '在看了', '在处理了', '处理中',
    '我看看', '我看一下', '好的，我下午看一下', '收到，我马上处理', '我明天回复你', '我稍后确认一下', '我来处理', '好的我问问',
    '稍后回你', '晚点回复你',
  ]);
});

test('夸奖和告别', () => {
  expectAll(true, [
    '赞', '很棒', '太棒了', '厉害', '牛', '给力', '不错', '很好', '挺好的', '完美', '干得漂亮',
    '再见', '拜拜', '明天见', '晚安', '你先忙', '回头聊', '下班了',
  ]);
});

test('英文', () => {
  expectAll(true, [
    'OK', 'ok thanks', 'Okay, got it.', 'Thank you!', 'Thanks a lot', 'Thanks everyone!', 'Got it, thanks a lot.', 'thx', 'ty',
    'Sure', 'Sounds good', 'LGTM', 'Looks good to me', 'Noted with thanks', 'Roger that', 'Will do', 'On it', 'Done', 'Fixed, thanks',
    "You're welcome", 'No problem', 'np', 'My pleasure', 'Nice work', 'Great job!', 'Awesome', 'Makes sense', 'I see',
    'Bye', 'See you', 'Good night', 'haha ok',
  ]);
});

test('粤语和繁体', () => {
  expectAll(true, ['好嘅', '唔该晒', '收到晒', '冇问题', '謝謝', '沒問題', '瞭解，感謝']);
});

test('纯表情算收尾语', () => {
  expectAll(true, [':+1:', ':thumbsup::skin-tone-2:', '👍', '✅', '<@U123> :ok_hand:']);
});

test('不是收尾语：打招呼、提问、有实际内容', () => {
  expectAll(false, [
    '在吗', '你好', '早', '早上好', 'hi', 'Hello', '有空吗', '方便吗', '可以吗', '好了吗', '在不在',
    '好的？', '好的?', '是吧', '对吧', '真的',
    '好的，但是第二点我不太同意', '收到，另外报表什么时候给我', 'ok can you also check the report', '谢谢，顺便问一下预算批了没有',
    '文件发你了', '<https://example.com/doc>', '好'.repeat(60), '...', '', undefined,
  ]);
});

test('不是收尾语：叫人、催人、提要求（即使词很短）', () => {
  expectAll(false, [
    '<@U123>', '<@U123> ！', '？', '？？？',
    '老板', '领导', '<@U123> 老师',
    '<@U123> 看一下', '看看', '<@U123> 确认', '确认一下', '<@U123> 马上处理', '处理一下', '<@U123> 跟进', '回复一下', '安排',
    '帮忙看下', '麻烦看下', '麻烦你', '<@U123> 回我', '尽快',
  ]);
});

test('可以追加团队自己的收尾语', () => {
  assert.equal(isClosing('阔以'), false);
  assert.equal(isClosing('莫得问题'), false);

  const custom = createClosingMatcher(['阔以', '莫得问题']);
  assert.equal(custom('阔以'), true);
  assert.equal(custom('莫得问题，谢谢'), true);
  assert.equal(custom('在吗'), false);
});

test('很长的重复文本也能很快判断', () => {
  const started = Date.now();
  assert.equal(isClosing(`${'嗯'.repeat(39)}x`), false);
  assert.equal(isClosing('嗯'.repeat(5000)), false);
  assert.ok(Date.now() - started < 200);
});

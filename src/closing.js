// 收尾语词库：对方看到后不需要再回复的话。
// 一条消息只要完全由这里的词拼成（忽略 @、表情、标点、空格），就算收尾语，
// 所以“好的，谢谢”“ok thanks”“收到，我下午看一下”这类连着说的不用单独列出。
//
// 加词时注意：不要加单独出现时是在“叫人”或“提要求”的词。
// 比如“老板”“看一下”“确认”“马上处理”——“@张三 看一下”是请求，必须照常计时。
// 这类词只以“好的老板”“我看一下”“已确认”这样的完整说法收录。

const list = (text) =>
  text
    .split(/[|\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

/** 两组词两两相接，如 combine(['谢谢','感谢'], ['你','大家']) -> 谢谢你、谢谢大家、感谢你、感谢大家 */
const combine = (...groups) =>
  groups.reduce((heads, tails) => heads.flatMap((head) => tails.map((tail) => head + tail)), ['']);

const PEOPLE = list('你|您|你们|大家|各位|老板|领导|老师|老大|亲|哥|姐');

const CHINESE = [
  // 应答：好、行、可以
  ...list(`
    好|行|成|妥|稳|可以|可行|好吧|行吧|那好吧|也行|也好|也可以|也是|也对|都行|都好|都可以
    嗯|恩|哦|噢|喔|奥|昂|嗯哼|是|是的|对|对的|没错|正确|是这样|确实|的确
    欧了|欧克|噢了|要得|得嘞|得了|得令|遵命|照办|稳妥|靠谱
    同意|赞同|赞成|支持|没意见|没有意见|无异议|通过了|批了
    随便|随意|无所谓|看你|听你的|你定|你决定|你说了算|按你说的办|按你说的来|听安排
    就这样|先这样|那就这样|就这么办|就这么定了|这样就行|这样可以|这样就好
  `),
  // 知道了
  ...list(`
    收到|收|已收到|知道|明白|了解|懂|清楚|晓得|知晓|知悉|获悉|悉|阅|理解|看到|get|got
    我知道|我明白|我了解|我懂|我清楚|我看到|我收到|我记下|我记住|记下|记住
    我同意|我赞成|我支持|我没问题|我没意见|我可以|我ok|我都行|我都可以|我随便|我也是|我觉得可以|我觉得行|我觉得没问题
  `),
  // 没问题、不客气
  ...list(`
    没问题|没有问题|没啥问题|没事|没事儿|没关系|没毛病|没什么|没啥|不要紧|不碍事|无妨
    不客气|不用谢|不谢|不用客气|不必客气|别客气|客气|应该的|应该做的|小事|小事情|小意思|举手之劳
    不麻烦|不辛苦|不打扰|哪里哪里|哪里的话
  `),
  // 致谢、辛苦、抱歉
  ...list(`
    谢谢|谢|多谢|感谢|感恩|蟹蟹|非常感谢|十分感谢|万分感谢|太感谢|太谢谢|谢谢侬
    辛苦|大家辛苦|各位辛苦|麻烦了|麻烦你了|麻烦您了|麻烦大家了|麻烦各位了|有劳|有劳了|费心了|受累
    抱歉|不好意思|对不起|打扰了|见谅
  `),
  ...combine(
    list('谢谢|感谢|多谢'),
    [...PEOPLE, ...list('帮忙|帮助|支持|配合|理解|提醒|反馈|分享|告知|指点|指正|关心|关注|解答|回复|确认')],
  ),
  ...combine(list('辛苦'), list('你|您|你们|大家|各位')),
  // “好的老板”“收到领导”这类带称呼的应答（称呼不单独收录，单独喊人是在叫人）
  ...combine(list('好的|好|收到|明白|了解|知道了|可以|行|没问题|ok|嗯'), list('老板|领导|老师|老大|亲|哥|姐')),
  // 夸奖
  ...list(`
    赞|棒|很棒|真棒|厉害|牛|牛逼|牛批|强|优秀|完美|漂亮|给力|不错|很不错|真不错|相当不错
    真好|挺好|蛮好|很好|好极了|绝了|专业|高效|神速|奈斯|点赞|赞一个|为你点赞|鼓掌
    干得漂亮|干得好|做得好|做得不错|好样的|yyds|nb
  `),
  // 已经办了
  ...combine(
    ['已'],
    list(`
      处理|完成|解决|修复|更新|提交|同步|安排|确认|回复|通过|批准|审批|阅|读|看|查看|收|知|知悉|知晓|了解
      发|发送|发出|发你|转发|上传|上线|合并|部署|发布|改|修改|删除|添加|加|填|填写|签|签字|付|付款
      搞定|弄好|办|办理|办好|核实|核对|检查|测试|验证|备份|归档|关闭|记录|登记|预约|预定|订|约|下单
      创建|拉群|邀请|通知|告知|转达|反馈|跟进|对接|沟通|联系|ok
    `),
  ),
  ...combine(
    list('处理|搞定|弄|改|修|发|更新|提交|同步|解决|完成|做|办|查|看|回复|确认|合并|部署|上线|上传|安排'),
    list('了|好了|完了|过了|上了'),
  ),
  ...list('完成|搞定|好了|可以了|发你了|发给你了|发过去了|发你邮箱了|发邮箱了|发群里了|确认无误|确认没问题'),
  // 稍等、在处理
  ...list(`
    在|在的|我在|稍等|稍等下|稍等一下|等下|等一下|等等|等会|等会儿|等我下|等我一下|马上|马上来|马上好|来了|这就来
    稍后回复|稍后回复你|稍后回你|晚点回你|晚点回复你|回头回你|一会回你|等下回你|等会回你
    在看了|在处理|在处理了|处理中|正在处理|正在看|在弄了|在搞了|在改了|在查了|在跟了|跟进中|安排中
  `),
  // “我下午看一下”“我马上处理”：必须带“我”，不带主语的“马上处理”可能是在下指令
  ...combine(
    ['我'],
    ['', ...list('稍后|晚点|回头|一会|一会儿|等下|等会|等会儿|马上|现在|这就|上午|中午|下午|晚上|今天|明天|今晚|明早|下班前|有空')],
    list(`
      看|看看|看下|看一下|去看看|来看|来看看|查|查查|查下|查一下|确认|确认下|确认一下
      处理|处理下|处理一下|来处理|跟进|跟进下|跟进一下|来跟进|回复|回复你|回你|给你|发你|发给你
      弄|弄一下|来弄|搞|搞一下|来搞|改|改一下|来改|修|修一下|来修|试试|试一下|研究下|研究一下
      安排|安排一下|来安排|问问|问下|问一下|去问问|来
    `),
  ),
  // 告别
  ...list(`
    再见|拜|拜拜|88|886|回见|明天见|回头见|下次见|晚安|回头聊|回聊|改天聊|有空聊
    先忙|你先忙|您先忙|你忙|您忙|我先忙|我先下了|我下了|下班了|先下了
  `),
  // 数字和缩写：扣 1、666、3q
  ...list('1|6|3q|3x|ojbk'),
  // 粤语和繁体
  ...list(`
    好嘅|唔该|唔该晒|多谢晒|收到晒|明白晒|冇问题|冇事
    謝謝|謝|感謝|多謝|沒問題|沒事|沒關係|不客氣|瞭解|麻煩了|對|對的|沒錯|辛苦了
  `),
  // 语气词和程度词，只用来和上面的词连用（“好的呢”“太好了”“很棒”）
  ...list('的|了|啦|呢|呀|啊|哈|哒|滴|嘞|勒|咧|哇|哟|喽|咯|耶|捏|嘿|嘻|呵|太|很|挺|蛮|非常|十分|特别|那|那就'),
];

const ENGLISH = list(`
  ok|okay|okk|oki|okie|okey|k|kk|okay then|fine|all good|all set|all right|alright|right|correct|true|indeed|exactly
  yes|yep|yeah|yup|ya|yea|aye|yes sir|sure|sure thing|of course|certainly|definitely|absolutely
  agreed|agree|i agree|same|same here|sounds good|sounds great|sounds good to me|sgtm|lgtm|looks good|looks great|looks good to me
  got it|got you|gotcha|understood|i see|i understand|makes sense|make sense|fair enough
  noted|well noted|duly noted|noted with thanks|roger|roger that|copy|copy that|ack|acknowledged|received|well received
  will do|on it|done|fixed|resolved|merged|approved|shipped|sent|updated|deployed
  thanks|thank you|thank u|thanks a lot|thanks so much|thank you so much|thank you very much|thanks very much|many thanks
  thanks all|thanks everyone|thanks team|thanks guys|thanks again|thanks for the help|thanks for your help|thank you for your help
  much appreciated|appreciate it|appreciated|thx|tks|ty|tysm|tyvm|thnx|thanx|cheers
  np|no problem|no prob|no worries|not at all|you are welcome|you're welcome|welcome|yw|my pleasure|anytime|any time
  sorry|my bad|bye|bye bye|goodbye|see you|see ya|cya|ttyl|talk later|good night|gn|take care|have a good one|have a nice day
  good|good job|great job|nice work|good work|great work|well done|nice one|love it
  cool|great|nice|perfect|awesome|amazing|excellent|wonderful|fantastic|brilliant|sweet|neat
  ha|haha|lol|lmao|wow|yay|oh|ah
`);

const MAX_LENGTH = 40;
const MENTION = /<[@!][^>]*>/g;
const EMOJI = /:[a-z0-9_+'-]+:|[\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0f]/gu;
const HAS_EMOJI = new RegExp(EMOJI.source, 'u');
const FILLER = /[\p{P}\p{S}\p{Z}\s]/gu;

const squeeze = (text) => text.toLowerCase().replace(FILLER, '');

function isMadeOf(text, phrases, maxPhraseLength) {
  const reachable = [true];
  for (let end = 1; end <= text.length; end += 1) {
    reachable[end] = false;
    for (let len = 1; len <= Math.min(maxPhraseLength, end); len += 1) {
      if (reachable[end - len] && phrases.has(text.slice(end - len, end))) {
        reachable[end] = true;
        break;
      }
    }
  }
  return reachable[text.length];
}

/**
 * 返回 isClosing(text)：这条消息是不是收尾语。
 * - 整条消息只由收尾词组成（忽略 @、表情、标点），或只有表情，算收尾语；
 * - 带问号的、只有 @ 没有内容的（这是在催人），不算。
 */
export function createClosingMatcher(extraPhrases = []) {
  const phrases = new Set([...CHINESE, ...ENGLISH, ...extraPhrases].map(squeeze).filter(Boolean));
  const maxPhraseLength = Math.max(...[...phrases].map((p) => p.length));

  return function isClosing(text) {
    if (!text || /[?？]/.test(text)) return false;
    const body = text.toLowerCase().replace(MENTION, ' ');
    const words = squeeze(body.replace(EMOJI, ' '));
    if (!words) return HAS_EMOJI.test(body);
    if (words.length > MAX_LENGTH) return false;
    return isMadeOf(words, phrases, maxPhraseLength);
  };
}

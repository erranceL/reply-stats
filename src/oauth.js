import { randomBytes } from 'node:crypto';

export const BOT_SCOPES = [
  'channels:history',
  'groups:history',
  'channels:read',
  'channels:join',
  'users:read',
  'reactions:read',
  'commands',
  'chat:write',
];
// 成员授权只用到这三项：读取本人私聊的消息事件（只取时间和发送人，文本只用来当场判断是不是收尾语）、
// 查询私聊对象是谁、得知本人点了表情（点表情算回复）。
export const USER_SCOPES = ['im:history', 'im:read', 'reactions:read'];

const STATE_TTL_SECONDS = 600;
const COOKIE = 'rs_oauth';

function page(title, body) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:16px/1.6 -apple-system,system-ui,sans-serif;max-width:32rem;margin:18vh auto;padding:0 1.5rem;color:#1d1c1d}h1{font-size:1.4rem}</style>
</head><body><h1>${title}</h1><p>${body}</p></body></html>`;
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

/**
 * /slack/install    管理员安装应用（机器人权限 + 本人私聊授权）
 * /slack/authorize  普通成员只授权私聊统计
 * /slack/oauth_redirect  Slack 授权完成后的回调
 */
export function registerOAuthRoutes({ router, config, store, cipher, client, logger }) {
  const redirectUri = `${config.publicUrl}/slack/oauth_redirect`;
  const secure = config.publicUrl.startsWith('https://') ? '; Secure' : '';

  function begin(res, { withBotScopes }) {
    const nonce = randomBytes(16).toString('hex');
    const expires = Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS;
    const payload = `${nonce}.${expires}`;
    const params = new URLSearchParams({
      client_id: config.clientId,
      user_scope: USER_SCOPES.join(','),
      redirect_uri: redirectUri,
      state: `${payload}.${cipher.sign(payload)}`,
    });
    if (withBotScopes) params.set('scope', BOT_SCOPES.join(','));
    if (config.teamId) params.set('team', config.teamId);
    res.setHeader(
      'Set-Cookie',
      `${COOKIE}=${nonce}; Max-Age=${STATE_TTL_SECONDS}; Path=/slack; HttpOnly; SameSite=Lax${secure}`,
    );
    res.redirect(`https://slack.com/oauth/v2/authorize?${params}`);
  }

  function stateIsValid(req) {
    const [nonce, expires, signature] = String(req.query.state ?? '').split('.');
    if (!nonce || !expires || !signature) return false;
    if (!cipher.verify(`${nonce}.${expires}`, signature)) return false;
    if (Number(expires) < Date.now() / 1000) return false;
    return readCookie(req, COOKIE) === nonce;
  }

  router.get('/slack/install', (_req, res) => begin(res, { withBotScopes: true }));
  router.get('/slack/authorize', (_req, res) => begin(res, { withBotScopes: false }));

  router.get('/slack/oauth_redirect', async (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.query.error) {
      res.status(400).send(page('授权已取消', '你没有完成授权，可以关闭此页面，需要时重新打开授权链接。'));
      return;
    }
    if (!req.query.code || !stateIsValid(req)) {
      res.status(400).send(page('授权链接已失效', '请重新打开授权链接再试一次。'));
      return;
    }

    try {
      const result = await client.oauth.v2.access({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code: String(req.query.code),
        redirect_uri: redirectUri,
      });
      const teamId = result.team?.id;
      if (!teamId) throw new Error('Slack 返回结果里没有工作区信息');

      if (config.teamId && teamId !== config.teamId) {
        // 不是指定的工作区：不保存，并把刚拿到的 token 作废
        for (const token of [result.access_token, result.authed_user?.access_token]) {
          if (token) await client.auth.revoke({ token }).catch(() => {});
        }
        logger.warn(`拒绝了来自其他工作区 ${teamId} 的安装或授权`);
        res.status(403).send(page('工作区不匹配', '这个应用只供指定的工作区使用。'));
        return;
      }

      if (result.access_token) {
        let url = null;
        try {
          url = (await client.auth.test({ token: result.access_token })).url ?? null;
        } catch (err) {
          logger.warn(`auth.test 失败，报表里将不带消息链接：${err.message}`);
        }
        store.saveTeam({
          teamId,
          name: result.team.name,
          url,
          botToken: result.access_token,
          botUserId: result.bot_user_id,
        });
        logger.info(`应用已安装到工作区 ${result.team.name ?? teamId}`);
      }

      const user = result.authed_user;
      if (user?.access_token) {
        store.saveUserToken(teamId, user.id, user.access_token, user.scope);
        logger.info(`成员 ${user.id} 已授权私聊统计`);
      }

      if (!store.getTeam(teamId)) {
        res.send(page('授权已记录', '但应用还没有安装到工作区，请联系管理员先完成安装，之后无需再次授权。'));
        return;
      }
      res.send(page('授权成功', '可以关闭此页面了。'));
    } catch (err) {
      logger.error(`OAuth 回调失败：${err.message}`);
      res.status(500).send(page('授权失败', '服务器处理授权时出错，请稍后重试或联系管理员。'));
    }
  });
}

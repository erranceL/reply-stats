import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * 用 AES-256-GCM 加密存库的 Slack token，密钥来自 TOKEN_ENCRYPTION_KEY。
 * 签名（用于 OAuth state）用的是从它派生出来的另一把密钥，两种用途互不共用。
 */
export function createTokenCipher(hexKey) {
  const key = Buffer.from(hexKey, 'hex');
  const signingKey = createHmac('sha256', key).update('reply-stats:oauth-state').digest();

  function encrypt(plain) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64')).join('.');
  }

  function decrypt(stored) {
    const [iv, tag, body] = stored.split('.').map((s) => Buffer.from(s, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  }

  function sign(value) {
    return createHmac('sha256', signingKey).update(value).digest('base64url');
  }

  function verify(value, signature) {
    const expected = Buffer.from(sign(value));
    const actual = Buffer.from(String(signature));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  return { encrypt, decrypt, sign, verify };
}

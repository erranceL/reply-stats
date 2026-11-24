import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { createTokenCipher } from '../src/crypto.js';
import { testConfig } from './helpers.js';

test('节假日和补班日：格式正确时解析，写错时启动报错', () => {
  const config = testConfig({ HOLIDAYS: '2026-10-01, 2026-10-02', EXTRA_WORKDAYS: '2026-10-10' });
  assert.deepEqual([...config.work.holidays], ['2026-10-01', '2026-10-02']);
  assert.deepEqual([...config.work.extraWorkdays], ['2026-10-10']);

  assert.throws(() => testConfig({ HOLIDAYS: '2026-10-01,2026/10/02' }), /HOLIDAYS.*2026\/10\/02/);
  assert.throws(() => testConfig({ HOLIDAYS: '2026-10-1' }), /HOLIDAYS/);
  assert.throws(() => testConfig({ EXTRA_WORKDAYS: '2026-02-30' }), /EXTRA_WORKDAYS.*2026-02-30/);
});

test('REPORT_CHANNEL、SLACK_TEAM_ID、CLOSING_PHRASES、EXCLUDE_EMAILS 的解析和校验', () => {
  const defaults = testConfig();
  assert.equal(defaults.reportChannel, '');
  assert.equal(defaults.teamId, '');
  assert.deepEqual(defaults.closingPhrases, []);
  assert.deepEqual(defaults.excludeEmails, ['tony@tf.xyz', 'wangdana@tf.xyz']);
  assert.equal(defaults.excludeUsers.size, 0);

  const config = testConfig({ REPORT_CHANNEL: ' C012ABC ', SLACK_TEAM_ID: 'T012ABC', CLOSING_PHRASES: '阔以, 莫得问题' });
  assert.equal(config.reportChannel, 'C012ABC');
  assert.equal(config.teamId, 'T012ABC');
  assert.deepEqual(config.closingPhrases, ['阔以', '莫得问题']);

  assert.throws(() => testConfig({ REPORT_CHANNEL: '#managers' }), /REPORT_CHANNEL.*#managers/);
  assert.throws(() => testConfig({ REPORT_CHANNEL: 'U012ABC' }), /REPORT_CHANNEL/);
  assert.throws(() => testConfig({ SLACK_TEAM_ID: 'acme' }), /SLACK_TEAM_ID/);
});

test('token 加解密可往返；签名用的是派生密钥，不是加密密钥本身', () => {
  const hexKey = 'ab'.repeat(32);
  const cipher = createTokenCipher(hexKey);

  const stored = cipher.encrypt('xoxp-secret');
  assert.notEqual(stored, 'xoxp-secret');
  assert.equal(cipher.decrypt(stored), 'xoxp-secret');
  assert.throws(() => createTokenCipher('cd'.repeat(32)).decrypt(stored));

  const signature = cipher.sign('nonce.123');
  assert.equal(cipher.verify('nonce.123', signature), true);
  assert.equal(cipher.verify('nonce.124', signature), false);
  const withRawKey = createHmac('sha256', Buffer.from(hexKey, 'hex')).update('nonce.123').digest('base64url');
  assert.notEqual(signature, withRawKey);
});

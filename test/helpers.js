import { DateTime } from 'luxon';
import { loadConfig } from '../src/config.js';
import { createTokenCipher } from '../src/crypto.js';
import { openStore } from '../src/db.js';
import { createTracker } from '../src/tracker.js';
import { createWorkClock } from '../src/worktime.js';

export const ZONE = 'Asia/Shanghai';
export const TEAM = 'T1';

/** '2026-11-16 10:00' (上海时间) -> epoch 秒 */
export const at = (text) => DateTime.fromFormat(text, 'yyyy-MM-dd HH:mm', { zone: ZONE }).toSeconds();
/** 同上，但返回 Slack 的 ts 字符串 */
export const ts = (text) => `${at(text)}.000000`;

export function testConfig(overrides = {}) {
  return loadConfig({
    SLACK_CLIENT_ID: 'client-id',
    SLACK_CLIENT_SECRET: 'client-secret',
    SLACK_SIGNING_SECRET: 'signing-secret',
    PUBLIC_URL: 'https://stats.example.com/',
    TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32),
    ...overrides,
  });
}

export function setup(overrides) {
  const config = testConfig(overrides);
  const cipher = createTokenCipher(config.tokenKey);
  const store = openStore(':memory:', cipher);
  const clock = createWorkClock(config.work);
  const tracker = createTracker({ store, clock });
  return { config, cipher, store, clock, tracker };
}

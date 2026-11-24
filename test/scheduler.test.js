import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReportJob } from '../src/scheduler.js';
import { TEAM, at, setup } from './helpers.js';

const quiet = { info() {}, warn() {}, error() {} };

function makeJob(send) {
  const ctx = setup({ REPORT_CHANNEL: 'C0REPORT' });
  ctx.store.saveTeam({ teamId: TEAM, name: 'Acme', botToken: 'xoxb-test' });
  const clock = { now: at('2026-11-12 12:00') }; // 周四
  const sent = [];
  const run = createReportJob({
    config: ctx.config,
    store: ctx.store,
    logger: quiet,
    now: () => clock.now,
    sendReport: async (teamId, period) => {
      await send?.();
      sent.push(period.label);
    },
  });
  return { run, sent, clock };
}

test('第一次运行不补发；到点后发一次，同一期不重发', async () => {
  const { run, sent, clock } = makeJob();

  await run();
  assert.deepEqual(sent, []);

  clock.now = at('2026-11-16 09:29'); // 周一，还差一分钟
  await run();
  assert.deepEqual(sent, []);

  clock.now = at('2026-11-16 09:30');
  await run();
  assert.deepEqual(sent, ['过去一周（11-09 ~ 11-15）']);

  clock.now = at('2026-11-18 15:00');
  await run();
  assert.equal(sent.length, 1);

  clock.now = at('2026-11-23 09:30');
  await run();
  assert.deepEqual(sent, ['过去一周（11-09 ~ 11-15）', '过去一周（11-16 ~ 11-22）']);
});

test('上一次发送还没结束时再次触发，不会重复发送', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { run, sent, clock } = makeJob(() => gate);
  await run();
  clock.now = at('2026-11-16 09:30');

  const first = run();
  const second = run();
  const third = run();
  release();
  await Promise.all([first, second, third]);
  assert.equal(sent.length, 1);
});

test('发送失败后 30 分钟内不重试，之后补发', async () => {
  let failing = true;
  const { run, sent, clock } = makeJob(async () => {
    if (failing) throw new Error('channel_not_found');
  });
  await run();

  clock.now = at('2026-11-16 09:30');
  await run();
  assert.equal(sent.length, 0);

  failing = false;
  clock.now = at('2026-11-16 09:45');
  await run();
  assert.equal(sent.length, 0);

  clock.now = at('2026-11-16 10:01');
  await run();
  assert.deepEqual(sent, ['过去一周（11-09 ~ 11-15）']);
});

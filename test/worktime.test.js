import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorkClock } from '../src/worktime.js';
import { at, testConfig } from './helpers.js';

// 2026-11-16 是周一

test('同一个工作日内按实际分钟数计算', () => {
  const clock = createWorkClock(testConfig().work);
  assert.equal(clock.elapsed(at('2026-11-16 10:00'), at('2026-11-16 10:45')), 45 * 60);
});

test('下班后收到、第二天上班后回复，只算上班后的时间', () => {
  const clock = createWorkClock(testConfig().work);
  assert.equal(clock.elapsed(at('2026-11-16 23:00'), at('2026-11-17 09:20')), 20 * 60);
});

test('跨过下班时间：当天剩余 + 第二天已过的工作时间', () => {
  const clock = createWorkClock(testConfig().work);
  // 周一 17:30 -> 周二 10:00 = 30 分 + 60 分
  assert.equal(clock.elapsed(at('2026-11-16 17:30'), at('2026-11-17 10:00')), 90 * 60);
});

test('周末不计时', () => {
  const clock = createWorkClock(testConfig().work);
  // 周五 17:00 -> 下周一 09:30 = 60 分 + 30 分
  assert.equal(clock.elapsed(at('2026-11-20 17:00'), at('2026-11-23 09:30')), 90 * 60);
});

test('节假日不计时，调休补班日计时', () => {
  const clock = createWorkClock(
    testConfig({ HOLIDAYS: '2026-11-17', EXTRA_WORKDAYS: '2026-11-21' }).work,
  );
  // 周二放假：周一 17:00 -> 周三 09:30 = 60 + 30
  assert.equal(clock.elapsed(at('2026-11-16 17:00'), at('2026-11-18 09:30')), 90 * 60);
  // 周六补班：10:00 -> 11:00
  assert.equal(clock.elapsed(at('2026-11-21 10:00'), at('2026-11-21 11:00')), 60 * 60);
});

test('关闭工作时间模式后按实际经过时间计算', () => {
  const clock = createWorkClock(testConfig({ WORK_HOURS_ONLY: 'false' }).work);
  assert.equal(clock.elapsed(at('2026-11-16 23:00'), at('2026-11-17 09:20')), (10 * 60 + 20) * 60);
});

test('结束时间不晚于开始时间时为 0', () => {
  const clock = createWorkClock(testConfig().work);
  assert.equal(clock.elapsed(at('2026-11-16 10:00'), at('2026-11-16 10:00')), 0);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorkClock } from '../src/worktime.js';
import { at, testConfig } from './helpers.js';

// 默认：周一至周五 10:30–12:00、14:00–17:30；2026-11-16 是周一

test('上午时段内按实际分钟数计算', () => {
  const clock = createWorkClock(testConfig().work);
  assert.equal(clock.elapsed(at('2026-11-16 10:30'), at('2026-11-16 11:15')), 45 * 60);
});

test('午休不计时：上午末到下午初只算两头的工作时间', () => {
  const clock = createWorkClock(testConfig().work);
  // 11:30 -> 14:30 = 30 分（上午）+ 30 分（下午）
  assert.equal(clock.elapsed(at('2026-11-16 11:30'), at('2026-11-16 14:30')), 60 * 60);
});

test('上班前收到、上班后回复，只算上班后的时间', () => {
  const clock = createWorkClock(testConfig().work);
  assert.equal(clock.elapsed(at('2026-11-16 09:00'), at('2026-11-16 10:50')), 20 * 60);
});

test('下班后收到、第二天上班后回复，只算上班后的时间', () => {
  const clock = createWorkClock(testConfig().work);
  assert.equal(clock.elapsed(at('2026-11-16 23:00'), at('2026-11-17 10:50')), 20 * 60);
});

test('跨过下班时间：当天剩余 + 第二天已过的工作时间', () => {
  const clock = createWorkClock(testConfig().work);
  // 周一 17:00 -> 周二 11:00 = 30 分 + 30 分
  assert.equal(clock.elapsed(at('2026-11-16 17:00'), at('2026-11-17 11:00')), 60 * 60);
});

test('周末不计时', () => {
  const clock = createWorkClock(testConfig().work);
  // 周五 17:00 -> 下周一 11:00 = 30 分 + 30 分
  assert.equal(clock.elapsed(at('2026-11-20 17:00'), at('2026-11-23 11:00')), 60 * 60);
});

test('节假日不计时，调休补班日计时', () => {
  const clock = createWorkClock(
    testConfig({ HOLIDAYS: '2026-11-17', EXTRA_WORKDAYS: '2026-11-21' }).work,
  );
  // 周二放假：周一 17:00 -> 周三 11:00 = 30 + 30
  assert.equal(clock.elapsed(at('2026-11-16 17:00'), at('2026-11-18 11:00')), 60 * 60);
  // 周六补班：11:00 -> 12:00
  assert.equal(clock.elapsed(at('2026-11-21 11:00'), at('2026-11-21 12:00')), 60 * 60);
});

test('关闭工作时间模式后按实际经过时间计算', () => {
  const clock = createWorkClock(testConfig({ WORK_HOURS_ONLY: 'false' }).work);
  assert.equal(clock.elapsed(at('2026-11-16 23:00'), at('2026-11-17 09:20')), (10 * 60 + 20) * 60);
});

test('结束时间不晚于开始时间时为 0', () => {
  const clock = createWorkClock(testConfig().work);
  assert.equal(clock.elapsed(at('2026-11-16 11:00'), at('2026-11-16 11:00')), 0);
});

test('兼容旧的 WORK_START/WORK_END 单段配置', () => {
  const clock = createWorkClock(testConfig({ WORK_HOURS: '', WORK_START: '09:00', WORK_END: '18:00' }).work);
  assert.equal(clock.elapsed(at('2026-11-16 10:00'), at('2026-11-16 10:45')), 45 * 60);
});

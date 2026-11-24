import { DateTime } from 'luxon';

/**
 * 计算两个时间点之间的“有效时长”（秒）。
 * 开启工作时间模式时只累计工作日的上班时段，否则就是实际经过的时间。
 */
export function createWorkClock(work) {
  function isWorkday(day) {
    const date = day.toISODate();
    if (work.holidays.has(date)) return false;
    if (work.extraWorkdays.has(date)) return true;
    return work.days.has(day.weekday);
  }

  function elapsed(startSec, endSec) {
    if (endSec <= startSec) return 0;
    if (!work.enabled) return endSec - startSec;

    let total = 0;
    let day = DateTime.fromSeconds(startSec, { zone: work.timezone }).startOf('day');
    const last = DateTime.fromSeconds(endSec, { zone: work.timezone });
    while (day <= last) {
      if (isWorkday(day)) {
        const open = day.set(work.start).toSeconds();
        const close = day.set(work.end).toSeconds();
        const from = Math.max(open, startSec);
        const to = Math.min(close, endSec);
        if (to > from) total += to - from;
      }
      day = day.plus({ days: 1 });
    }
    return total;
  }

  return { elapsed };
}

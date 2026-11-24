import { DateTime } from 'luxon';
import { makePeriod } from './report.js';

const TICK_MS = 60_000;
const RETRY_SECONDS = 30 * 60;

/** 最近一次应当发报表的时间点，以及那份报表覆盖的 7 天。 */
export function latestSchedule(config, nowSec) {
  const now = DateTime.fromSeconds(nowSec, { zone: config.work.timezone });
  let at = now.set({ weekday: config.reportWeekday, ...config.reportTime, second: 0, millisecond: 0 });
  if (at > now) at = at.minus({ weeks: 1 });
  const end = at.startOf('day');
  return { key: at.toISODate(), period: makePeriod('过去一周', end.minus({ days: 7 }), end) };
}

/**
 * 返回一个检查函数：到了发周报的时间，就调用 sendReport 把报表发到周报频道。
 * 发送记录存在数据库里，所以服务重启不会重发；到点时服务没在运行，启动后会补发。
 * 上一次检查还没跑完时，新的检查直接跳过，避免同一份周报发两遍。
 */
export function createReportJob({ config, store, sendReport, logger, now = () => Date.now() / 1000 }) {
  const retryAt = new Map();
  let running = false;

  async function check() {
    const nowSec = now();
    const { key, period } = latestSchedule(config, nowSec);
    for (const team of store.listTeams()) {
      const metaKey = `report:${team.teamId}`;
      const last = store.getMeta(metaKey);
      if (last === key) continue;
      if (last === null) {
        // 第一次运行：从下一个周期开始发，不补发空报表
        store.setMeta(metaKey, key);
        continue;
      }
      if ((retryAt.get(team.teamId) ?? 0) > nowSec) continue;
      try {
        await sendReport(team.teamId, period);
        store.setMeta(metaKey, key);
        logger.info(`已发送周报：${period.label}`);
      } catch (err) {
        retryAt.set(team.teamId, nowSec + RETRY_SECONDS);
        logger.error(`发送周报失败，30 分钟后重试：${err.data?.error ?? err.message}`);
      }
    }
  }

  return async function run() {
    if (running) return;
    running = true;
    try {
      await check();
    } catch (err) {
      logger.error(err);
    } finally {
      running = false;
    }
  };
}

export function startScheduler(deps) {
  if (!deps.config.reportChannel) {
    deps.logger.info('未设置 REPORT_CHANNEL，不发送定时周报');
    return () => {};
  }
  const run = createReportJob(deps);
  run();
  const timer = setInterval(run, TICK_MS);
  return () => clearInterval(timer);
}

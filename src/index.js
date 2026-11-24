import { createSlackApp } from './app.js';
import { loadConfig } from './config.js';
import { createTokenCipher } from './crypto.js';
import { openStore } from './db.js';
import { startScheduler } from './scheduler.js';
import { createTracker } from './tracker.js';
import { createWorkClock } from './worktime.js';

try {
  process.loadEnvFile();
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const cipher = createTokenCipher(config.tokenKey);
const store = openStore(config.dbPath, cipher);
const clock = createWorkClock(config.work);
const tracker = createTracker({ store, clock });
const { app, sendReport, joinPublicChannels } = createSlackApp({
  config,
  store,
  tracker,
  clock,
  cipher,
});

await app.start(config.port);
app.logger.info(`服务已启动，端口 ${config.port}`);
app.logger.info(`管理员安装：${config.publicUrl}/slack/install`);
app.logger.info(`成员授权私聊统计：${config.publicUrl}/slack/authorize`);

const stopScheduler = startScheduler({ config, store, sendReport, logger: app.logger });

if (config.autoJoinPublicChannels) {
  for (const team of store.listTeams()) {
    joinPublicChannels(team.teamId).catch((err) => app.logger.error(`自动加入频道失败：${err.message}`));
  }
}

async function shutdown() {
  stopScheduler();
  await app.stop();
  store.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

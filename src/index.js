const config = require('./config');
const logger = require('./logger');
const { bot, notifyOrderResult } = require('./bot');
const { createWebhookApp } = require('./webhook');
const { startJobs, stopJobs } = require('./jobs');
const db = require('./db');
const redis = require('./db/redis');

let httpServer = null;
let isShuttingDown = false;

async function main() {
  // Global error trap — jangan biarkan satu promise rejection mematikan diam-diam
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, '[process] unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err: err.message, stack: err.stack }, '[process] uncaughtException');
    // Beri waktu logger flush sebelum exit
    setTimeout(() => process.exit(1), 500);
  });

  const app = createWebhookApp({
    onOrderSuccess: notifyOrderResult,
    onOrderFailed: (err) => logger.error({ err: err.message }, '[order] gagal diproses'),
  });

  httpServer = app.listen(config.app.port, () => {
    logger.info(`[webhook] listening on port ${config.app.port} (env=${config.env})`);
  });

  // Cron job
  startJobs({ onOrderFinalized: notifyOrderResult });

  // Graceful shutdown handler
  const shutdown = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(`[shutdown] received ${signal}, shutting down gracefully...`);

    try {
      // Hentikan cron dulu supaya tidak ada job baru
      stopJobs();
    } catch (e) {
      logger.warn({ err: e.message }, '[shutdown] stopJobs error');
    }

    try {
      await bot.stop();
      logger.info('[shutdown] bot stopped');
    } catch (e) {
      logger.warn({ err: e.message }, '[shutdown] bot.stop error');
    }

    if (httpServer) {
      await new Promise((resolve) => {
        httpServer.close((err) => {
          if (err) logger.warn({ err: err.message }, '[shutdown] http close error');
          else logger.info('[shutdown] http server closed');
          resolve();
        });
        // Force close after 8s
        setTimeout(resolve, 8000).unref();
      });
    }

    try {
      await redis.close();
      logger.info('[shutdown] redis closed');
    } catch (e) {
      logger.warn({ err: e.message }, '[shutdown] redis close error');
    }

    try {
      await db.close();
      logger.info('[shutdown] db pool closed');
    } catch (e) {
      logger.warn({ err: e.message }, '[shutdown] db close error');
    }

    logger.info('[shutdown] done, exiting');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Start bot polling (blocking — tanpa await agar tidak blokir server)
  bot.start({
    onStart: (info) => logger.info({ bot: info.username }, '[bot] Telegram bot running (long polling)'),
  }).catch((err) => {
    logger.fatal({ err: err.message }, '[bot] failed to start');
    process.exit(1);
  });
}

main().catch((err) => {
  logger.fatal({ err: err.message, stack: err.stack }, 'Gagal menjalankan aplikasi');
  process.exit(1);
});

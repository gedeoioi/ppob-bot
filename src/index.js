const config = require('./config');
const { bot, notifyOrderResult } = require('./bot');
const { createWebhookApp } = require('./webhook');
const { startJobs } = require('./jobs');

async function main() {
  const app = createWebhookApp({
    onOrderSuccess: notifyOrderResult,
    onOrderFailed: (err) => console.error('[order] gagal diproses:', err),
  });

  app.listen(config.app.port, () => {
    console.log(`[webhook] listening on port ${config.app.port}`);
  });

  // Cron job (expire order & polling status pending) - notifikasi hasilnya
  // pakai fungsi yang sama dengan webhook, supaya user tetap dapat kabar
  // walau statusnya baru final lewat polling, bukan dari callback langsung.
  startJobs({ onOrderFinalized: notifyOrderResult });

  // PENTING: bot.start() itu blocking (baru resolve kalau bot berhenti),
  // jadi JANGAN taruh kode lain setelah "await bot.start()" - tidak akan
  // pernah jalan. Kita panggil tanpa await di sini supaya webhook server
  // dan cron job di atas tetap sempat start duluan.
  bot.start().catch((err) => {
    console.error('[bot] berhenti karena error:', err);
    process.exit(1);
  });
  console.log('[bot] Telegram bot berjalan (long polling)');
}

main().catch((err) => {
  console.error('Gagal menjalankan aplikasi:', err);
  process.exit(1);
});

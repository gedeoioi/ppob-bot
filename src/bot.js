const { Bot, InlineKeyboard } = require('grammy');
const QRCode = require('qrcode');
const config = require('./config');
const db = require('./db');
const orderService = require('./services/order');

const bot = new Bot(config.telegramToken);

async function getOrCreateUser(ctx) {
  const tgId = ctx.from.id;
  const res = await db.query('SELECT * FROM users WHERE telegram_id = $1', [tgId]);
  if (res.rows.length > 0) return res.rows[0];

  const insertRes = await db.query(
    `INSERT INTO users (telegram_id, username, full_name) VALUES ($1,$2,$3) RETURNING *`,
    [tgId, ctx.from.username || null, `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim()]
  );
  return insertRes.rows[0];
}

bot.command('start', async (ctx) => {
  await getOrCreateUser(ctx);
  await ctx.reply(
    'Selamat datang! Gunakan /produk untuk lihat daftar produk, atau /riwayat untuk lihat transaksi kamu.'
  );
});

bot.command('produk', async (ctx) => {
  const res = await db.query(
    'SELECT buyer_sku_code, nama, harga_jual FROM products WHERE is_active = true ORDER BY nama LIMIT 20'
  );
  if (res.rows.length === 0) return ctx.reply('Belum ada produk tersedia.');

  const keyboard = new InlineKeyboard();
  for (const p of res.rows) {
    keyboard
      .text(`${p.nama} - Rp${Number(p.harga_jual).toLocaleString('id-ID')}`, `pilih_produk:${p.buyer_sku_code}`)
      .row();
  }
  await ctx.reply('Pilih produk:', { reply_markup: keyboard });
});

// State sederhana in-memory untuk menunggu input nomor tujuan.
// Untuk produksi skala besar, ganti dengan session store (grammy session + Redis).
const pendingInput = new Map();

bot.callbackQuery(/^pilih_produk:(.+)$/, async (ctx) => {
  const sku = ctx.match[1];
  pendingInput.set(ctx.from.id, { sku });
  await ctx.answerCallbackQuery();
  await ctx.reply('Masukkan nomor tujuan (HP/ID pelanggan):');
});

bot.on('message:text', async (ctx) => {
  const pending = pendingInput.get(ctx.from.id);
  if (!pending) return; // bukan alur input nomor tujuan, abaikan

  pendingInput.delete(ctx.from.id);
  const customerNo = ctx.message.text.trim();

  try {
    const user = await getOrCreateUser(ctx);
    const { order, qrString } = await orderService.createOrder({
      userId: user.id,
      buyerSkuCode: pending.sku,
      customerNo,
    });

    const qrImageBuffer = await QRCode.toBuffer(qrString, { width: 400 });

    await ctx.replyWithPhoto(new (require('grammy').InputFile)(qrImageBuffer), {
      caption:
        `Order dibuat!\n` +
        `Kode: ${order.ref_id}\n` +
        `Tujuan: ${customerNo}\n` +
        `Total bayar: Rp${Number(order.total_bayar).toLocaleString('id-ID')}\n\n` +
        `Silakan scan QRIS di atas. Bayar TEPAT sesuai nominal (termasuk 3 digit terakhir) ` +
        `agar sistem bisa memverifikasi otomatis. QR berlaku ${config.app.orderExpiryMinutes} menit.`,
    });
  } catch (err) {
    console.error('[bot] gagal membuat order:', err);
    await ctx.reply('Maaf, terjadi kendala saat membuat order. Silakan coba lagi.');
  }
});

bot.command('riwayat', async (ctx) => {
  const user = await getOrCreateUser(ctx);
  const res = await db.query(
    `SELECT ref_id, buyer_sku_code, total_bayar, status, created_at
     FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`,
    [user.id]
  );
  if (res.rows.length === 0) return ctx.reply('Belum ada transaksi.');

  const lines = res.rows.map(
    (o) =>
      `${o.ref_id} | ${o.buyer_sku_code} | Rp${Number(o.total_bayar).toLocaleString('id-ID')} | ${o.status}`
  );
  await ctx.reply(lines.join('\n'));
});

// Notifikasi ke user saat order akhirnya sukses/gagal (dipanggil dari webhook.js)
async function notifyOrderResult(order) {
  const userRes = await db.query('SELECT telegram_id FROM users WHERE id = $1', [order.user_id]);
  if (userRes.rows.length === 0) return;
  const telegramId = userRes.rows[0].telegram_id;

  const text =
    order.status === 'success'
      ? `✅ Transaksi ${order.ref_id} berhasil! SN: ${order.digiflazz_sn || '-'}`
      : order.status === 'failed'
      ? `❌ Transaksi ${order.ref_id} gagal. Saldo akan direfund oleh admin bila perlu.`
      : `⏳ Transaksi ${order.ref_id} sedang diproses, mohon tunggu.`;

  await bot.api.sendMessage(telegramId, text);
}

// PENTING: tanpa ini, satu error saja (misal DB sempat putus) akan mematikan
// SELURUH bot, bukan cuma gagal merespons chat yang error. grammy mewajibkan
// error handler kalau tidak mau proses ikut crash.
bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`[bot] Error saat proses update ${ctx.update.update_id}:`, err.error);
});

module.exports = { bot, notifyOrderResult };

const { Bot, InlineKeyboard, session } = require('grammy');
const QRCode = require('qrcode');
const config = require('./config');
const db = require('./db');
const orderService = require('./services/order');
const logger = require('./logger');

const bot = new Bot(config.telegramToken);

// Session per-chat di memory (grammy built-in). Dengan ini pendingInput
// survive di dalam state bot per sesi, bukan Map global mentah yang hilang
// saat restart multi-instance tetap lebih aman dari Map sebelumnya.
// Untuk multi-instance horizontal, ganti dengan storage Redis custom.
bot.use(
  session({
    initial: () => ({ pendingSku: null }),
  })
);

// --- Rate limit sederhana per user (in-memory, anti spam command) ---
const userTimestamps = new Map();
function isRateLimited(userId, minIntervalMs = 1500) {
  const last = userTimestamps.get(userId) || 0;
  if (Date.now() - last < minIntervalMs) return true;
  userTimestamps.set(userId, Date.now());
  return false;
}
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [k, v] of userTimestamps) if (v < cutoff) userTimestamps.delete(k);
}, 60_000).unref();

// Validasi nomor tujuan: 8-20 digit angka, boleh diawali 0/62
function isValidCustomerNo(s) {
  return /^[0-9]{8,20}$/.test(s.replace(/[\s\-+]/g, ''));
}

async function getOrCreateUser(ctx) {
  const tgId = ctx.from.id;
  // Cek banned sebelum buat
  const res = await db.query('SELECT * FROM users WHERE telegram_id = $1', [tgId]);
  if (res.rows.length > 0) {
    if (res.rows[0].is_banned) throw new Error('Akun kamu diblokir. Hubungi admin.');
    return res.rows[0];
  }
  try {
    const insertRes = await db.query(
      `INSERT INTO users (telegram_id, username, full_name) VALUES ($1,$2,$3) RETURNING *`,
      [tgId, ctx.from.username || null, `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim()]
    );
    return insertRes.rows[0];
  } catch (err) {
    // Race condition: dua /start bersamaan — ambil lagi
    if (err.code === '23505') {
      const r2 = await db.query('SELECT * FROM users WHERE telegram_id = $1', [tgId]);
      return r2.rows[0];
    }
    throw err;
  }
}

bot.command('start', async (ctx) => {
  if (isRateLimited(ctx.from.id, 2000)) return;
  try {
    await getOrCreateUser(ctx);
    await ctx.reply(
      'Selamat datang! Gunakan /produk untuk lihat daftar produk, atau /riwayat untuk lihat transaksi kamu.\n\nPerintah:\n/produk — daftar produk\n/riwayat — 10 transaksi terakhir\n/batal — batalkan input tertunda'
    );
  } catch (err) {
    logger.warn({ err: err.message, userId: ctx.from.id }, '[bot:start] gagal');
    await ctx.reply(err.message.includes('diblokir') ? err.message : 'Maaf, terjadi kendala. Coba lagi nanti.');
  }
});

bot.command('batal', async (ctx) => {
  ctx.session.pendingSku = null;
  await ctx.reply('Input dibatalkan. Gunakan /produk untuk mulai lagi.');
});

bot.command('produk', async (ctx) => {
  if (isRateLimited(ctx.from.id, 1500)) return ctx.reply('Pelan-pelan ya, coba lagi 1-2 detik.');
  try {
    const res = await db.query(
      'SELECT buyer_sku_code, nama, harga_jual FROM products WHERE is_active = true ORDER BY kategori, nama LIMIT 20'
    );
    if (res.rows.length === 0) return ctx.reply('Belum ada produk tersedia. Admin belum sync produk dari Digiflazz.');

    const keyboard = new InlineKeyboard();
    for (const p of res.rows) {
      keyboard
        .text(`${p.nama} - Rp${Number(p.harga_jual).toLocaleString('id-ID')}`, `pilih_produk:${p.buyer_sku_code}`)
        .row();
    }
    await ctx.reply('Pilih produk:', { reply_markup: keyboard });
  } catch (err) {
    logger.error({ err: err.message }, '[bot:produk] query gagal');
    await ctx.reply('Maaf, gagal memuat produk. Coba lagi nanti.');
  }
});

bot.callbackQuery(/^pilih_produk:(.+)$/, async (ctx) => {
  ctx.session.pendingSku = ctx.match[1];
  await ctx.answerCallbackQuery();
  await ctx.reply('Masukkan nomor tujuan (HP/ID pelanggan, 8-20 digit angka).\nKetik /batal untuk batalkan.');
});

bot.on('message:text', async (ctx, next) => {
  // Skip jika pesan adalah command
  if (ctx.message.text.startsWith('/')) return next();

  const pendingSku = ctx.session.pendingSku;
  if (!pendingSku) return; // bukan alur input nomor tujuan

  const customerNoRaw = ctx.message.text.trim();
  const customerNo = customerNoRaw.replace(/[\s\-+]/g, '');

  if (!isValidCustomerNo(customerNo)) {
    await ctx.reply('Nomor tujuan tidak valid. Masukkan 8-20 digit angka saja.\nKetik /batal untuk batalkan.');
    return;
  }

  // Konsumsi state supaya tidak kepicu lagi
  ctx.session.pendingSku = null;

  if (isRateLimited(ctx.from.id, 3000)) {
    await ctx.reply('Terlalu cepat membuat order. Tunggu 3 detik lalu ulangi /produk.');
    return;
  }

  try {
    const user = await getOrCreateUser(ctx);
    const { order, qrString } = await orderService.createOrder({
      userId: user.id,
      buyerSkuCode: pendingSku,
      customerNo,
    });

    const qrImageBuffer = await QRCode.toBuffer(qrString, { width: 400, margin: 2 });

    await ctx.replyWithPhoto({ source: qrImageBuffer }, {
      caption:
        `Order dibuat!\n` +
        `Kode: ${order.ref_id}\n` +
        `Tujuan: ${customerNo}\n` +
        `Total bayar: Rp${Number(order.total_bayar).toLocaleString('id-ID')}\n\n` +
        `Silakan scan QRIS di atas. Bayar TEPAT sesuai nominal (termasuk 3 digit terakhir) ` +
        `agar sistem verifikasi otomatis. QR berlaku ${config.app.orderExpiryMinutes} menit.`,
    });
  } catch (err) {
    logger.error({ err: err.message, userId: ctx.from.id, sku: pendingSku }, '[bot] gagal membuat order');
    const msg = err.message.includes('tidak ditemukan') ? err.message : 'Maaf, terjadi kendala saat membuat order. Silakan coba lagi.';
    await ctx.reply(msg);
  }
});

bot.command('riwayat', async (ctx) => {
  if (isRateLimited(ctx.from.id, 2000)) return;
  try {
    const user = await getOrCreateUser(ctx);
    const res = await db.query(
      `SELECT ref_id, buyer_sku_code, total_bayar, status, created_at
       FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [user.id]
    );
    if (res.rows.length === 0) return ctx.reply('Belum ada transaksi.');

    const lines = res.rows.map(
      (o) =>
        `${o.ref_id} | ${o.buyer_sku_code} | Rp${Number(o.total_bayar).toLocaleString('id-ID')} | ${o.status} | ${new Date(o.created_at).toLocaleString('id-ID')}`
    );
    await ctx.reply(lines.join('\n'));
  } catch (err) {
    logger.error({ err: err.message }, '[bot:riwayat] gagal');
    await ctx.reply('Gagal memuat riwayat. Coba lagi nanti.');
  }
});

async function notifyOrderResult(order) {
  try {
    const userRes = await db.query('SELECT telegram_id FROM users WHERE id = $1', [order.user_id]);
    if (userRes.rows.length === 0) return;
    const telegramId = userRes.rows[0].telegram_id;

    let text;
    if (order.status === 'success') {
      text = `✅ Transaksi ${order.ref_id} berhasil! SN: ${order.digiflazz_sn || '-'}`;
    } else if (order.status === 'failed') {
      text = `❌ Transaksi ${order.ref_id} gagal. Hubungi admin jika saldo perlu direfund.`;
    } else {
      text = `⏳ Transaksi ${order.ref_id} sedang diproses, mohon tunggu.`;
    }

    await bot.api.sendMessage(telegramId, text);
  } catch (err) {
    logger.error({ err: err.message, orderId: order?.id }, '[bot:notify] gagal kirim notifikasi');
  }
}

bot.catch((err) => {
  const ctx = err.ctx;
  logger.error({ err: err.error?.message || err.message, updateId: ctx?.update?.update_id }, '[bot] unhandled error');
});

module.exports = { bot, notifyOrderResult };

const { Bot, InlineKeyboard, Keyboard, session } = require('grammy');
const QRCode = require('qrcode');
const config = require('./config');
const db = require('./db');
const orderService = require('./services/order');
const logger = require('./logger');

const bot = new Bot(config.telegramToken);

// Daftarkan daftar command yang muncul di menu "/" Telegram.
// Dipanggil sekali saat bot start; gagal tidak fatal (misal token invalid saat test).
bot.api.setMyCommands([
  { command: 'start', description: '🏠 Menu utama' },
  { command: 'produk', description: '🛒 Daftar produk' },
  { command: 'kategori', description: '📂 Cari per kategori' },
  { command: 'riwayat', description: '📜 Riwayat transaksi' },
  { command: 'batal', description: '❌ Batalkan input' },
  { command: 'bantuan', description: '❓ Cara pakai bot' },
]).catch((e) => logger.warn({ err: e.message }, '[bot] setMyCommands gagal'));

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

function isValidCustomerNo(s) {
  return /^[0-9]{8,20}$/.test(s.replace(/[\s\-+]/g, ''));
}

async function getOrCreateUser(ctx) {
  const tgId = ctx.from.id;
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
    if (err.code === '23505') {
      const r2 = await db.query('SELECT * FROM users WHERE telegram_id = $1', [tgId]);
      return r2.rows[0];
    }
    throw err;
  }
}

// ── Helper: Reply Keyboard bawah (persistent) ──────────────────────
function mainKeyboard() {
  return new Keyboard()
    .text('🛒 Produk').text('📂 Kategori').row()
    .text('📜 Riwayat').text('❓ Bantuan').row()
    .resized()
    .persistent();
}

function formatRupiah(n) {
  return `Rp${Number(n).toLocaleString('id-ID')}`;
}

// ── Helper: Inline keyboard produk dengan grouping + 2 kolom + pagination ──
const PRODUK_PER_PAGE = 10;

async function sendProdukPage(ctx, page = 0) {
  const offset = page * PRODUK_PER_PAGE;
  const countRes = await db.query('SELECT COUNT(*)::int as total FROM products WHERE is_active = true');
  const total = countRes.rows[0].total;
  if (total === 0) {
    await ctx.reply('Belum ada produk tersedia. Admin belum sync produk dari Digiflazz.');
    return;
  }
  const totalPages = Math.ceil(total / PRODUK_PER_PAGE);
  // clamp
  if (page < 0) page = 0;
  if (page >= totalPages) page = totalPages - 1;

  const res = await db.query(
    'SELECT buyer_sku_code, nama, harga_jual, kategori, brand FROM products WHERE is_active = true ORDER BY kategori, nama LIMIT $1 OFFSET $2',
    [PRODUK_PER_PAGE, page * PRODUK_PER_PAGE]
  );

  // Group by kategori agar tombol terstruktur
  const groups = new Map();
  for (const p of res.rows) {
    const kat = p.kategori || 'Lainnya';
    if (!groups.has(kat)) groups.set(kat, []);
    groups.get(kat).push(p);
  }

  const keyboard = new InlineKeyboard();
  let firstGroup = true;
  for (const [kategori, items] of groups) {
    if (!firstGroup) {
      // spacer visual: header kategori sebagai tombol non-aktif
      // pakai noop agar callback diabaikan
    }
    firstGroup = false;
    // Header kategori (non-klik, tapi tetap butuh callback_data valid)
    keyboard.text(`── ${kategori} ──`, 'noop').row();

    // 2 tombol per baris
    for (let i = 0; i < items.length; i += 2) {
      const a = items[i];
      const b = items[i + 1];
      // Label singkat: nama saja, harga tampil di caption detail atau di label jika muat
      // Potong nama agar tombol tidak terlalu panjang di mobile
      const labelA = a.nama.length > 22 ? a.nama.slice(0, 20) + '…' : a.nama;
      keyboard.text(`${labelA} ${formatRupiah(a.harga_jual)}`, `pilih_produk:${a.buyer_sku_code}`);
      if (b) {
        const labelB = b.nama.length > 22 ? b.nama.slice(0, 20) + '…' : b.nama;
        keyboard.text(`${labelB} ${formatRupiah(b.harga_jual)}`, `pilih_produk:${b.buyer_sku_code}`);
      }
      keyboard.row();
    }
  }

  // Pagination row
  keyboard.row();
  if (totalPages > 1) {
    if (page > 0) keyboard.text('⬅️ Prev', `produk_page:${page - 1}`);
    keyboard.text(`📄 ${page + 1}/${totalPages}`, 'noop');
    if (page < totalPages - 1) keyboard.text('Next ➡️', `produk_page:${page + 1}`);
    keyboard.row();
  }
  keyboard.text('📂 Kategori', 'show_kategori').text('❌ Tutup', 'close_menu');

  const text =
    `🛒 *Daftar Produk* — hal ${page + 1}/${totalPages} (total ${total})\n` +
    `Pilih produk di bawah, atau /kategori untuk filter per kategori.\n` +
    `_Harga tertera sudah termasuk markup._`;

  // Jika ini dari callbackQuery (pagination), edit pesan sebelumnya, bukan kirim baru
  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
      await ctx.answerCallbackQuery();
      return;
    } catch (_) {
      // fallback ke reply baru jika edit gagal (pesan terlalu lama)
    }
  }
  await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard });
}

async function sendKategoriMenu(ctx) {
  const res = await db.query(
    "SELECT DISTINCT kategori FROM products WHERE is_active = true AND kategori IS NOT NULL AND kategori <> '' ORDER BY kategori"
  );
  if (res.rows.length === 0) return ctx.reply('Belum ada kategori.');

  const kb = new InlineKeyboard();
  for (let i = 0; i < res.rows.length; i += 2) {
    const a = res.rows[i];
    const b = res.rows[i + 1];
    kb.text(`📂 ${a.kategori}`, `kategori:${a.kategori}`);
    if (b) kb.text(`📂 ${b.kategori}`, `kategori:${b.kategori}`);
    kb.row();
  }
  kb.text('⬅️ Semua Produk', 'produk_page:0').text('❌ Tutup', 'close_menu');

  const text = '📂 *Pilih Kategori*';
  if (ctx.callbackQuery) {
    try { await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: kb }); await ctx.answerCallbackQuery(); return; } catch (_) {}
  }
  await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: kb });
}

async function sendProdukByKategori(ctx, kategori) {
  const res = await db.query(
    'SELECT buyer_sku_code, nama, harga_jual FROM products WHERE is_active = true AND kategori = $1 ORDER BY nama LIMIT 20',
    [kategori]
  );
  if (res.rows.length === 0) return ctx.reply(`Kategori "${kategori}" kosong.`);

  const kb = new InlineKeyboard();
  for (let i = 0; i < res.rows.length; i += 2) {
    const a = res.rows[i];
    const b = res.rows[i + 1];
    const la = a.nama.length > 20 ? a.nama.slice(0, 18) + '…' : a.nama;
    kb.text(`${la} ${formatRupiah(a.harga_jual)}`, `pilih_produk:${a.buyer_sku_code}`);
    if (b) {
      const lb = b.nama.length > 20 ? b.nama.slice(0, 18) + '…' : b.nama;
      kb.text(`${lb} ${formatRupiah(b.harga_jual)}`, `pilih_produk:${b.buyer_sku_code}`);
    }
    kb.row();
  }
  kb.text('⬅️ Kategori', 'show_kategori').text('⬅️ Semua', 'produk_page:0');

  const text = `📂 *${kategori}* — ${res.rows.length} produk`;
  try { await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: kb }); await ctx.answerCallbackQuery(); } catch (_) {
    await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: kb });
  }
}

// ── Commands ────────────────────────────────────────────────────────
bot.command('start', async (ctx) => {
  if (isRateLimited(ctx.from.id, 2000)) return;
  try {
    await getOrCreateUser(ctx);
    await ctx.reply(
      '👋 *Selamat datang di PPOB Bot!*\n\n' +
      'Kamu bisa beli pulsa, paket data, token listrik, dan produk PPOB lain langsung dari Telegram.\n\n' +
      '*Menu:*\n' +
      '🛒 /produk — daftar produk (dengan kategori & halaman)\n' +
      '📂 /kategori — filter produk per kategori\n' +
      '📜 /riwayat — 10 transaksi terakhir\n' +
      '❓ /bantuan — cara pakai\n' +
      '❌ /batal — batalkan input nomor tujuan\n\n' +
      'Gunakan tombol di bawah atau ketik perintah di atas.',
      { parse_mode: 'Markdown', reply_markup: mainKeyboard() }
    );
  } catch (err) {
    logger.warn({ err: err.message, userId: ctx.from.id }, '[bot:start] gagal');
    await ctx.reply(err.message.includes('diblokir') ? err.message : 'Maaf, terjadi kendala. Coba lagi nanti.');
  }
});

bot.command('bantuan', async (ctx) => {
  await ctx.reply(
    '❓ *Cara Pakai*\n\n' +
    '1. Ketik /produk atau tekan 🛒 Produk\n' +
    '2. Pilih produk (header ── Kategori ── tidak bisa diklik, pilih tombol produk di bawahnya)\n' +
    '3. Masukkan nomor tujuan (8-20 digit angka)\n' +
    '4. Scan QRIS yang dikirim bot, bayar *tepat* sesuai nominal\n' +
    '5. Bot akan proses otomatis via Digiflazz dan kirim notifikasi\n\n' +
    'Tips: pakai 📂 Kategori untuk filter, dan ⬅️/➡️ untuk ganti halaman.\n' +
    'Batalkan input kapan saja dengan /batal.',
    { parse_mode: 'Markdown', reply_markup: mainKeyboard() }
  );
});
bot.command('help', async (ctx) => ctx.reply('Gunakan /bantuan untuk panduan.'));

bot.command('batal', async (ctx) => {
  ctx.session.pendingSku = null;
  await ctx.reply('Input dibatalkan. Gunakan /produk untuk mulai lagi.', { reply_markup: mainKeyboard() });
});

bot.command('produk', async (ctx) => {
  if (isRateLimited(ctx.from.id, 1500)) return ctx.reply('Pelan-pelan ya, coba lagi 1-2 detik.');
  try { await sendProdukPage(ctx, 0); } catch (err) {
    logger.error({ err: err.message }, '[bot:produk] query gagal');
    await ctx.reply('Maaf, gagal memuat produk. Coba lagi nanti.');
  }
});

bot.command('kategori', async (ctx) => {
  if (isRateLimited(ctx.from.id, 1500)) return;
  try { await sendKategoriMenu(ctx); } catch (err) {
    logger.error({ err: err.message }, '[bot:kategori] gagal');
    await ctx.reply('Gagal memuat kategori.');
  }
});

// ── Reply keyboard hears (tombol bawah) ────────────────────────────
bot.hears('🛒 Produk', async (ctx) => {
  try { await sendProdukPage(ctx, 0); } catch (e) { logger.error({ err: e.message }, '[bot:hears Produk]'); }
});
bot.hears('📂 Kategori', async (ctx) => {
  try { await sendKategoriMenu(ctx); } catch (e) { logger.error({ err: e.message }, '[bot:hears Kategori]'); }
});
bot.hears('📜 Riwayat', async (ctx) => {
  // reuse handler riwayat
  if (isRateLimited(ctx.from.id, 2000)) return;
  try {
    const user = await getOrCreateUser(ctx);
    const res = await db.query(
      `SELECT ref_id, buyer_sku_code, total_bayar, status, created_at FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [user.id]
    );
    if (res.rows.length === 0) return ctx.reply('Belum ada transaksi.', { reply_markup: mainKeyboard() });
    const lines = res.rows.map((o) => `${o.ref_id} | ${o.buyer_sku_code} | ${formatRupiah(o.total_bayar)} | ${o.status}`);
    await ctx.reply(lines.join('\n'), { reply_markup: mainKeyboard() });
  } catch (err) { await ctx.reply('Gagal memuat riwayat.'); }
});
bot.hears('❓ Bantuan', async (ctx) => {
  await ctx.reply('Gunakan /bantuan untuk panduan lengkap.', { reply_markup: mainKeyboard() });
});

// ── Callback queries ───────────────────────────────────────────────
bot.callbackQuery('noop', async (ctx) => ctx.answerCallbackQuery());
bot.callbackQuery('close_menu', async (ctx) => {
  try { await ctx.deleteMessage(); } catch (_) { await ctx.answerCallbackQuery({ text: 'Ditutup' }); }
  await ctx.answerCallbackQuery();
});
bot.callbackQuery('show_kategori', async (ctx) => {
  await sendKategoriMenu(ctx);
});

bot.callbackQuery(/^produk_page:(\d+)$/, async (ctx) => {
  const page = parseInt(ctx.match[1], 10) || 0;
  await sendProdukPage(ctx, page);
});

bot.callbackQuery(/^kategori:(.+)$/, async (ctx) => {
  const kategori = ctx.match[1];
  await sendProdukByKategori(ctx, kategori);
});

bot.callbackQuery(/^pilih_produk:(.+)$/, async (ctx) => {
  ctx.session.pendingSku = ctx.match[1];
  await ctx.answerCallbackQuery();
  await ctx.reply('Masukkan nomor tujuan (HP/ID pelanggan, 8-20 digit angka).\nKetik /batal untuk batalkan.');
});

bot.on('message:text', async (ctx, next) => {
  if (ctx.message.text.startsWith('/')) return next();
  // Tombol reply keyboard sudah ditangani di hears di atas — jangan anggap sebagai input nomor
  if (['🛒 Produk','📂 Kategori','📜 Riwayat','❓ Bantuan'].includes(ctx.message.text.trim())) return next();

  const pendingSku = ctx.session.pendingSku;
  if (!pendingSku) return;

  const customerNoRaw = ctx.message.text.trim();
  const customerNo = customerNoRaw.replace(/[\s\-+]/g, '');

  if (!isValidCustomerNo(customerNo)) {
    await ctx.reply('Nomor tujuan tidak valid. Masukkan 8-20 digit angka saja.\nKetik /batal untuk batalkan.');
    return;
  }

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

    let qrImageBuffer = null;
    try {
      qrImageBuffer = await QRCode.toBuffer(qrString, { width: 400, margin: 2 });
    } catch (e) {
      logger.warn({ err: e.message }, '[bot] QR render gagal, fallback ke teks');
    }

    const caption =
      `Order dibuat!\n` +
      `Kode: ${order.ref_id}\n` +
      `Tujuan: ${customerNo}\n` +
      `Total bayar: ${formatRupiah(order.total_bayar)}\n\n` +
      `Silakan scan QRIS di atas. Bayar TEPAT sesuai nominal (termasuk 3 digit terakhir) ` +
      `agar sistem verifikasi otomatis. QR berlaku ${config.app.orderExpiryMinutes} menit.` +
      (config.payment.mock ? `\n\n⚠️ MODE MOCK: QR dummy tidak bisa dibayar beneran. Simulasi bayar: node scripts/test-webhook.js ${order.ref_id}` : '');

    if (qrImageBuffer) {
      const { InputFile } = require('grammy');
      try {
        await ctx.replyWithPhoto(new InputFile(qrImageBuffer, 'qris.png'), { caption, reply_markup: mainKeyboard() });
      } catch (e) {
        logger.warn({ err: e.message }, '[bot] sendPhoto gagal, fallback ke teks');
        await ctx.reply(caption + `\n\nQR string:\n\`${qrString}\``, { parse_mode: 'Markdown', reply_markup: mainKeyboard() });
      }
    } else {
      await ctx.reply(caption + `\n\nQR string:\n\`${qrString}\``, { parse_mode: 'Markdown', reply_markup: mainKeyboard() });
    }
  } catch (err) {
    logger.error({ err: err.message, userId: ctx.from.id, sku: pendingSku }, '[bot] gagal membuat order');
    const msg = err.message.includes('tidak ditemukan') ? err.message : 'Maaf, terjadi kendala saat membuat order. Silakan coba lagi.';
    await ctx.reply(msg, { reply_markup: mainKeyboard() });
  }
});

bot.command('riwayat', async (ctx) => {
  if (isRateLimited(ctx.from.id, 2000)) return;
  try {
    const user = await getOrCreateUser(ctx);
    const res = await db.query(
      `SELECT ref_id, buyer_sku_code, total_bayar, status, created_at FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [user.id]
    );
    if (res.rows.length === 0) return ctx.reply('Belum ada transaksi.', { reply_markup: mainKeyboard() });
    const lines = res.rows.map((o) => `${o.ref_id} | ${o.buyer_sku_code} | ${formatRupiah(o.total_bayar)} | ${o.status} | ${new Date(o.created_at).toLocaleString('id-ID')}`);
    await ctx.reply(lines.join('\n'), { reply_markup: mainKeyboard() });
  } catch (err) {
    logger.error({ err: err.message }, '[bot:riwayat] gagal');
    await ctx.reply('Gagal memuat riwayat. Coba lagi nanti.', { reply_markup: mainKeyboard() });
  }
});

async function notifyOrderResult(order) {
  try {
    const userRes = await db.query('SELECT telegram_id FROM users WHERE id = $1', [order.user_id]);
    if (userRes.rows.length === 0) return;
    const telegramId = userRes.rows[0].telegram_id;
    let text;
    if (order.status === 'success') text = `✅ Transaksi ${order.ref_id} berhasil! SN: ${order.digiflazz_sn || '-'}`;
    else if (order.status === 'failed') text = `❌ Transaksi ${order.ref_id} gagal. Hubungi admin jika saldo perlu direfund.`;
    else text = `⏳ Transaksi ${order.ref_id} sedang diproses, mohon tunggu.`;
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

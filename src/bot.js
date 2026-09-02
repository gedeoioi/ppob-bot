const { Bot, InlineKeyboard, Keyboard, session } = require('grammy');
const QRCode = require('qrcode');
const config = require('./config');
const db = require('./db');
const orderService = require('./services/order');
const topupService = require('./services/topup');
const balanceService = require('./services/balance');
const logger = require('./logger');

const bot = new Bot(config.telegramToken);

bot.api.setMyCommands([
  { command: 'start', description: '🏠 Menu utama' },
  { command: 'produk', description: '🛒 Daftar produk' },
  { command: 'kategori', description: '📂 Kategori' },
  { command: 'saldo', description: '💰 Cek saldo' },
  { command: 'topup', description: '➕ Topup saldo' },
  { command: 'riwayat', description: '📜 Riwayat transaksi' },
  { command: 'mutasi', description: '📒 Mutasi saldo' },
  { command: 'batal', description: '❌ Batalkan input' },
  { command: 'bantuan', description: '❓ Bantuan' },
]).catch((e) => logger.warn({ err: e.message }, '[bot] setMyCommands gagal'));

bot.use(
  session({
    initial: () => ({
      pendingSku: null,
      pendingOrder: null, // { sku, customerNo }
      awaitingTopup: false,
    }),
  })
);

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

function mainKeyboard() {
  return new Keyboard()
    .text('🛒 Produk').text('📂 Kategori').row()
    .text('💰 Saldo').text('➕ Topup').row()
    .text('📜 Riwayat').text('❓ Bantuan').row()
    .resized()
    .persistent();
}

function formatRupiah(n) {
  return `Rp${Number(n).toLocaleString('id-ID')}`;
}

function escapeMarkdown(s) {
  return String(s).replace(/([_*`\[\]])/g, '\\$&');
}

function parseRupiahInput(s) {
  // Terima "50000", "50k", "50.000", "Rp 50.000"
  let t = s.toLowerCase().replace(/rp/gi, '').replace(/\s/g, '').replace(/\./g, '').replace(/,/g, '');
  if (t.endsWith('k')) t = t.slice(0, -1) + '000';
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : NaN;
}

// ── Produk helpers ───────────────────────────────────────────────
const PRODUK_PER_PAGE = 10;

async function sendProdukPage(ctx, page = 0) {
  const countRes = await db.query('SELECT COUNT(*)::int as total FROM products WHERE is_active = true');
  const total = countRes.rows[0].total;
  if (total === 0) {
    await ctx.reply('Belum ada produk tersedia. Admin belum sync produk dari Digiflazz.');
    return;
  }
  const totalPages = Math.ceil(total / PRODUK_PER_PAGE);
  if (page < 0) page = 0;
  if (page >= totalPages) page = totalPages - 1;

  const res = await db.query(
    'SELECT buyer_sku_code, nama, harga_jual, kategori, brand FROM products WHERE is_active = true ORDER BY kategori, nama LIMIT $1 OFFSET $2',
    [PRODUK_PER_PAGE, page * PRODUK_PER_PAGE]
  );

  const groups = new Map();
  for (const p of res.rows) {
    const kat = p.kategori || 'Lainnya';
    if (!groups.has(kat)) groups.set(kat, []);
    groups.get(kat).push(p);
  }

  const keyboard = new InlineKeyboard();
  let firstGroup = true;
  for (const [kategori, items] of groups) {
    if (!firstGroup) {}
    firstGroup = false;
    keyboard.text(`── ${kategori} ──`, 'noop').row();
    for (let i = 0; i < items.length; i += 2) {
      const a = items[i];
      const b = items[i + 1];
      const labelA = a.nama.length > 22 ? a.nama.slice(0, 20) + '…' : a.nama;
      keyboard.text(`${labelA} ${formatRupiah(a.harga_jual)}`, `pilih_produk:${a.buyer_sku_code}`);
      if (b) {
        const labelB = b.nama.length > 22 ? b.nama.slice(0, 20) + '…' : b.nama;
        keyboard.text(`${labelB} ${formatRupiah(b.harga_jual)}`, `pilih_produk:${b.buyer_sku_code}`);
      }
      keyboard.row();
    }
  }

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

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
      await ctx.answerCallbackQuery();
      return;
    } catch (_) {}
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

// ── Saldo & Topup helpers ────────────────────────────────────────
async function sendSaldoInfo(ctx) {
  const user = await getOrCreateUser(ctx);
  const fresh = await db.query('SELECT saldo FROM users WHERE id = $1', [user.id]);
  const saldo = Number(fresh.rows[0].saldo);
  const mutasi = await balanceService.getMutations(user.id, 5);
  const pendingTopup = await db.query(
    `SELECT ref_id, total_bayar, status FROM topups WHERE user_id = $1 AND status = 'pending_payment' ORDER BY created_at DESC LIMIT 1`,
    [user.id]
  );

  let text = `💰 *Saldo Kamu:* ${formatRupiah(saldo)}\n`;
  if (pendingTopup.rows.length) {
    text += `\n⏳ Topup pending: ${escapeMarkdown(pendingTopup.rows[0].ref_id)} ${formatRupiah(pendingTopup.rows[0].total_bayar)} (menunggu pembayaran QRIS)`;
  }
  text += `\n\n📒 *5 Mutasi Terakhir:*\n`;
  if (mutasi.length === 0) text += '_Belum ada mutasi_';
  else {
    for (const m of mutasi) {
      const sign = m.amount > 0 ? '+' : '';
      // escape reason & description agar "_" di order_payment tidak dianggap markdown italic
      const reasonSafe = escapeMarkdown(m.reason);
      const descSafe = m.description ? ' - ' + escapeMarkdown(m.description) : '';
      text += `${new Date(m.created_at).toLocaleString('id-ID')} | ${sign}${formatRupiah(m.amount)} | ${reasonSafe}${descSafe}\n`;
    }
  }
  text += `\nGunakan /topup untuk isi saldo atau tombol ➕ Topup di bawah.`;

  const kb = new InlineKeyboard().text('➕ Topup', 'topup_menu').text('📒 Mutasi Lengkap', 'mutasi_full').row().text('❌ Tutup', 'close_menu');
  await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: kb });
}

async function sendTopupMenu(ctx) {
  const kb = new InlineKeyboard()
    .text('10K', 'topup_amount:10000').text('20K', 'topup_amount:20000').text('50K', 'topup_amount:50000').row()
    .text('100K', 'topup_amount:100000').text('200K', 'topup_amount:200000').text('500K', 'topup_amount:500000').row()
    .text('✏️ Nominal Lain', 'topup_custom').row()
    .text('💰 Cek Saldo', 'saldo_check').text('❌ Tutup', 'close_menu');
  const text = `➕ *Topup Saldo via QRIS*\n\nPilih nominal cepat di bawah atau ketik manual (contoh: 75000 atau 75k).\nMinimal ${formatRupiah(topupService.MIN_TOPUP)}, maksimal ${formatRupiah(topupService.MAX_TOPUP)}.\nQRIS berlaku ${config.app.orderExpiryMinutes} menit.`;
  if (ctx.callbackQuery) {
    try { await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: kb }); await ctx.answerCallbackQuery(); return; } catch (_) {}
  }
  await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: kb });
}

async function handleCreateTopup(ctx, amount) {
  const user = await getOrCreateUser(ctx);
  try {
    const { topup, qrString } = await topupService.createTopup({ userId: user.id, amount });
    let buf = null;
    try { buf = await QRCode.toBuffer(qrString, { width: 400, margin: 2 }); } catch (e) { logger.warn({ err: e.message }, '[bot] QR topup render gagal'); }
    const caption =
      `✅ Topup dibuat!\n` +
      `Kode: ${topup.ref_id}\n` +
      `Nominal: ${formatRupiah(topup.amount)} (kode unik ${topup.kode_unik})\n` +
      `Total bayar: ${formatRupiah(topup.total_bayar)}\n` +
      `Status: ${topup.status}\n\n` +
      `Scan QRIS di atas dan bayar *tepat* ${formatRupiah(topup.total_bayar)}. Saldo akan otomatis masuk setelah pembayaran.\n` +
      `Berlaku ${config.app.orderExpiryMinutes} menit.` +
      (config.payment.mock ? `\n\n⚠️ MODE MOCK: Simulasi bayar: node scripts/test-webhook.js ${topup.ref_id}` : '');

    if (buf) {
      const { InputFile } = require('grammy');
      try {
        await ctx.replyWithPhoto(new InputFile(buf, 'topup-qris.png'), { caption, reply_markup: mainKeyboard() });
      } catch (e) {
        await ctx.reply(caption + `\n\nQR:\n\`${qrString}\``, { parse_mode: 'Markdown', reply_markup: mainKeyboard() });
      }
    } else {
      await ctx.reply(caption + `\n\nQR:\n\`${qrString}\``, { parse_mode: 'Markdown', reply_markup: mainKeyboard() });
    }
  } catch (err) {
    logger.error({ err: err.message, userId: user.id, amount }, '[bot] createTopup gagal');
    await ctx.reply(err.message.includes('Minimal') || err.message.includes('Maksimal') ? err.message : 'Gagal membuat topup. Coba lagi nanti.', { reply_markup: mainKeyboard() });
  }
}

// ── Commands ──────────────────────────────────────────────────────
bot.command('start', async (ctx) => {
  if (isRateLimited(ctx.from.id, 2000)) return;
  try {
    const user = await getOrCreateUser(ctx);
    const fresh = await db.query('SELECT saldo FROM users WHERE id = $1', [user.id]);
    const saldo = Number(fresh.rows[0].saldo);
    await ctx.reply(
      '👋 *Selamat datang di PPOB Bot!*\n\n' +
      `💰 Saldo: ${formatRupiah(saldo)}\n\n` +
      '*Menu:*\n' +
      '🛒 /produk — daftar produk\n' +
      '📂 /kategori — filter kategori\n' +
      '💰 /saldo — cek saldo & mutasi\n' +
      '➕ /topup — isi saldo via QRIS\n' +
      '📜 /riwayat — transaksi terakhir\n' +
      '❓ /bantuan — cara pakai\n\n' +
      'Gunakan tombol di bawah.',
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
    '1. /produk → pilih produk → masukkan nomor tujuan → pilih *Bayar QRIS* atau *Bayar Saldo*\n' +
    '2. *QRIS*: scan QR, bayar tepat nominal, bot proses via Digiflazz. Jika gagal, dana otomatis refund ke saldo.\n' +
    '3. *Saldo*: potong saldo langsung, lebih cepat. Topup dulu via /topup jika saldo kurang.\n' +
    '4. /saldo — cek saldo & mutasi, /topup — isi saldo QRIS, /riwayat — histori order\n' +
    'Batalkan input kapan saja dengan /batal.',
    { parse_mode: 'Markdown', reply_markup: mainKeyboard() }
  );
});
bot.command('help', async (ctx) => ctx.reply('Gunakan /bantuan untuk panduan.'));

bot.command('batal', async (ctx) => {
  ctx.session.pendingSku = null;
  ctx.session.pendingOrder = null;
  ctx.session.awaitingTopup = false;
  await ctx.reply('Input dibatalkan.', { reply_markup: mainKeyboard() });
});

bot.command('saldo', async (ctx) => {
  if (isRateLimited(ctx.from.id, 1500)) return ctx.reply('Pelan-pelan ya.');
  try { await sendSaldoInfo(ctx); } catch (e) { logger.error({ err: e.message }, '[bot:saldo]'); await ctx.reply('Gagal memuat saldo.'); }
});

bot.command('mutasi', async (ctx) => {
  if (isRateLimited(ctx.from.id, 1500)) return;
  try {
    const user = await getOrCreateUser(ctx);
    const rows = await balanceService.getMutations(user.id, 15);
    if (rows.length === 0) return ctx.reply('Belum ada mutasi.', { reply_markup: mainKeyboard() });
    const lines = rows.map((m) => `${new Date(m.created_at).toLocaleString('id-ID')} | ${m.amount > 0 ? '+' : ''}${formatRupiah(m.amount)} | ${m.reason}`);
    await ctx.reply(lines.join('\n'), { reply_markup: mainKeyboard() });
  } catch (e) { await ctx.reply('Gagal memuat mutasi.'); }
});

bot.command('topup', async (ctx) => {
  if (isRateLimited(ctx.from.id, 1500)) return ctx.reply('Pelan-pelan ya.');
  try { await sendTopupMenu(ctx); } catch (e) { logger.error({ err: e.message }, '[bot:topup]'); await ctx.reply('Gagal memuat menu topup.'); }
});

bot.command('produk', async (ctx) => {
  if (isRateLimited(ctx.from.id, 1500)) return ctx.reply('Pelan-pelan ya, coba lagi 1-2 detik.');
  try { await sendProdukPage(ctx, 0); } catch (err) {
    logger.error({ err: err.message }, '[bot:produk] query gagal');
    await ctx.reply('Maaf, gagal memuat produk.');
  }
});

bot.command('kategori', async (ctx) => {
  if (isRateLimited(ctx.from.id, 1500)) return;
  try { await sendKategoriMenu(ctx); } catch (err) { await ctx.reply('Gagal memuat kategori.'); }
});

// ── Reply keyboard hears ──────────────────────────────────────────
bot.hears('🛒 Produk', async (ctx) => { try { await sendProdukPage(ctx, 0); } catch (e) {} });
bot.hears('📂 Kategori', async (ctx) => { try { await sendKategoriMenu(ctx); } catch (e) {} });
bot.hears('💰 Saldo', async (ctx) => { try { await sendSaldoInfo(ctx); } catch (e) {} });
bot.hears('➕ Topup', async (ctx) => { try { await sendTopupMenu(ctx); } catch (e) {} });
bot.hears('📜 Riwayat', async (ctx) => {
  if (isRateLimited(ctx.from.id, 2000)) return;
  try {
    const user = await getOrCreateUser(ctx);
    const res = await db.query(`SELECT ref_id, buyer_sku_code, total_bayar, status, created_at FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`, [user.id]);
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
bot.callbackQuery('show_kategori', async (ctx) => { await sendKategoriMenu(ctx); });
bot.callbackQuery('topup_menu', async (ctx) => { await sendTopupMenu(ctx); });
bot.callbackQuery('saldo_check', async (ctx) => {
  await ctx.answerCallbackQuery();
  await sendSaldoInfo(ctx);
});
bot.callbackQuery('mutasi_full', async (ctx) => {
  await ctx.answerCallbackQuery();
  const user = await getOrCreateUser(ctx);
  const rows = await balanceService.getMutations(user.id, 15);
  if (rows.length === 0) return ctx.reply('Belum ada mutasi.');
  const lines = rows.map((m) => `${new Date(m.created_at).toLocaleString('id-ID')} | ${m.amount > 0 ? '+' : ''}${formatRupiah(m.amount)} | ${m.reason}`);
  await ctx.reply(lines.join('\n'));
});

bot.callbackQuery(/^produk_page:(\d+)$/, async (ctx) => {
  const page = parseInt(ctx.match[1], 10) || 0;
  await sendProdukPage(ctx, page);
});

bot.callbackQuery(/^kategori:(.+)$/, async (ctx) => {
  await sendProdukByKategori(ctx, ctx.match[1]);
});

bot.callbackQuery(/^topup_amount:(\d+)$/, async (ctx) => {
  const amount = parseInt(ctx.match[1], 10);
  await ctx.answerCallbackQuery();
  await handleCreateTopup(ctx, amount);
});

bot.callbackQuery('topup_custom', async (ctx) => {
  ctx.session.awaitingTopup = true;
  await ctx.answerCallbackQuery();
  await ctx.reply('Ketik nominal topup (contoh: 50000 atau 50k). Minimal ' + formatRupiah(topupService.MIN_TOPUP) + '. Ketik /batal untuk batalkan.');
});

bot.callbackQuery(/^pilih_produk:(.+)$/, async (ctx) => {
  ctx.session.pendingSku = ctx.match[1];
  ctx.session.pendingOrder = null;
  await ctx.answerCallbackQuery();
  await ctx.reply('Masukkan nomor tujuan (HP/ID pelanggan, 8-20 digit angka).\nKetik /batal untuk batalkan.');
});

// Pilihan metode bayar setelah input nomor
async function sendPaymentChoice(ctx, sku, customerNo) {
  const user = await getOrCreateUser(ctx);
  const prodRes = await db.query('SELECT nama, harga_jual FROM products WHERE buyer_sku_code = $1', [sku]);
  const nama = prodRes.rows[0]?.nama || sku;
  const harga = prodRes.rows[0] ? Number(prodRes.rows[0].harga_jual) : null;
  const saldoRow = await db.query('SELECT saldo FROM users WHERE id = $1', [user.id]);
  const saldo = Number(saldoRow.rows[0].saldo);
  const kb = new InlineKeyboard()
    .text('💳 Bayar QRIS', 'pay_qris').text('💰 Bayar Saldo', 'pay_saldo').row()
    .text('❌ Batal', 'pay_cancel');
  const text =
    `📦 *Konfirmasi Pesanan*\n` +
    `Produk: ${nama} (${sku})\n` +
    `Tujuan: ${customerNo}\n` +
    (harga != null ? `Harga: ${formatRupiah(harga)}\n` : '') +
    `Saldo kamu: ${formatRupiah(saldo)}\n\n` +
    `Pilih metode pembayaran:`;
  await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: kb });
}

bot.callbackQuery('pay_qris', async (ctx) => {
  const pending = ctx.session.pendingOrder;
  if (!pending) { await ctx.answerCallbackQuery({ text: 'Pesanan tidak ditemukan, ulangi /produk' }); return; }
  ctx.session.pendingOrder = null;
  await ctx.answerCallbackQuery();
  const { sku, customerNo } = pending;
  if (isRateLimited(ctx.from.id, 3000)) { await ctx.reply('Terlalu cepat, tunggu 3 detik.'); return; }
  try {
    const user = await getOrCreateUser(ctx);
    const { order, qrString } = await orderService.createOrder({ userId: user.id, buyerSkuCode: sku, customerNo });
    let buf = null;
    try { buf = await QRCode.toBuffer(qrString, { width: 400, margin: 2 }); } catch (e) { logger.warn({ err: e.message }, '[bot] QR render gagal'); }
    const caption =
      `Order dibuat!\nKode: ${order.ref_id}\nTujuan: ${customerNo}\nTotal bayar: ${formatRupiah(order.total_bayar)}\n\n` +
      `Scan QRIS di atas. Bayar TEPAT sesuai nominal agar verifikasi otomatis. QR berlaku ${config.app.orderExpiryMinutes} menit.` +
      (config.payment.mock ? `\n\n⚠️ MODE MOCK: node scripts/test-webhook.js ${order.ref_id}` : '');
    if (buf) {
      const { InputFile } = require('grammy');
      try { await ctx.replyWithPhoto(new InputFile(buf, 'qris.png'), { caption, reply_markup: mainKeyboard() }); }
      catch (e) { await ctx.reply(caption + `\n\nQR:\n\`${qrString}\``, { parse_mode: 'Markdown', reply_markup: mainKeyboard() }); }
    } else {
      await ctx.reply(caption + `\n\nQR:\n\`${qrString}\``, { parse_mode: 'Markdown', reply_markup: mainKeyboard() });
    }
  } catch (err) {
    logger.error({ err: err.message, userId: ctx.from.id, sku }, '[bot] gagal order QRIS');
    await ctx.reply(err.message.includes('tidak ditemukan') ? err.message : 'Maaf, terjadi kendala saat membuat order. Coba lagi.', { reply_markup: mainKeyboard() });
  }
});

bot.callbackQuery('pay_saldo', async (ctx) => {
  const pending = ctx.session.pendingOrder;
  if (!pending) { await ctx.answerCallbackQuery({ text: 'Pesanan tidak ditemukan' }); return; }
  ctx.session.pendingOrder = null;
  await ctx.answerCallbackQuery();
  const { sku, customerNo } = pending;
  if (isRateLimited(ctx.from.id, 3000)) { await ctx.reply('Terlalu cepat, tunggu 3 detik.'); return; }
  try {
    const user = await getOrCreateUser(ctx);
    const { order, digiflazzResult } = await orderService.createOrderViaSaldo({ userId: user.id, buyerSkuCode: sku, customerNo });
    const status = order.status;
    const saldoRow = await db.query('SELECT saldo FROM users WHERE id = $1', [user.id]);
    const saldoNow = Number(saldoRow.rows[0].saldo);
    if (status === 'success') {
      await ctx.reply(`✅ Transaksi via saldo berhasil!\nKode: ${order.ref_id}\nSN: ${order.digiflazz_sn || '-'}\nSaldo sekarang: ${formatRupiah(saldoNow)}`, { reply_markup: mainKeyboard() });
    } else if (status === 'failed') {
      // Sudah auto-refund di applyDigiflazzResult, saldo kembali
      const refundNote = order.refunded ? `\nDana ${formatRupiah(order.total_bayar)} telah direfund ke saldo.` : '';
      await ctx.reply(`❌ Transaksi via saldo gagal (${digiflazzResult.message || digiflazzResult.status}).${refundNote}\nSaldo sekarang: ${formatRupiah(saldoNow)}`, { reply_markup: mainKeyboard() });
    } else {
      await ctx.reply(`⏳ Transaksi via saldo diproses (${order.digiflazz_status}). Kode: ${order.ref_id}\nSaldo terpotong, akan direfund otomatis jika gagal. Saldo sekarang: ${formatRupiah(saldoNow)}`, { reply_markup: mainKeyboard() });
    }
  } catch (err) {
    logger.error({ err: err.message, userId: ctx.from.id, sku }, '[bot] gagal order saldo');
    await ctx.reply(err.message.includes('Saldo tidak cukup') || err.message.includes('tidak ditemukan') ? err.message : 'Maaf, gagal memproses via saldo. Coba lagi.', { reply_markup: mainKeyboard() });
  }
});

bot.callbackQuery('pay_cancel', async (ctx) => {
  ctx.session.pendingOrder = null;
  await ctx.answerCallbackQuery({ text: 'Dibatalkan' });
  await ctx.reply('Pesanan dibatalkan.', { reply_markup: mainKeyboard() });
});

bot.on('message:text', async (ctx, next) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return next();
  if (['🛒 Produk','📂 Kategori','💰 Saldo','➕ Topup','📜 Riwayat','❓ Bantuan'].includes(text)) return next();

  // 1. Mode tunggu nominal topup custom
  if (ctx.session.awaitingTopup) {
    const amount = parseRupiahInput(text);
    if (!Number.isFinite(amount) || amount <= 0) {
      await ctx.reply('Nominal tidak valid. Contoh: 50000 atau 50k. Ketik /batal untuk batalkan.');
      return;
    }
    ctx.session.awaitingTopup = false;
    await handleCreateTopup(ctx, amount);
    return;
  }

  // 2. Mode tunggu nomor tujuan
  const pendingSku = ctx.session.pendingSku;
  if (pendingSku) {
    const customerNo = text.replace(/[\s\-+]/g, '');
    if (!isValidCustomerNo(customerNo)) {
      await ctx.reply('Nomor tujuan tidak valid. Masukkan 8-20 digit angka saja.\nKetik /batal untuk batalkan.');
      return;
    }
    ctx.session.pendingSku = null;
    ctx.session.pendingOrder = { sku: pendingSku, customerNo };
    try { await sendPaymentChoice(ctx, pendingSku, customerNo); }
    catch (e) { logger.error({ err: e.message }, '[bot] sendPaymentChoice gagal'); await ctx.reply('Gagal memuat pilihan pembayaran. Coba /produk lagi.'); }
    return;
  }
  // bukan alur yang dikenali
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
    await ctx.reply('Gagal memuat riwayat.', { reply_markup: mainKeyboard() });
  }
});

async function notifyOrderResult(order) {
  try {
    const userRes = await db.query('SELECT telegram_id FROM users WHERE id = $1', [order.user_id]);
    if (userRes.rows.length === 0) return;
    const telegramId = userRes.rows[0].telegram_id;
    // Ambil saldo terkini untuk info refund
    let saldoInfo = '';
    try {
      const s = await db.query('SELECT saldo FROM users WHERE id = $1', [order.user_id]);
      if (s.rows.length) saldoInfo = `\nSaldo sekarang: ${formatRupiah(s.rows[0].saldo)}`;
    } catch (_) {}
    let text;
    if (order.status === 'success') text = `✅ Transaksi ${order.ref_id} berhasil! SN: ${order.digiflazz_sn || '-'}${saldoInfo}`;
    else if (order.status === 'failed') {
      const refundMsg = order.refunded || order.refundAmount ? ` Dana ${formatRupiah(order.refundAmount || order.total_bayar)} telah direfund ke saldo.` : ' Dana akan direfund ke saldo otomatis.';
      text = `❌ Transaksi ${order.ref_id} gagal.${refundMsg}${saldoInfo}`;
    }
    else text = `⏳ Transaksi ${order.ref_id} sedang diproses, mohon tunggu.${saldoInfo}`;
    await bot.api.sendMessage(telegramId, text);
  } catch (err) {
    logger.error({ err: err.message, orderId: order?.id }, '[bot:notify] gagal kirim notifikasi');
  }
}

async function notifyTopupSuccess(topup, newSaldo) {
  try {
    const userRes = await db.query('SELECT telegram_id FROM users WHERE id = $1', [topup.user_id]);
    if (userRes.rows.length === 0) return;
    const telegramId = userRes.rows[0].telegram_id;
    const text = `✅ Topup ${topup.ref_id} berhasil! Nominal ${formatRupiah(topup.amount)} telah masuk.\nSaldo sekarang: ${formatRupiah(newSaldo)}`;
    await bot.api.sendMessage(telegramId, text);
  } catch (err) {
    logger.error({ err: err.message, topupId: topup?.id }, '[bot:notifyTopup] gagal');
  }
}

bot.catch((err) => {
  const ctx = err.ctx;
  logger.error({ err: err.error?.message || err.message, updateId: ctx?.update?.update_id }, '[bot] unhandled error');
});

module.exports = { bot, notifyOrderResult, notifyTopupSuccess };

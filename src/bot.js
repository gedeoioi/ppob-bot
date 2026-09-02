const { Bot, InlineKeyboard, Keyboard, session } = require('grammy');
const QRCode = require('qrcode');
const config = require('./config');
const db = require('./db');
const orderService = require('./services/order');
const topupService = require('./services/topup');
const balanceService = require('./services/balance');
const admin = require('./admin');
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
      adminState: null, // { action, telegramId }
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
  // Base keyboard untuk semua user
  const kb = new Keyboard()
    .text('🛒 Produk').text('📂 Kategori').row()
    .text('💰 Saldo').text('➕ Topup').row()
    .text('📜 Riwayat').text('❓ Bantuan').row();
  return kb.resized().persistent();
}

function adminKeyboard() {
  return new Keyboard()
    .text('🛒 Produk').text('📂 Kategori').row()
    .text('💰 Saldo').text('➕ Topup').row()
    .text('📜 Riwayat').text('👑 Admin').row()
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
    await ctx.reply('Belum ada produk tersedia. Admin belum sync produk.');
    return;
  }
  const totalPages = Math.ceil(total / PRODUK_PER_PAGE);
  if (page < 0) page = 0;
  if (page >= totalPages) page = totalPages - 1;

  const res = await db.query(
    'SELECT buyer_sku_code, nama, harga_jual, kategori, brand FROM products WHERE is_active = true ORDER BY kategori, nama LIMIT $1 OFFSET $2',
    [PRODUK_PER_PAGE, page * PRODUK_PER_PAGE]
  );

  // Urutan kategori sinkron dengan sync-tokovoucher & sendKategoriMenu
  const ORDER = ['🎮 Topup Game','🎮 Voucher Game','📱 Pulsa','📶 Paket Data','⚡ PLN','💳 E-Wallet','🧾 Tagihan','🧾 Pascabayar','📺 TV & Hiburan','🌏 Topup Luar Negeri','📦 Lainnya','Lainnya'];
  const orderIdx = (k) => { const i = ORDER.indexOf(k); return i === -1 ? 999 : i; };
  // Group lalu sort group sesuai ORDER
  const groups = new Map();
  for (const p of res.rows) {
    const kat = p.kategori || '📦 Lainnya';
    if (!groups.has(kat)) groups.set(kat, []);
    groups.get(kat).push(p);
  }
  const sortedGroups = [...groups.entries()].sort((a,b) => {
    const oa = orderIdx(a[0]), ob = orderIdx(b[0]);
    if (oa !== ob) return oa - ob;
    return a[0].localeCompare(b[0]);
  });

  const keyboard = new InlineKeyboard();
  for (const [kategori, items] of sortedGroups) {
    // Ganti prefix "──" dengan format yang sudah ada emoji dari kategori itu sendiri
    keyboard.text(`──── ${kategori} ────`, 'noop').row();
    // Sort produk dalam kategori by harga termurah dulu agar rapi
    items.sort((a,b) => Number(a.harga_jual) - Number(b.harga_jual));
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
    "SELECT kategori, COUNT(*)::int AS cnt FROM products WHERE is_active = true AND kategori IS NOT NULL AND kategori <> '' GROUP BY kategori"
  );
  if (res.rows.length === 0) return ctx.reply('Belum ada kategori.');

  // Urutan rapi sinkron dengan sync-tokovoucher: game dulu, baru pulsa/data, lalu utilitas
  const ORDER = ['🎮 Topup Game','🎮 Voucher Game','📱 Pulsa','📶 Paket Data','⚡ PLN','💳 E-Wallet','🧾 Tagihan','🧾 Pascabayar','📺 TV & Hiburan','🌏 Topup Luar Negeri','📦 Lainnya','Lainnya'];
  const orderIdx = (k) => { const i = ORDER.indexOf(k); return i === -1 ? 999 : i; };
  const sorted = [...res.rows].sort((a,b) => {
    const oa = orderIdx(a.kategori), ob = orderIdx(b.kategori);
    if (oa !== ob) return oa - ob;
    return a.kategori.localeCompare(b.kategori);
  });

  const kb = new InlineKeyboard();
  for (let i = 0; i < sorted.length; i += 2) {
    const a = sorted[i];
    const b = sorted[i + 1];
    // Tampilkan kategori apa adanya (sudah ada emoji dari sync-tokovoucher) + badge jumlah
    kb.text(`${a.kategori} (${a.cnt})`, `kategori:${a.kategori}`);
    if (b) kb.text(`${b.kategori} (${b.cnt})`, `kategori:${b.kategori}`);
    kb.row();
  }
  kb.text('⬅️ Semua Produk', 'produk_page:0').text('❌ Tutup', 'close_menu');
  const totalProduk = sorted.reduce((s,r)=>s+r.cnt,0);
  const text = `📂 *Pilih Kategori* — ${sorted.length} kategori, ${totalProduk} produk aktif`;
  if (ctx.callbackQuery) {
    try { await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: kb }); await ctx.answerCallbackQuery(); return; } catch (_) {}
  }
  await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: kb });
}

async function sendProdukByKategori(ctx, kategori) {
  const res = await db.query(
    'SELECT buyer_sku_code, nama, harga_jual FROM products WHERE is_active = true AND kategori = $1 ORDER BY harga_jual ASC, nama ASC LIMIT 24',
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
  const text = `${escapeMarkdown(kategori)} — ${res.rows.length} produk (urut termurah)`;
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
    const kb = admin.isAdmin(ctx.from.id) ? adminKeyboard() : mainKeyboard();
    await ctx.reply(
      '👋 *Selamat datang di PPOB Bot!*\n\n' +
      `💰 Saldo: ${formatRupiah(saldo)}\n\n` +
      '*Menu:*\n' +
      '🛒 /produk — daftar produk\n' +
      '📂 /kategori — filter kategori\n' +
      '💰 /saldo — cek saldo & mutasi\n' +
      '➕ /topup — isi saldo via QRIS\n' +
      '📜 /riwayat — transaksi terakhir\n' +
      '❓ /bantuan — cara pakai\n' +
      (admin.isAdmin(ctx.from.id) ? '👑 /admin — panel owner\n' : '') +
      '\nGunakan tombol di bawah.',
      { parse_mode: 'Markdown', reply_markup: kb }
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
bot.command('status', async (ctx) => { await sendStatusHelp(ctx); });

bot.command('batal', async (ctx) => {
  ctx.session.pendingSku = null;
  ctx.session.pendingOrder = null;
  ctx.session.awaitingTopup = false;
  ctx.session.adminState = null;
  await ctx.reply('Input dibatalkan.', { reply_markup: mainKeyboard() });
});

// ── Admin panel (owner only) ─────────────────────────────────────
bot.command('admin', async (ctx) => {
  if (!admin.isAdmin(ctx.from.id)) return ctx.reply('⛔ Khusus owner/admin.');
  try { await admin.sendAdminPanel(ctx); } catch (e) { logger.error({ err: e.message }, '[admin] panel gagal'); await ctx.reply('Gagal memuat admin panel.'); }
});
bot.command('stats', async (ctx) => {
  if (!admin.isAdmin(ctx.from.id)) return;
  const s = await admin.getStats();
  await ctx.reply(`📊 Statistik: order sukses ${s.ordersSuccess} pending ${s.ordersPending} failed ${s.ordersFailed} | topup pending ${s.topupPending} | member ${s.totalUsers}`);
});
// Tampilkan keyboard admin khusus agar tombol 👑 Admin terlihat untuk owner
bot.command('adminkeyboard', async (ctx) => {
  if (!admin.isAdmin(ctx.from.id)) return ctx.reply('⛔ Khusus owner.');
  await ctx.reply('Keyboard admin aktif.', { reply_markup: adminKeyboard() });
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
bot.hears('👑 Admin', async (ctx) => {
  if (!admin.isAdmin(ctx.from.id)) return ctx.reply('⛔ Khusus owner.');
  try { await admin.sendAdminPanel(ctx); } catch (e) { await ctx.reply('Gagal memuat admin panel.'); }
});
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

// ── Admin callbacks ──────────────────────────────────────────────
bot.callbackQuery('adm_panel', async (ctx) => {
  if (!admin.isAdmin(ctx.from.id)) return ctx.answerCallbackQuery({ text: '⛔' });
  await admin.sendAdminPanel(ctx);
});
bot.callbackQuery('adm_stats', async (ctx) => {
  if (!admin.isAdmin(ctx.from.id)) return;
  const s = await admin.getStats();
  await ctx.answerCallbackQuery();
  await ctx.reply(`📊 Statistik:\nMember: ${s.totalUsers}\nOrder pending: ${s.ordersPending}\nTopup pending: ${s.topupPending}\nRevenue hari ini: ${formatRupiah(s.revenueToday)}`);
});
bot.callbackQuery(/^adm_orders:([^:]+):(\d+)$/, async (ctx) => {
  if (!admin.isAdmin(ctx.from.id)) return;
  await admin.sendOrders(ctx, parseInt(ctx.match[2],10), ctx.match[1]);
});
bot.callbackQuery(/^adm_order_detail:(.+)$/, async (ctx) => {
  if (!admin.isAdmin(ctx.from.id)) return;
  await admin.sendOrderDetail(ctx, ctx.match[1]);
});
bot.callbackQuery(/^adm_refund:(.+)$/, async (ctx) => {
  if (!admin.isAdmin(ctx.from.id)) return ctx.answerCallbackQuery({ text: '⛔' });
  const refId = ctx.match[1];
  await ctx.answerCallbackQuery();
  try {
    const oRes = await db.query('SELECT id, total_bayar, refunded FROM orders WHERE ref_id=$1', [refId]);
    if (!oRes.rows.length) return ctx.reply('Order tidak ditemukan');
    if (oRes.rows[0].refunded) return ctx.reply('Sudah direfund sebelumnya.');
    await balanceService.mutateBalance({ userId: (await db.query('SELECT user_id FROM orders WHERE ref_id=$1',[refId])).rows[0].user_id, amount: Number(oRes.rows[0].total_bayar), reason: 'refund', orderId: oRes.rows[0].id, description: `Refund manual admin untuk ${refId}` });
    await db.query('UPDATE orders SET refunded=true WHERE ref_id=$1', [refId]);
    await ctx.reply(`✅ Refund ${formatRupiah(oRes.rows[0].total_bayar)} untuk ${refId} berhasil.`);
  } catch (e) { await ctx.reply('Gagal refund: '+e.message); }
});
bot.callbackQuery(/^adm_topups(?::(\d+))?$/, async (ctx) => {
  if (!admin.isAdmin(ctx.from.id)) return;
  const page = ctx.match[1] ? parseInt(ctx.match[1],10) : 0;
  await admin.sendTopups(ctx, page);
});
bot.callbackQuery(/^adm_members(?::(\d+))?$/, async (ctx) => {
  if (!admin.isAdmin(ctx.from.id)) return;
  const page = ctx.match[1] ? parseInt(ctx.match[1],10) : 0;
  await admin.sendMembers(ctx, page);
});
bot.callbackQuery(/^adm_user:(\d+)$/, async (ctx) => {
  if (!admin.isAdmin(ctx.from.id)) return;
  await admin.sendUserDetail(ctx, ctx.match[1]);
});
bot.callbackQuery(/^adm_ban:(\d+)$/, async (ctx) => {
  if (!admin.isAdmin(ctx.from.id)) return;
  await db.query('UPDATE users SET is_banned=true WHERE telegram_id=$1', [ctx.match[1]]);
  await ctx.answerCallbackQuery({ text: 'Banned' });
  await admin.sendUserDetail(ctx, ctx.match[1]);
});
bot.callbackQuery(/^adm_unban:(\d+)$/, async (ctx) => {
  if (!admin.isAdmin(ctx.from.id)) return;
  await db.query('UPDATE users SET is_banned=false WHERE telegram_id=$1', [ctx.match[1]]);
  await ctx.answerCallbackQuery({ text: 'Unbanned' });
  await admin.sendUserDetail(ctx, ctx.match[1]);
});
bot.callbackQuery(/^adm_toggleadmin:(\d+)$/, async (ctx) => {
  if (!admin.isAdmin(ctx.from.id)) return;
  const r = await db.query('SELECT role FROM users WHERE telegram_id=$1', [ctx.match[1]]);
  const newRole = r.rows[0]?.role === 'admin' ? 'user' : 'admin';
  await db.query('UPDATE users SET role=$1 WHERE telegram_id=$2', [newRole, ctx.match[1]]);
  await ctx.answerCallbackQuery({ text: `Role -> ${newRole}` });
  await admin.sendUserDetail(ctx, ctx.match[1]);
});
bot.callbackQuery('adm_addsaldo', async (ctx) => {
  if (!admin.isAdmin(ctx.from.id)) return;
  await ctx.answerCallbackQuery();
  ctx.session.adminState = { action: 'addsaldo' };
  await ctx.reply('Kirim: `telegram_id nominal`\nContoh: `2110398202 50000` atau `2110398202 50k`\nKetik /batal untuk batalkan.', { parse_mode: 'Markdown' });
});
bot.callbackQuery(/^adm_addsaldo:(\d+)$/, async (ctx) => {
  if (!admin.isAdmin(ctx.from.id)) return;
  ctx.session.adminState = { action: 'addsaldo', telegramId: ctx.match[1] };
  await ctx.answerCallbackQuery();
  await ctx.reply(`Kirim nominal untuk ${ctx.match[1]} (contoh: 50000 atau 50k). /batal untuk batalkan.`);
});
bot.callbackQuery(/^adm_subsaldo:(\d+)$/, async (ctx) => {
  if (!admin.isAdmin(ctx.from.id)) return;
  ctx.session.adminState = { action: 'subsaldo', telegramId: ctx.match[1] };
  await ctx.answerCallbackQuery();
  await ctx.reply(`Kirim nominal yang akan *dikurangi* dari ${ctx.match[1]} (contoh: 20000). /batal untuk batalkan.`, { parse_mode: 'Markdown' });
});
bot.callbackQuery('adm_search', async (ctx) => {
  if (!admin.isAdmin(ctx.from.id)) return;
  ctx.session.adminState = { action: 'search' };
  await ctx.answerCallbackQuery();
  await ctx.reply('Ketik yang dicari: telegram_id, @username, nama, atau ref_id/top_id (ORD.../TOP...).');
});
bot.callbackQuery('adm_mutasi', async (ctx) => {
  if (!admin.isAdmin(ctx.from.id)) return;
  const rows = await db.query('SELECT user_id, amount, reason, created_at FROM balance_mutations ORDER BY created_at DESC LIMIT 15');
  if (!rows.rows.length) { await ctx.answerCallbackQuery({ text: 'Belum ada' }); return; }
  await ctx.answerCallbackQuery();
  const lines = rows.rows.map(r=>`${new Date(r.created_at).toLocaleString('id-ID')} | u${r.user_id} | ${r.amount>0?'+':''}${formatRupiah(r.amount)} | ${r.reason}`);
  await ctx.reply(lines.join('\n'));
});
bot.callbackQuery(/^adm_products(?::(\d+))?$/, async (ctx) => {
  if (!admin.isAdmin(ctx.from.id)) return;
  const page = ctx.match[1] ? parseInt(ctx.match[1],10) : 0;
  await admin.sendProductsAdmin(ctx, page);
});
bot.callbackQuery(/^adm_prod:(.+)$/, async (ctx) => {
  if (!admin.isAdmin(ctx.from.id)) return;
  const sku = ctx.match[1];
  const r = await db.query('SELECT * FROM products WHERE buyer_sku_code=$1', [sku]);
  if (!r.rows.length) return ctx.answerCallbackQuery({ text: 'Tidak ada' });
  const p = r.rows[0];
  const kb = new (require('grammy').InlineKeyboard)()
    .text(p.is_active?'❌ Nonaktifkan':'✅ Aktifkan', `adm_prod_toggle:${sku}`).row()
    .text('⬅️ Daftar','adm_products:0').text('⬅️ Panel','adm_panel');
  await ctx.editMessageText(`⚙️ *Produk* \`${escapeMarkdown(sku)}\`\nNama: ${escapeMarkdown(p.nama)}\nKategori: ${escapeMarkdown(p.kategori||'-')} | Brand: ${escapeMarkdown(p.brand||'-')}\nHarga: ${formatRupiah(p.harga_jual)} (beli ${formatRupiah(p.harga_beli)} + markup ${formatRupiah(p.markup)})\nAktif: ${p.is_active?'Ya':'Tidak'}`, { parse_mode: 'Markdown', reply_markup: kb });
  await ctx.answerCallbackQuery();
});
bot.callbackQuery(/^adm_prod_toggle:(.+)$/, async (ctx) => {
  if (!admin.isAdmin(ctx.from.id)) return;
  const sku = ctx.match[1];
  await db.query('UPDATE products SET is_active = NOT is_active WHERE buyer_sku_code=$1', [sku]);
  await ctx.answerCallbackQuery({ text: 'Diubah' });
  const r = await db.query('SELECT * FROM products WHERE buyer_sku_code=$1', [sku]);
  const p = r.rows[0];
  const kb = new (require('grammy').InlineKeyboard)()
    .text(p.is_active?'❌ Nonaktifkan':'✅ Aktifkan', `adm_prod_toggle:${sku}`).row()
    .text('⬅️ Daftar','adm_products:0').text('⬅️ Panel','adm_panel');
  await ctx.editMessageText(`⚙️ *Produk* \`${escapeMarkdown(sku)}\`\nAktif: ${p.is_active?'Ya':'Tidak'}`, { parse_mode: 'Markdown', reply_markup: kb });
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
  // Untuk QRIS, status Gagal dari provider akan datang via webhook/polling — notifyOrderResult akan kirim ❌ + refund
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
    // Bedakan: jika provider langsung bilang nomor tujuan salah / produk tidak ditemukan → tampilkan jelas agar user tau bukan bug bot
    const low = String(err.message || '').toLowerCase();
    if (low.includes('nomor tujuan') || low.includes('nomor tidak') || low.includes('customer_no') || low.includes('tujuan salah')) {
      await ctx.reply(`❌ Nomor tujuan salah: ${err.message}\nPeriksa kembali nomor/ID tujuan lalu ulangi /produk.`, { reply_markup: mainKeyboard() });
    } else if (low.includes('signature') || low.includes('ip not allow') || low.includes('kredensial')) {
      await ctx.reply(`⚠️ Gangguan provider sementara (${err.message}). Order tetap tercatat sebagai Pending, akan dipolling otomatis. Cek /riwayat.`, { reply_markup: mainKeyboard() });
    } else {
      await ctx.reply(err.message.includes('Saldo tidak cukup') || err.message.includes('tidak ditemukan') ? err.message : 'Maaf, gagal memproses via saldo. Coba lagi.', { reply_markup: mainKeyboard() });
    }
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
  if (['🛒 Produk','📂 Kategori','💰 Saldo','➕ Topup','📜 Riwayat','❓ Bantuan','👑 Admin'].includes(text)) return next();

  // 0. Mode admin input (tambah/kurang saldo, search)
  if (ctx.session.adminState) {
    if (!admin.isAdmin(ctx.from.id)) { ctx.session.adminState = null; return next(); }
    const state = ctx.session.adminState;
    if (state.action === 'addsaldo' || state.action === 'subsaldo') {
      const parts = text.split(/\s+/);
      let targetId, nominalStr;
      if (state.telegramId) {
        targetId = state.telegramId;
        nominalStr = parts[0];
      } else {
        if (parts.length < 2) { await ctx.reply('Format: `telegram_id nominal` contoh: `2110398202 50000`', { parse_mode: 'Markdown' }); return; }
        targetId = parts[0];
        nominalStr = parts[1];
      }
      const amount = parseRupiahInput(nominalStr);
      if (!Number.isFinite(amount) || amount <= 0) { await ctx.reply('Nominal tidak valid.'); return; }
      const finalAmount = state.action === 'subsaldo' ? -Math.abs(amount) : Math.abs(amount);
      try {
        const { newSaldo } = await admin.adminMutateSaldo({ telegramId: targetId, amount: finalAmount, reasonDesc: `Manual ${state.action} oleh admin ${ctx.from.id}` });
        ctx.session.adminState = null;
        await ctx.reply(`✅ ${state.action} ${formatRupiah(Math.abs(amount))} untuk ${targetId} berhasil. Saldo sekarang: ${formatRupiah(newSaldo)}`);
        // notify user
        try { await bot.api.sendMessage(Number(targetId), `💰 Saldo ${finalAmount>0?'ditambah':'dikurangi'} ${formatRupiah(Math.abs(amount))} oleh admin. Saldo sekarang: ${formatRupiah(newSaldo)}`); } catch (_) {}
      } catch (e) { await ctx.reply('Gagal: '+e.message); }
      return;
    }
    if (state.action === 'search') {
      ctx.session.adminState = null;
      try { await admin.handleSearch(ctx, text); } catch (e) { await ctx.reply('Gagal search: '+e.message); }
      return;
    }
  }

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

async function sendStatusHelp(ctx) {
  const provider = require('./services/provider').currentProvider();
  const providerNote = provider === 'tokovoucher'
    ? 'Provider aktif: *TokoVoucher* — polling tiap 10 menit, webhook akan finalisasi otomatis. Jika saldo TokoVoucher tipis, transaksi bisa Pending lama.'
    : 'Provider aktif: *Digiflazz* — polling tiap 2 menit.';
  await ctx.reply(
    `ℹ️ *Status Transaksi*\n\n` +
    `${providerNote}\n\n` +
    `• *Pending/Pending* = masih diproses provider, tunggu notifikasi atau polling otomatis.\n` +
    `• Jika order via *Saldo* gagal, dana otomatis refund (cek /mutasi).\n` +
    `• Jika order via *QRIS* Pending lama (>15 menit), hubungi admin dengan ref_id.`,
    { parse_mode: 'Markdown' }
  );
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

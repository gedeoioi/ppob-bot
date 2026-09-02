const { InlineKeyboard } = require('grammy');
const db = require('./db');
const config = require('./config');
const balanceService = require('./services/balance');
const logger = require('./logger');

function isAdmin(telegramId) {
  return config.isAdmin(telegramId);
}

function requireAdmin(ctx, next) {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('⛔ Akses ditolak. Perintah ini khusus owner/admin.');
  }
  return next();
}

function formatRupiah(n) {
  return `Rp${Number(n).toLocaleString('id-ID')}`;
}

function escapeMd(s) {
  return String(s).replace(/([_*`\[\]])/g, '\\$&');
}

// ── Dashboard ────────────────────────────────────────────────────
async function sendAdminPanel(ctx) {
  const stats = await getStats();
  const kb = new InlineKeyboard()
    .text('📊 Statistik', 'adm_stats').text('📋 Transaksi', 'adm_orders:all:0').row()
    .text('💰 Topup Pending', 'adm_topups:0').text('👥 Member', 'adm_members:0').row()
    .text('➕ Tambah Saldo', 'adm_addsaldo').text('🔍 Cari User', 'adm_search').row()
    .text('📒 Mutasi', 'adm_mutasi').text('⚙️ Produk', 'adm_products:0').row()
    .text('❌ Tutup', 'close_menu');

  const text =
    `👑 *Admin Panel*\n\n` +
    `📊 Statistik Hari Ini:\n` +
    `• Order sukses: ${stats.ordersSuccess} | pending: ${stats.ordersPending} | failed: ${stats.ordersFailed}\n` +
    `• Topup pending: ${stats.topupPending} | sukses hari ini: ${stats.topupToday}\n` +
    `• Total member: ${stats.totalUsers} | saldo terkunci pending: ${formatRupiah(stats.pendingAmount)}\n` +
    `• Revenue (order sukses hari ini): ${formatRupiah(stats.revenueToday)}\n\n` +
    `Pilih menu di bawah.`;

  if (ctx.callbackQuery) {
    try { await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: kb }); await ctx.answerCallbackQuery(); return; } catch (_) {}
  }
  await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: kb });
}

async function getStats() {
  const today = new Date(); today.setHours(0,0,0,0);
  const [
    totalUsers,
    ordersSuccess,
    ordersPending,
    ordersFailed,
    topupPending,
    topupToday,
    pendingAmount,
    revenueToday,
  ] = await Promise.all([
    db.query("SELECT COUNT(*)::int c FROM users").then(r=>r.rows[0].c),
    db.query("SELECT COUNT(*)::int c FROM orders WHERE status='success' AND created_at >= $1", [today]).then(r=>r.rows[0].c),
    db.query("SELECT COUNT(*)::int c FROM orders WHERE status IN ('pending_payment','processing')").then(r=>r.rows[0].c),
    db.query("SELECT COUNT(*)::int c FROM orders WHERE status='failed' AND created_at >= $1", [today]).then(r=>r.rows[0].c),
    db.query("SELECT COUNT(*)::int c FROM topups WHERE status='pending_payment'").then(r=>r.rows[0].c),
    db.query("SELECT COUNT(*)::int c FROM topups WHERE status='success' AND created_at >= $1", [today]).then(r=>r.rows[0].c),
    db.query("SELECT COALESCE(SUM(total_bayar),0)::bigint s FROM orders WHERE status='pending_payment'").then(r=>Number(r.rows[0].s)),
    db.query("SELECT COALESCE(SUM(total_bayar),0)::bigint s FROM orders WHERE status='success' AND created_at >= $1", [today]).then(r=>Number(r.rows[0].s)),
  ]);
  return { totalUsers, ordersSuccess, ordersPending, ordersFailed, topupPending, topupToday, pendingAmount, revenueToday };
}

// ── Orders list (paginated) ──────────────────────────────────────
async function sendOrders(ctx, page = 0, filter = 'all') {
  const limit = 8;
  const offset = page * limit;
  let where = '1=1';
  const params = [];
  if (filter === 'pending') where = "o.status IN ('pending_payment','processing')";
  else if (filter === 'success') where = "o.status='success'";
  else if (filter === 'failed') where = "o.status='failed'";
  else if (filter === 'expired') where = "o.status='expired'";

  const countRes = await db.query(`SELECT COUNT(*)::int c FROM orders o WHERE ${where}`);
  const total = countRes.rows[0].c;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  if (page < 0) page = 0;
  if (page >= totalPages) page = totalPages - 1;

  const res = await db.query(
    `SELECT o.ref_id, o.status, o.total_bayar, o.customer_no, o.buyer_sku_code, o.created_at,
            u.telegram_id, u.username, u.full_name
     FROM orders o JOIN users u ON u.id=o.user_id
     WHERE ${where}
     ORDER BY o.created_at DESC LIMIT ${limit} OFFSET ${offset}`
  );

  let text = `📋 *Transaksi* [${filter}] hal ${page+1}/${totalPages} (total ${total})\n\n`;
  if (res.rows.length === 0) text += '_Tidak ada data_';
  else {
    for (const r of res.rows) {
      const user = r.username ? '@' + r.username : (r.full_name || r.telegram_id);
      text += `\`${escapeMd(r.ref_id)}\` | ${escapeMd(r.status)} | ${formatRupiah(r.total_bayar)} | ${escapeMd(r.buyer_sku_code)} → ${escapeMd(r.customer_no)} | ${escapeMd(user)} | ${new Date(r.created_at).toLocaleString('id-ID')}\n`;
    }
  }

  const kb = new InlineKeyboard()
    .text('All', 'adm_orders:all:0').text('Pending', 'adm_orders:pending:0').text('Sukses', 'adm_orders:success:0').row()
    .text('Gagal', 'adm_orders:failed:0').text('Expired', 'adm_orders:expired:0').row();
  if (totalPages > 1) {
    if (page > 0) kb.text('⬅️ Prev', `adm_orders:${filter}:${page-1}`);
    kb.text(`${page+1}/${totalPages}`, 'noop');
    if (page < totalPages - 1) kb.text('Next ➡️', `adm_orders:${filter}:${page+1}`);
    kb.row();
  }
  // quick detail buttons for first 3
  for (const r of res.rows.slice(0,3)) {
    kb.text(`🔍 ${r.ref_id.slice(0,10)}…`, `adm_order_detail:${r.ref_id}`).row ? null : null;
  }
  // add detail row
  if (res.rows.length) {
    const detailKb = new InlineKeyboard();
    for (let i=0;i<Math.min(3,res.rows.length);i++) detailKb.text(`🔍 ${res.rows[i].ref_id.slice(0,12)}`, `adm_order_detail:${res.rows[i].ref_id}`);
    detailKb.row();
    // merge
    res.rows.slice(0,3).forEach(()=>{});
    kb.text('⬅️ Panel', 'adm_panel').text('❌ Tutup', 'close_menu');
  } else {
    kb.text('⬅️ Panel', 'adm_panel').text('❌ Tutup', 'close_menu');
  }

  // Simplify: rebuild clean
  const finalKb = new InlineKeyboard()
    .text('All', 'adm_orders:all:0').text('Pending', 'adm_orders:pending:0').text('Sukses', 'adm_orders:success:0').row()
    .text('Gagal', 'adm_orders:failed:0').text('Expired', 'adm_orders:expired:0').row();
  if (totalPages > 1) {
    if (page > 0) finalKb.text('⬅️ Prev', `adm_orders:${filter}:${page-1}`);
    finalKb.text(`${page+1}/${totalPages}`, 'noop');
    if (page < totalPages - 1) finalKb.text('Next ➡️', `adm_orders:${filter}:${page+1}`);
    finalKb.row();
  }
  if (res.rows.length) {
    for (let i=0; i<Math.min(4,res.rows.length); i++) {
      finalKb.text(`🔍 ${res.rows[i].ref_id.slice(0,10)}`, `adm_order_detail:${res.rows[i].ref_id}`);
      if (i%2===1) finalKb.row();
    }
    if (res.rows.length%2===1) finalKb.row();
  }
  finalKb.text('⬅️ Panel', 'adm_panel').text('❌ Tutup', 'close_menu');

  try { await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: finalKb }); await ctx.answerCallbackQuery(); }
  catch (_) { await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: finalKb }); }
}

async function sendOrderDetail(ctx, refId) {
  const res = await db.query(
    `SELECT o.*, u.telegram_id, u.username, u.full_name, u.saldo
     FROM orders o JOIN users u ON u.id=o.user_id WHERE o.ref_id=$1`, [refId]
  );
  if (!res.rows.length) { await ctx.answerCallbackQuery({ text: 'Tidak ditemukan' }); return; }
  const o = res.rows[0];
  const pay = await db.query('SELECT gateway_ref, status, amount FROM payments WHERE order_id=$1 ORDER BY id DESC LIMIT 1', [o.id]);
  const mut = await db.query("SELECT amount, reason FROM balance_mutations WHERE order_id=$1", [o.id]);
  const refunded = mut.rows.filter(r=>r.reason==='refund').length>0;
  const providerLabel = o.provider === 'tokovoucher' ? 'TokoVoucher' : o.provider === 'digiflazz' ? 'Digiflazz' : (o.provider || '-');

  let text =
    `🔍 *Detail Order* \`${escapeMd(o.ref_id)}\`\n\n` +
    `User: ${escapeMd(o.full_name||'')} ${o.username?'(@'+escapeMd(o.username)+')':''} | tg ${o.telegram_id} | saldo ${formatRupiah(o.saldo)}\n` +
    `Produk: ${escapeMd(o.buyer_sku_code)} → ${escapeMd(o.customer_no)}\n` +
    `Harga: ${formatRupiah(o.harga_jual)} + kode ${o.kode_unik} = ${formatRupiah(o.total_bayar)}\n` +
    `Provider: ${escapeMd(providerLabel)}${o.provider_trx_id ? ' | trx ' + escapeMd(o.provider_trx_id) : ''}\n` +
    `Status: ${escapeMd(o.status)} | ${escapeMd(providerLabel)}: ${escapeMd(o.digiflazz_status||'-')} SN: ${escapeMd(o.digiflazz_sn||'-')}\n` +
    `Source: ${escapeMd(o.payment_source||'qris')} | refunded: ${refunded?'Ya':'Tidak'}\n` +
    `Created: ${new Date(o.created_at).toLocaleString('id-ID')} | Exp: ${new Date(o.expired_at).toLocaleString('id-ID')}\n`;
  if (pay.rows.length) text += `Payment: ${escapeMd(pay.rows[0].gateway_ref||'-')} | ${escapeMd(pay.rows[0].status)}\n`;
  if (mut.rows.length) text += `Mutasi: ${mut.rows.map(r=>`${r.reason}:${formatRupiah(r.amount)}`).join(', ')}\n`;

  const kb = new InlineKeyboard();
  if (o.status==='failed' && !refunded) kb.text('💸 Refund Manual', `adm_refund:${o.ref_id}`).row();
  kb.text('⬅️ Daftar', 'adm_orders:all:0').text('⬅️ Panel', 'adm_panel').row().text('❌ Tutup','close_menu');

  try { await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: kb }); await ctx.answerCallbackQuery(); }
  catch (_) { await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: kb }); }
}

// ── Topups ────────────────────────────────────────────────────────
async function sendTopups(ctx, page=0){
  const limit=8, offset=page*limit;
  const total = (await db.query("SELECT COUNT(*)::int c FROM topups WHERE status='pending_payment'")).rows[0].c;
  const totalPages = Math.max(1, Math.ceil(total/limit));
  const res = await db.query(
    `SELECT t.ref_id, t.amount, t.total_bayar, t.status, t.created_at, u.telegram_id, u.username
     FROM topups t JOIN users u ON u.id=t.user_id WHERE t.status='pending_payment'
     ORDER BY t.created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]
  );
  let text = `💰 *Topup Pending* hal ${page+1}/${totalPages} (total ${total})\n\n`;
  if(!res.rows.length) text+='_Tidak ada pending_';
  else for(const r of res.rows){
    text += `\`${escapeMd(r.ref_id)}\` | ${formatRupiah(r.amount)} → bayar ${formatRupiah(r.total_bayar)} | ${escapeMd(r.username||String(r.telegram_id))} | ${new Date(r.created_at).toLocaleString('id-ID')}\n`;
  }
  const kb=new InlineKeyboard();
  if(totalPages>1){
    if(page>0) kb.text('⬅️ Prev',`adm_topups:${page-1}`);
    kb.text(`${page+1}/${totalPages}`,'noop');
    if(page<totalPages-1) kb.text('Next ➡️',`adm_topups:${page+1}`);
    kb.row();
  }
  kb.text('⬅️ Panel','adm_panel').text('❌ Tutup','close_menu');
  try{await ctx.editMessageText(text,{parse_mode:'Markdown',reply_markup:kb});await ctx.answerCallbackQuery();}
  catch(_){await ctx.reply(text,{parse_mode:'Markdown',reply_markup:kb});}
}

// ── Members ───────────────────────────────────────────────────────
async function sendMembers(ctx, page=0){
  const limit=8, offset=page*limit;
  const total=(await db.query('SELECT COUNT(*)::int c FROM users')).rows[0].c;
  const totalPages=Math.max(1,Math.ceil(total/limit));
  if(page<0) page=0; if(page>=totalPages) page=totalPages-1;
  const res=await db.query(`SELECT id, telegram_id, username, full_name, saldo, is_banned, role, created_at FROM users ORDER BY created_at DESC LIMIT $1 OFFSET $2`,[limit,offset]);
  let text=`👥 *Member* hal ${page+1}/${totalPages} (total ${total})\n\n`;
  for(const u of res.rows){
    const ban = u.is_banned?'🚫':''; const role = u.role==='admin'?'👑':'';
    text+=`${ban}${role} \`${u.telegram_id}\` ${escapeMd(u.username?`@${u.username}`:(u.full_name||'-'))} | ${formatRupiah(u.saldo)} | ${new Date(u.created_at).toLocaleDateString('id-ID')}\n`;
  }
  const kb=new InlineKeyboard();
  for(let i=0;i<Math.min(4,res.rows.length);i++){
    kb.text(`👤 ${String(res.rows[i].telegram_id).slice(-6)}`, `adm_user:${res.rows[i].telegram_id}`);
    if(i%2===1) kb.row();
  }
  if(res.rows.length%2===1) kb.row();
  if(totalPages>1){
    if(page>0) kb.text('⬅️ Prev',`adm_members:${page-1}`);
    kb.text(`${page+1}/${totalPages}`,'noop');
    if(page<totalPages-1) kb.text('Next ➡️',`adm_members:${page+1}`);
    kb.row();
  }
  kb.text('⬅️ Panel','adm_panel').text('❌ Tutup','close_menu');
  try{await ctx.editMessageText(text,{parse_mode:'Markdown',reply_markup:kb});await ctx.answerCallbackQuery();}
  catch(_){await ctx.reply(text,{parse_mode:'Markdown',reply_markup:kb});}
}

async function sendUserDetail(ctx, telegramId){
  const res=await db.query('SELECT * FROM users WHERE telegram_id=$1',[telegramId]);
  if(!res.rows.length){await ctx.answerCallbackQuery({text:'User tidak ditemukan'});return;}
  const u=res.rows[0];
  const stats=await db.query(`SELECT COUNT(*)::int c, COALESCE(SUM(total_bayar),0)::bigint s FROM orders WHERE user_id=$1`,[u.id]);
  const topupStats=await db.query(`SELECT COUNT(*)::int c FROM topups WHERE user_id=$1 AND status='success'`,[u.id]);
  const muts=await db.query('SELECT amount, reason, created_at FROM balance_mutations WHERE user_id=$1 ORDER BY created_at DESC LIMIT 5',[u.id]);
  let text=
    `👤 *User ${escapeMd(String(u.telegram_id))}*\n\n`+
    `Nama: ${escapeMd(u.full_name||'-')} ${u.username?`(@${escapeMd(u.username)})`:''}\n`+
    `Saldo: ${formatRupiah(u.saldo)} | Role: ${escapeMd(u.role)} | ${u.is_banned?'🚫 BANNED':''}\n`+
    `Join: ${new Date(u.created_at).toLocaleString('id-ID')}\n`+
    `Orders: ${stats.rows[0].c} | Topup sukses: ${topupStats.rows[0].c}\n\n`+
    `Mutasi 5 terakhir:\n`;
  if(!muts.rows.length) text+='_Tidak ada_';
  else for(const m of muts.rows) text+=`${new Date(m.created_at).toLocaleString('id-ID')} | ${m.amount>0?'+':''}${formatRupiah(m.amount)} | ${escapeMd(m.reason)}\n`;

  const kb=new InlineKeyboard()
    .text('➕ Tambah Saldo','adm_addsaldo:'+telegramId).text(u.is_banned?'✅ Unban':'🚫 Ban', u.is_banned?`adm_unban:${telegramId}`:`adm_ban:${telegramId}`).row()
    .text('💸 Kurangi Saldo',`adm_subsaldo:${telegramId}`).text('👑 Toggle Admin',`adm_toggleadmin:${telegramId}`).row()
    .text('⬅️ Member','adm_members:0').text('⬅️ Panel','adm_panel').row().text('❌ Tutup','close_menu');
  try{await ctx.editMessageText(text,{parse_mode:'Markdown',reply_markup:kb});await ctx.answerCallbackQuery();}
  catch(_){await ctx.reply(text,{parse_mode:'Markdown',reply_markup:kb});}
}

// ── Add/sub saldo (admin manual) ─────────────────────────────────
async function adminMutateSaldo({ telegramId, amount, reasonDesc }) {
  const userRes = await db.query('SELECT id FROM users WHERE telegram_id=$1', [telegramId]);
  if (!userRes.rows.length) throw new Error('User tidak ditemukan');
  const userId = userRes.rows[0].id;
  const result = await balanceService.mutateBalance({
    userId,
    amount,
    reason: amount > 0 ? 'admin_adjust' : 'admin_adjust',
    description: reasonDesc,
  });
  const fresh = await db.query('SELECT saldo FROM users WHERE id=$1', [userId]);
  return { newSaldo: Number(fresh.rows[0].saldo), result };
}

// ── Search ────────────────────────────────────────────────────────
async function handleSearch(ctx, query){
  const q = query.trim();
  if(!q) return ctx.reply('Ketik username, nama, telegram_id, atau ref_id/top_id.');
  // cek apakah q adalah ref order/topup
  if(/^ORD/i.test(q) || /^TOP/i.test(q)){
    const o = await db.query('SELECT ref_id FROM orders WHERE ref_id=$1', [q]);
    if(o.rows.length){
      // reuse detail
      const fakeCtx = { ...ctx, match: [null, q], answerCallbackQuery: async()=>{}, editMessageText: ctx.reply.bind(ctx) };
      // just send detail directly
      const res = await db.query(`SELECT o.*, u.telegram_id, u.username, u.full_name, u.saldo FROM orders o JOIN users u ON u.id=o.user_id WHERE o.ref_id=$1`,[q]);
      const ord=res.rows[0];
      let text=`🔍 Order \`${escapeMd(ord.ref_id)}\` | ${escapeMd(ord.status)} | ${formatRupiah(ord.total_bayar)} | ${escapeMd(ord.customer_no)} | user ${ord.telegram_id}`;
      await ctx.reply(text,{parse_mode:'Markdown'});
      return;
    }
    const t = await db.query('SELECT * FROM topups WHERE ref_id=$1',[q]);
    if(t.rows.length){
      const tp=t.rows[0];
      await ctx.reply(`🔍 Topup \`${escapeMd(tp.ref_id)}\` | ${escapeMd(tp.status)} | ${formatRupiah(tp.total_bayar)} | user ${tp.user_id}`,{parse_mode:'Markdown'});
      return;
    }
  }
  // user search by telegram_id / username
  let user = null;
  if(/^\d+$/.test(q)){
    const r=await db.query('SELECT * FROM users WHERE telegram_id=$1',[q]);
    if(r.rows.length) user=r.rows[0];
  }
  if(!user){
    const r=await db.query('SELECT * FROM users WHERE username ILIKE $1 OR full_name ILIKE $1 LIMIT 1',[`%${q}%`]);
    if(r.rows.length) user=r.rows[0];
  }
  if(!user) return ctx.reply('Tidak ditemukan.');
  // show detail
  const mockCtx = { ...ctx, answerCallbackQuery: async()=>{}, editMessageText: async()=>{} };
  // directly call sendUserDetail with telegram_id
  await sendUserDetail(ctx, user.telegram_id);
}

// ── Products admin ───────────────────────────────────────────────
async function sendProductsAdmin(ctx, page=0){
  const limit=8, offset=page*limit;
  const total=(await db.query('SELECT COUNT(*)::int c FROM products')).rows[0].c;
  const totalPages=Math.max(1,Math.ceil(total/limit));
  const res=await db.query('SELECT buyer_sku_code, nama, harga_jual, is_active FROM products ORDER BY nama LIMIT $1 OFFSET $2',[limit,offset]);
  let text=`⚙️ *Produk* hal ${page+1}/${totalPages} (total ${total})\n\n`;
  for(const p of res.rows){
    text+=`${p.is_active?'✅':'❌'} \`${escapeMd(p.buyer_sku_code)}\` ${escapeMd(p.nama)} ${formatRupiah(p.harga_jual)}\n`;
  }
  const kb=new InlineKeyboard();
  for(let i=0;i<Math.min(4,res.rows.length);i++){
    const p=res.rows[i];
    kb.text(`${p.is_active?'✅':'❌'} ${p.buyer_sku_code.slice(0,8)}`, `adm_prod:${p.buyer_sku_code}`);
    if(i%2===1) kb.row();
  }
  if(res.rows.length%2===1) kb.row();
  if(totalPages>1){
    if(page>0) kb.text('⬅️ Prev',`adm_products:${page-1}`);
    kb.text(`${page+1}/${totalPages}`,'noop');
    if(page<totalPages-1) kb.text('Next ➡️',`adm_products:${page+1}`);
    kb.row();
  }
  kb.text('⬅️ Panel','adm_panel').text('❌ Tutup','close_menu');
  try{await ctx.editMessageText(text,{parse_mode:'Markdown',reply_markup:kb});await ctx.answerCallbackQuery();}
  catch(_){await ctx.reply(text,{parse_mode:'Markdown',reply_markup:kb});}
}

module.exports = {
  isAdmin,
  requireAdmin,
  sendAdminPanel,
  sendOrders,
  sendOrderDetail,
  sendTopups,
  sendMembers,
  sendUserDetail,
  sendProductsAdmin,
  handleSearch,
  adminMutateSaldo,
  getStats,
};

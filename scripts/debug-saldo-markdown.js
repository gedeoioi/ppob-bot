require('dotenv').config();
const db = require('../src/db');
const balanceService = require('../src/services/balance');

function formatRupiah(n){ return `Rp${Number(n).toLocaleString('id-ID')}` }

async function main(){
  const userRes = await db.query("SELECT id, saldo FROM users WHERE telegram_id = 2110398202");
  console.log('user', userRes.rows[0]);
  const userId = userRes.rows[0]?.id || 1;
  const fresh = await db.query('SELECT saldo FROM users WHERE id=$1',[userId]);
  const saldo = Number(fresh.rows[0].saldo);
  const mutasi = await balanceService.getMutations(userId, 5);
  console.log('mutasi rows', JSON.stringify(mutasi,null,2));
  const pendingTopup = await db.query(`SELECT ref_id, total_bayar, status FROM topups WHERE user_id=$1 AND status='pending_payment' ORDER BY created_at DESC LIMIT 1`,[userId]);
  console.log('pendingTopup', pendingTopup.rows);

  let text = `💰 *Saldo Kamu:* ${formatRupiah(saldo)}\n`;
  if(pendingTopup.rows.length){
    text += `\n⏳ Topup pending: ${pendingTopup.rows[0].ref_id} ${formatRupiah(pendingTopup.rows[0].total_bayar)} (menunggu pembayaran QRIS)`;
  }
  text += `\n\n📒 *5 Mutasi Terakhir:*\n`;
  if(mutasi.length===0) text += '_Belum ada mutasi_';
  else {
    for(const m of mutasi){
      const sign = m.amount>0?'+':'';
      text += `${new Date(m.created_at).toLocaleString('id-ID')} | ${sign}${formatRupiah(m.amount)} | ${m.reason} ${m.description?'- '+m.description:''}\n`;
    }
  }
  text += `\nGunakan /topup untuk isi saldo atau tombol ➕ Topup di bawah.`;

  console.log('--- TEXT ---');
  console.log(text);
  console.log('--- bytes ---', Buffer.byteLength(text,'utf8'));
  // find offset 292 char
  const buf = Buffer.from(text,'utf8');
  console.log('char at offset 292:', buf.slice(280,310).toString('utf8'));
  console.log('around offset bytes 285-310:', buf.slice(285,310));
  // try to find unmatched markdown
  const starCount = (text.match(/\*/g)||[]).length;
  const underscoreCount = (text.match(/_/g)||[]).length;
  console.log('star count',starCount, 'underscore',underscoreCount);
  // check each line
  text.split('\n').forEach((line,i)=>console.log(i, JSON.stringify(line)));

  // try simulate telegram markdown parse: try to find unclosed *
  // also test escaping
  function escapeMd(s){
    return String(s).replace(/([_*`\[\]])/g,'\\$1');
  }
  let safe = `💰 *Saldo Kamu:* ${formatRupiah(saldo)}\n`;
  if(pendingTopup.rows.length){
    safe += `\n⏳ Topup pending: ${escapeMd(pendingTopup.rows[0].ref_id)} ${formatRupiah(pendingTopup.rows[0].total_bayar)} (menunggu pembayaran QRIS)`;
  }
  safe += `\n\n📒 *5 Mutasi Terakhir:*\n`;
  if(mutasi.length===0) safe += '_Belum ada mutasi_';
  else {
    for(const m of mutasi){
      const sign = m.amount>0?'+':'';
      safe += `${new Date(m.created_at).toLocaleString('id-ID')} | ${sign}${formatRupiah(m.amount)} | ${escapeMd(m.reason)} ${m.description?'- '+escapeMd(m.description):''}\n`;
    }
  }
  safe += `\nGunakan /topup untuk isi saldo atau tombol ➕ Topup di bawah.`;
  console.log('\n--- SAFE TEXT ---');
  console.log(safe);

  await db.pool.end();
}
main().catch(e=>{console.error(e);process.exit(1)});

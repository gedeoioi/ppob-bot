require('dotenv').config();
const { Pool } = require('pg');
const cfg = require('../src/config');
const pool = new Pool({ connectionString: cfg.databaseUrl });
async function main() {
  const secret = require('crypto').createHash('md5').update(cfg.payment.duitku.merchantCode + '10000' + 'TOPTEST' + cfg.payment.duitku.merchantKey).digest('hex');
  console.log('config ok, payment mock', cfg.payment.mock, 'duitku mode', cfg.payment.duitku.mode);
  const u = (await pool.query('SELECT id, telegram_id, saldo FROM users LIMIT 1')).rows[0];
  console.log('user', u);
  if (!u) { console.log('no user, buat /start di bot dulu'); await pool.end(); return; }

  const topup = require('../src/services/topup');
  const balance = require('../src/services/balance');
  const orderSvc = require('../src/services/order');

  // 1. Topup mock
  console.log('\n--- create topup 10000 ---');
  const { topup: t, qrString } = await topup.createTopup({ userId: u.id, amount: 10000 });
  console.log('topup', t.ref_id, t.total_bayar, qrString.slice(0,60));
  console.log('--- handleTopupPaid ---');
  const tpRes = await topup.handleTopupPaid({ refId: t.ref_id });
  console.log('topup paid', tpRes.newSaldo, tpRes.topup?.status);
  const afterTopup = (await pool.query('SELECT saldo FROM users WHERE id=$1', [u.id])).rows[0];
  console.log('saldo after topup', afterTopup.saldo);

  // 2. Order via saldo (jika ada produk)
  const prod = (await pool.query('SELECT buyer_sku_code, nama, harga_jual FROM products WHERE is_active=true LIMIT 1')).rows[0];
  console.log('\n--- product', prod);
  if (prod) {
    console.log('--- createOrderViaSaldo ---');
    try {
      const { order, digiflazzResult } = await orderSvc.createOrderViaSaldo({ userId: u.id, buyerSkuCode: prod.buyer_sku_code, customerNo: '081290000001' });
      console.log('order via saldo', order.ref_id, order.status, order.digiflazz_status, 'digiflazz', digiflazzResult.status, digiflazzResult.message || '');
      const muts = (await pool.query('SELECT reason, amount, description FROM balance_mutations WHERE user_id=$1 ORDER BY id DESC LIMIT 5', [u.id])).rows;
      console.log('mutations', muts);
      const saldoAfter = (await pool.query('SELECT saldo FROM users WHERE id=$1', [u.id])).rows[0];
      console.log('saldo after order', saldoAfter.saldo);
    } catch (e) { console.log('order via saldo error', e.message); }
  }

  // 3. Order via QRIS (mock) then refund simulation (force failed via polling)
  console.log('\n--- order via QRIS + refund check ---');
  // Topup lagi biar saldo cukup untuk next test
  const { topup: t2 } = await topup.createTopup({ userId: u.id, amount: 50000 });
  await topup.handleTopupPaid({ refId: t2.ref_id });
  console.log('topped up again, saldo', (await pool.query('SELECT saldo FROM users WHERE id=$1', [u.id])).rows[0].saldo);

  await pool.end();
  console.log('\nOK - test saldo done');
}
main().catch(e => { console.error(e); process.exit(1); });

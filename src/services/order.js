const crypto = require('crypto');
const db = require('../db');
const { acquireLock, releaseLock } = require('../db/redis');
const digiflazz = require('./digiflazz');
const payment = require('./payment');
const config = require('../config');

function generateRefId() {
  // Prefix biar gampang dibedakan di dashboard Digiflazz/payment gateway
  return 'ORD' + Date.now() + crypto.randomBytes(3).toString('hex').toUpperCase();
}

function generateKodeUnik() {
  return Math.floor(Math.random() * 900) + 1; // 1-900, hindari 000
}

/**
 * Membuat order baru + generate QRIS untuk dibayar user.
 * Harga SELALU diambil ulang dari DB (bukan dari input user) untuk mencegah manipulasi harga.
 */
async function createOrder({ userId, buyerSkuCode, customerNo }) {
  const productRes = await db.query(
    'SELECT * FROM products WHERE buyer_sku_code = $1 AND is_active = true',
    [buyerSkuCode]
  );
  if (productRes.rows.length === 0) {
    throw new Error('Produk tidak ditemukan atau sedang tidak aktif');
  }
  const product = productRes.rows[0];

  const refId = generateRefId();
  const kodeUnik = generateKodeUnik();
  const totalBayar = Number(product.harga_jual) + kodeUnik;
  const expiredAt = new Date(Date.now() + config.app.orderExpiryMinutes * 60 * 1000);

  const orderRes = await db.query(
    `INSERT INTO orders
      (ref_id, user_id, buyer_sku_code, customer_no, harga_jual, kode_unik, total_bayar, status, expired_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending_payment',$8)
     RETURNING *`,
    [refId, userId, buyerSkuCode, customerNo, product.harga_jual, kodeUnik, totalBayar, expiredAt]
  );
  const order = orderRes.rows[0];

  const qris = await payment.createQris({
    refId,
    amount: totalBayar,
    expiredAtUnix: Math.floor(expiredAt.getTime() / 1000),
  });

  await db.query(
    `INSERT INTO payments (order_id, gateway, gateway_ref, qr_string, amount, status)
     VALUES ($1,$2,$3,$4,$5,'pending')`,
    [order.id, config.payment.gateway, qris.gatewayRef, qris.qrString, totalBayar]
  );

  return { order, qrString: qris.qrString };
}

/**
 * Update status order di DB berdasarkan hasil response Digiflazz (dipakai bareng
 * oleh handlePaymentPaid dan cron polling status pending, supaya logikanya konsisten).
 */
async function applyDigiflazzResult(orderId, result) {
  const finalStatus =
    result.status === 'Sukses' ? 'success' : result.status === 'Gagal' ? 'failed' : 'processing';

  const res = await db.query(
    `UPDATE orders
     SET status = $1, digiflazz_status = $2, digiflazz_sn = $3, updated_at = now()
     WHERE id = $4
     RETURNING *`,
    [finalStatus, result.status, result.sn || null, orderId]
  );
  return res.rows[0];
}

/**
 * Dipanggil oleh webhook handler SETELAH signature terverifikasi valid.
 * Idempotent: pakai Redis lock + cek status order supaya webhook yang
 * dikirim berkali-kali oleh provider (retry) tidak diproses dobel.
 */
async function handlePaymentPaid({ refId }) {
  const lockKey = `lock:order:${refId}`;
  const gotLock = await acquireLock(lockKey, 15000);
  if (!gotLock) {
    // Sedang diproses oleh request lain (retry webhook bersamaan) - abaikan
    return { skipped: true };
  }

  try {
    const orderRes = await db.query('SELECT * FROM orders WHERE ref_id = $1', [refId]);
    if (orderRes.rows.length === 0) throw new Error(`Order ${refId} tidak ditemukan`);
    const order = orderRes.rows[0];

    // Sudah pernah diproses sebelumnya -> jangan eksekusi Digiflazz dua kali
    if (order.status !== 'pending_payment') {
      return { skipped: true, reason: 'order sudah diproses sebelumnya' };
    }

    await db.query(
      `UPDATE orders SET status = 'processing', updated_at = now() WHERE id = $1`,
      [order.id]
    );
    await db.query(
      `UPDATE payments SET status = 'paid', paid_at = now() WHERE order_id = $1`,
      [order.id]
    );

    const result = await digiflazz.topup({
      orderId: order.id,
      refId: order.ref_id,
      buyerSkuCode: order.buyer_sku_code,
      customerNo: order.customer_no,
    });

    const updatedOrder = await applyDigiflazzResult(order.id, result);

    return { order: updatedOrder, digiflazzResult: result };
  } finally {
    await releaseLock(lockKey);
  }
}

module.exports = { createOrder, handlePaymentPaid, applyDigiflazzResult };

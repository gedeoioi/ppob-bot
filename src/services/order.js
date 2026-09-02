const crypto = require('crypto');
const db = require('../db');
const { acquireLock, releaseLock } = require('../db/redis');
const providerRouter = require('./provider');
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
 * Update status order di DB berdasarkan hasil response Digiflazz.
 * Jika status = Gagal dan order dibayar via QRIS, otomatis refund ke saldo member
 * (hanya sekali, idempotent via balance_mutations & orders.refunded).
 */
async function applyDigiflazzResult(orderId, result) {
  const finalStatus =
    result.status === 'Sukses' ? 'success' : result.status === 'Gagal' ? 'failed' : 'processing';

  // Ambil order dulu untuk tau total_bayar & user
  const orderRes = await db.query('SELECT * FROM orders WHERE id = $1', [orderId]);
  if (orderRes.rows.length === 0) throw new Error(`Order ${orderId} tidak ditemukan`);
  const order = orderRes.rows[0];

  const res = await db.query(
    `UPDATE orders
     SET status = $1, digiflazz_status = $2, digiflazz_sn = $3, updated_at = now()
     WHERE id = $4
     RETURNING *`,
    [finalStatus, result.status, result.sn || null, orderId]
  );
  const updated = res.rows[0];

  // Auto-refund jika Gagal: kembalikan total_bayar ke saldo member (hanya untuk qris, bukan saldo)
  // Untuk order via saldo, dana tidak keluar dari Digiflazz, tapi kita sudah debit saldo di createOrderViaSaldo
  // — jadi refund via saldo juga berlaku untuk keduanya, cegah double-refund via orders.refunded
  if (finalStatus === 'failed' && !order.refunded) {
    try {
      const balance = require('./balance');
      // Refund full total_bayar agar user tidak rugi kode_unik
      const refundRes = await balance.mutateBalance({
        userId: order.user_id,
        amount: Number(order.total_bayar),
        reason: 'refund',
        orderId: order.id,
        description: `Refund order ${order.ref_id} gagal Digiflazz (${result.message || result.status})`,
      });
      if (!refundRes.skipped) {
        await db.query('UPDATE orders SET refunded = true WHERE id = $1', [order.id]);
        updated.refunded = true;
        updated.refundAmount = Number(order.total_bayar);
      }
    } catch (e) {
      // Jangan gagalkan status failed hanya karena refund gagal — log saja, admin bisa retry manual
      console.error(`[order:refund] gagal refund order ${order.ref_id}:`, e.message);
    }
  }

  return updated;
}

/**
 * Buat order dengan metode pembayaran saldo (potong saldo langsung, tanpa QRIS).
 */
async function createOrderViaSaldo({ userId, buyerSkuCode, customerNo }) {
  const productRes = await db.query(
    'SELECT * FROM products WHERE buyer_sku_code = $1 AND is_active = true',
    [buyerSkuCode]
  );
  if (productRes.rows.length === 0) throw new Error('Produk tidak ditemukan atau sedang tidak aktif');
  const product = productRes.rows[0];

  const hargaJual = Number(product.harga_jual);
  // Untuk saldo tidak perlu kode_unik — bayar pas harga_jual
  const totalBayar = hargaJual;

  // Validasi & potong saldo atomik
  const balance = require('./balance');
  // Cek dulu tanpa mutasi untuk pesan error lebih jelas
  const saldoRes = await db.query('SELECT saldo FROM users WHERE id = $1', [userId]);
  const saldoNow = Number(saldoRes.rows[0]?.saldo || 0);
  if (saldoNow < totalBayar) {
    throw new Error(`Saldo tidak cukup. Saldo: Rp${saldoNow.toLocaleString('id-ID')}, harga: Rp${totalBayar.toLocaleString('id-ID')}. Topup dulu via /topup`);
  }

  const refId = generateRefId();
  const kodeUnik = 0;

  // Insert order dengan payment_source saldo
  const orderRes = await db.query(
    `INSERT INTO orders (ref_id, user_id, buyer_sku_code, customer_no, harga_jual, kode_unik, total_bayar, status, expired_at, payment_source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'processing', now() + interval '1 day', 'saldo')
     RETURNING *`,
    [refId, userId, buyerSkuCode, customerNo, hargaJual, kodeUnik, totalBayar]
  );
  const order = orderRes.rows[0];

  // Debit saldo
  await balance.mutateBalance({
    userId,
    amount: -totalBayar,
    reason: 'order_payment',
    orderId: order.id,
    description: `Pembayaran order ${refId} ${product.nama}`,
  });

  // Langsung hit provider aktif (digiflazz / tokovoucher)
  const providerSvc = providerRouter.getProviderService();
  const result = await providerSvc.topup({
    orderId: order.id,
    refId: order.ref_id,
    buyerSkuCode: order.buyer_sku_code,
    customerNo: order.customer_no,
  });

  const updatedOrder = await applyDigiflazzResult(order.id, result);
  return { order: updatedOrder, digiflazzResult: result };
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

    const providerSvc = providerRouter.getProviderService();
    const result = await providerSvc.topup({
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

module.exports = { createOrder, createOrderViaSaldo, handlePaymentPaid, applyDigiflazzResult };

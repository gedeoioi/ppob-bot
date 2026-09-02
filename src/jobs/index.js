const cron = require('node-cron');
const db = require('../db');
const { acquireLock, releaseLock } = require('../db/redis');
const digiflazz = require('../services/digiflazz');
const orderService = require('../services/order');

/**
 * Cari order yang statusnya masih 'pending_payment' tapi sudah lewat expired_at,
 * lalu ubah jadi 'expired'. Ini yang bikin kode_unik order lama bisa "dipakai ulang"
 * secara alami oleh order baru (karena keduanya digenerate random 1-900).
 */
async function expireOrders() {
  const res = await db.query(
    `UPDATE orders SET status = 'expired', updated_at = now()
     WHERE status = 'pending_payment' AND expired_at < now()
     RETURNING id, ref_id`
  );

  if (res.rows.length > 0) {
    console.log(`[cron:expire] ${res.rows.length} order kedaluwarsa diubah jadi 'expired':`,
      res.rows.map((o) => o.ref_id).join(', '));

    // Payment terkait juga ditandai expired biar konsisten
    const orderIds = res.rows.map((o) => o.id);
    await db.query(
      `UPDATE payments SET status = 'expired' WHERE order_id = ANY($1) AND status = 'pending'`,
      [orderIds]
    );
  }
}

/**
 * Cari order yang statusnya 'processing' dengan digiflazz_status 'Pending',
 * lalu cek ulang statusnya ke Digiflazz. Hanya proses order yang SUDAH LEBIH
 * DARI 1 MENIT sejak update terakhir, sesuai anjuran Digiflazz supaya tidak
 * dianggap spam request untuk ref_id yang sama.
 *
 * @param {(order: object) => Promise<void>} onOrderFinalized - callback dipanggil
 *   saat status order berubah jadi final (success/failed), misal untuk notifikasi Telegram.
 */
async function pollPendingDigiflazzOrders(onOrderFinalized) {
  const res = await db.query(
    `SELECT * FROM orders
     WHERE status = 'processing' AND digiflazz_status = 'Pending'
       AND updated_at < now() - interval '1 minute'
     ORDER BY updated_at ASC
     LIMIT 20`
  );

  if (res.rows.length === 0) return;
  console.log(`[cron:poll-status] Mengecek ulang ${res.rows.length} order berstatus Pending...`);

  for (const order of res.rows) {
    const lockKey = `lock:order:${order.ref_id}`;
    // Pakai lock yang sama dengan handlePaymentPaid supaya tidak race
    // kalau kebetulan callback Digiflazz datang bersamaan dengan polling ini.
    const gotLock = await acquireLock(lockKey, 15000);
    if (!gotLock) continue;

    try {
      const result = await digiflazz.checkStatus({
        orderId: order.id,
        refId: order.ref_id,
        buyerSkuCode: order.buyer_sku_code,
        customerNo: order.customer_no,
      });

      const updatedOrder = await orderService.applyDigiflazzResult(order.id, result);

      if (updatedOrder.status !== 'processing') {
        console.log(`[cron:poll-status] Order ${order.ref_id} -> ${updatedOrder.status}`);
        if (onOrderFinalized) await onOrderFinalized(updatedOrder);
      }
    } catch (err) {
      console.error(`[cron:poll-status] Gagal cek status order ${order.ref_id}:`, err.message);
    } finally {
      await releaseLock(lockKey);
    }
  }
}

/**
 * Daftarkan semua cron job. Dipanggil sekali saat aplikasi start (lihat src/index.js).
 */
function startJobs({ onOrderFinalized } = {}) {
  // Tiap 1 menit: cek order kedaluwarsa
  cron.schedule('* * * * *', () => {
    expireOrders().catch((err) => console.error('[cron:expire] error:', err.message));
  });

  // Tiap 2 menit: cek ulang order yang masih Pending di Digiflazz
  cron.schedule('*/2 * * * *', () => {
    pollPendingDigiflazzOrders(onOrderFinalized).catch((err) =>
      console.error('[cron:poll-status] error:', err.message)
    );
  });

  console.log('[cron] Job auto-expire (tiap 1 menit) dan poll-status (tiap 2 menit) aktif.');
}

module.exports = { startJobs, expireOrders, pollPendingDigiflazzOrders };

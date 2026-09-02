const cron = require('node-cron');
const db = require('../db');
const { acquireLock, releaseLock } = require('../db/redis');
const providerRouter = require('../services/provider');
const orderService = require('../services/order');
const topupService = require('../services/topup');
const logger = require('../logger');

const tasks = [];

async function expireOrders() {
  const res = await db.query(
    `UPDATE orders SET status = 'expired', updated_at = now()
     WHERE status = 'pending_payment' AND expired_at < now()
     RETURNING id, ref_id`
  );
  if (res.rows.length > 0) {
    logger.info({ count: res.rows.length, refIds: res.rows.map((o) => o.ref_id) }, '[cron:expire] orders expired');
    const orderIds = res.rows.map((o) => o.id);
    await db.query(`UPDATE payments SET status = 'expired' WHERE order_id = ANY($1) AND status = 'pending'`, [orderIds]);
  }
}

async function expireTopups() {
  const rows = await topupService.expireTopups();
  if (rows.length > 0) {
    logger.info({ count: rows.length, refIds: rows.map((r) => r.ref_id) }, '[cron:expire] topups expired');
  }
}

async function pollPendingDigiflazzOrders(onOrderFinalized) {
  const res = await db.query(
    `SELECT * FROM orders
     WHERE status = 'processing' AND digiflazz_status = 'Pending'
       AND updated_at < now() - interval '1 minute'
     ORDER BY updated_at ASC
     LIMIT 20`
  );
  if (res.rows.length === 0) return;
  logger.info({ count: res.rows.length }, '[cron:poll-status] checking pending orders');
  for (const order of res.rows) {
    const lockKey = `lock:order:${order.ref_id}`;
    const gotLock = await acquireLock(lockKey, 15000);
    if (!gotLock) continue;
    try {
      // Provider per-order (kolom orders.provider), fallback ke global jika kosong (order lama)
      const providerSvc = providerRouter.getProviderServiceForOrder(order);
      const providerName = (order.provider || providerRouter.currentProvider()).toLowerCase();
      // TokoVoucher docs anjurkan polling max tiap 10 menit
      if (providerName === 'tokovoucher') {
        const lastUpdate = new Date(order.updated_at).getTime();
        if (Date.now() - lastUpdate < 10 * 60 * 1000) continue;
      }
      const result = await providerSvc.checkStatus({
        orderId: order.id,
        refId: order.ref_id,
        buyerSkuCode: order.buyer_sku_code,
        customerNo: order.customer_no,
      });
      const updatedOrder = await orderService.applyDigiflazzResult(order.id, result);
      if (updatedOrder.status !== 'processing') {
        logger.info({ refId: order.ref_id, status: updatedOrder.status, refunded: updatedOrder.refunded }, '[cron:poll-status] order finalized');
        if (onOrderFinalized) await onOrderFinalized(updatedOrder);
      }
    } catch (err) {
      logger.error({ err: err.message, refId: order.ref_id }, '[cron:poll-status] check failed');
    } finally {
      await releaseLock(lockKey);
    }
  }
}

function startJobs({ onOrderFinalized } = {}) {
  const t1 = cron.schedule('* * * * *', () => {
    expireOrders().catch((err) => logger.error({ err: err.message }, '[cron:expire] error'));
    expireTopups().catch((err) => logger.error({ err: err.message }, '[cron:expire-topup] error'));
  });
  const t2 = cron.schedule('*/2 * * * *', () => {
    pollPendingDigiflazzOrders(onOrderFinalized).catch((err) =>
      logger.error({ err: err.message }, '[cron:poll-status] error')
    );
  });
  tasks.push(t1, t2);
  logger.info('[cron] jobs active: auto-expire (1m) + poll-status (2m) + expire-topup (1m)');
}

function stopJobs() {
  for (const t of tasks) t.stop();
  tasks.length = 0;
  logger.info('[cron] jobs stopped');
}

module.exports = { startJobs, stopJobs, expireOrders, expireTopups, pollPendingDigiflazzOrders };

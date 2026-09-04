const crypto = require('crypto');
const db = require('../db');
const { acquireLock, releaseLock } = require('../db/redis');
const payment = require('./payment');
const balance = require('./balance');
const config = require('../config');

function generateRefId() {
  return 'TOP' + Date.now() + crypto.randomBytes(2).toString('hex').toUpperCase();
}

function generateKodeUnik() {
  return Math.floor(Math.random() * 900) + 1;
}

const MIN_TOPUP = parseInt(process.env.TOPUP_MIN_AMOUNT || '10000', 10);
const MAX_TOPUP = parseInt(process.env.TOPUP_MAX_AMOUNT || '1000000', 10);

async function createTopup({ userId, amount }) {
  const nominal = Number(amount);
  if (!Number.isFinite(nominal) || nominal < MIN_TOPUP) throw new Error(`Minimal topup ${MIN_TOPUP.toLocaleString('id-ID')} rupiah.`);
  if (nominal > MAX_TOPUP) throw new Error(`Maksimal topup ${MAX_TOPUP.toLocaleString('id-ID')} rupiah.`);

  const kodeUnik = generateKodeUnik();
  const totalBayar = nominal + kodeUnik;
  const refId = generateRefId();
  const expiredAt = new Date(Date.now() + config.app.orderExpiryMinutes * 60 * 1000);

  const res = await db.query(
    `INSERT INTO topups (ref_id, user_id, amount, kode_unik, total_bayar, status, gateway, expired_at)
     VALUES ($1,$2,$3,$4,$5,'pending_payment',$6,$7) RETURNING *`,
    [refId, userId, nominal, kodeUnik, totalBayar, payment.currentGateway(), expiredAt]
  );
  const topup = res.rows[0];

  const qris = await payment.createQris({
    refId,
    amount: totalBayar,
    expiredAtUnix: Math.floor(expiredAt.getTime() / 1000),
    productName: `Topup saldo ${nominal.toLocaleString('id-ID')}`,
  });

  await db.query('UPDATE topups SET gateway_ref = $1, qr_string = $2, updated_at = now() WHERE id = $3', [
    qris.gatewayRef,
    qris.qrString,
    topup.id,
  ]);

  return { topup: { ...topup, gateway_ref: qris.gatewayRef, qr_string: qris.qrString }, qrString: qris.qrString };
}

/**
 * Dipanggil webhook setelah pembayaran QRIS topup sukses (resultCode 00).
 * Idempotent via Redis lock + cek status.
 */
async function handleTopupPaid({ refId }) {
  const lockKey = `lock:topup:${refId}`;
  const gotLock = await acquireLock(lockKey, 15000);
  if (!gotLock) return { skipped: true };

  try {
    const res = await db.query('SELECT * FROM topups WHERE ref_id = $1', [refId]);
    if (res.rows.length === 0) throw new Error(`Topup ${refId} tidak ditemukan`);
    const topup = res.rows[0];

    if (topup.status !== 'pending_payment') {
      return { skipped: true, reason: 'topup sudah diproses' };
    }

    // Kredit saldo + catat mutasi — amount yang dikreditkan = nominal topup (amount), BUKAN total_bayar
    // total_bayar = amount + kode_unik, kode unik dianggap biaya layanan / donasi kecil
    // Jika ingin kredit full total_bayar, ganti jadi topup.total_bayar
    const creditAmount = Number(topup.amount);

    await db.query(`UPDATE topups SET status = 'success', paid_at = now(), updated_at = now() WHERE id = $1`, [topup.id]);

    const result = await balance.mutateBalance({
      userId: topup.user_id,
      amount: creditAmount,
      reason: 'topup',
      topupId: topup.id,
      description: `Topup ${topup.ref_id} Rp${creditAmount.toLocaleString('id-ID')} via QRIS`,
    });

    // Jika mutateBalance skip karena sudah ada, tetap anggap sukses (idempotent)
    const updated = (await db.query('SELECT * FROM topups WHERE id = $1', [topup.id])).rows[0];
    const userRes = await db.query('SELECT saldo FROM users WHERE id = $1', [topup.user_id]);

    return { topup: updated, newSaldo: Number(userRes.rows[0].saldo), skipped: result.skipped || false };
  } finally {
    await releaseLock(lockKey);
  }
}

async function expireTopups() {
  const res = await db.query(
    `UPDATE topups SET status = 'expired', updated_at = now()
     WHERE status = 'pending_payment' AND expired_at < now()
     RETURNING ref_id`
  );
  return res.rows;
}

module.exports = { createTopup, handleTopupPaid, expireTopups, MIN_TOPUP, MAX_TOPUP };

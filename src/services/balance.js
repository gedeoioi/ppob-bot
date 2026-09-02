const db = require('../db');

/**
 * Tambah/kurangi saldo user secara atomik + catat mutasi.
 * amount positif = kredit, negatif = debit.
 * Idempotent untuk refund: cek balance_mutations existing sebelum insert jika reason=refund.
 */
async function mutateBalance({ userId, amount, reason, orderId = null, topupId = null, description = null }) {
  return db.withTransaction(async (client) => {
    // Idempotensi refund: jika sudah ada mutasi refund untuk order/topup ini, skip
    if (reason === 'refund' && orderId) {
      const exist = await client.query(
        `SELECT id FROM balance_mutations WHERE order_id = $1 AND reason = 'refund' LIMIT 1`,
        [orderId]
      );
      if (exist.rows.length > 0) return { skipped: true, reason: 'refund sudah ada' };
    }
    if (reason === 'topup' && topupId) {
      const exist = await client.query(
        `SELECT id FROM balance_mutations WHERE topup_id = $1 AND reason = 'topup' LIMIT 1`,
        [topupId]
      );
      if (exist.rows.length > 0) return { skipped: true, reason: 'topup sudah dikreditkan' };
    }

    // Lock baris user untuk cegah race
    const userRes = await client.query('SELECT id, saldo FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (userRes.rows.length === 0) throw new Error('User tidak ditemukan');
    const currentSaldo = Number(userRes.rows[0].saldo);

    // Cegah saldo minus jika debit
    if (amount < 0 && currentSaldo + amount < 0) {
      throw new Error(`Saldo tidak cukup. Saldo: Rp${currentSaldo.toLocaleString('id-ID')}, butuh: Rp${Math.abs(amount).toLocaleString('id-ID')}`);
    }

    const newSaldo = currentSaldo + amount;
    await client.query('UPDATE users SET saldo = $1, updated_at = now() WHERE id = $2', [newSaldo, userId]);

    const mutRes = await client.query(
      `INSERT INTO balance_mutations (user_id, order_id, topup_id, amount, reason, description)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [userId, orderId, topupId, amount, reason, description]
    );

    return { mutation: mutRes.rows[0], newSaldo, oldSaldo: currentSaldo };
  });
}

async function getSaldo(userId) {
  const res = await db.query('SELECT saldo FROM users WHERE id = $1', [userId]);
  if (res.rows.length === 0) throw new Error('User tidak ditemukan');
  return Number(res.rows[0].saldo);
}

async function getMutations(userId, limit = 10) {
  const res = await db.query(
    `SELECT amount, reason, description, created_at FROM balance_mutations
     WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return res.rows;
}

module.exports = { mutateBalance, getSaldo, getMutations };

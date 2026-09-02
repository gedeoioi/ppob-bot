/**
 * Tandai order yang dibuat dengan kredensial lama sebagai failed dengan pesan jelas,
 * agar tidak terus di-poll dengan signature lama dan bikin log "Signature Anda salah" berulang.
 * Jalankan: node scripts/fix-pending-orders.js
 */
require('dotenv').config();
const { Pool } = require('pg');
const crypto = require('crypto');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  // Cari order yang masih processing/pending tapi dibuat sebelum rotasi kredensial
  // Di kasus ini: ref ORD1788352444517222866 dibuat dengan sign lama ebeac93...
  const cfg = require('../src/config');
  const res = await pool.query(
    `SELECT id, ref_id FROM orders WHERE status = 'processing' AND digiflazz_status = 'Pending' ORDER BY id`
  );
  console.log(`Found ${res.rows.length} pending processing orders`);

  let fixed = 0;
  for (const o of res.rows) {
    // Cek log pertama untuk order ini — jika sign != expected sekarang, berarti dibuat dengan kredensial lama
    const logs = await pool.query(
      `SELECT request_payload FROM digiflazz_logs WHERE order_id = $1 ORDER BY id LIMIT 1`,
      [o.id]
    );
    const oldSign = logs.rows[0]?.request_payload?.sign;
    const expected = crypto.createHash('md5').update(cfg.digiflazz.username + cfg.digiflazz.apiKey + o.ref_id).digest('hex');
    if (oldSign && oldSign !== expected) {
      console.log(`- ${o.ref_id}: old sign ${oldSign} != expected ${expected} -> marking as failed (kredensial lama)`);
      await pool.query(
        `UPDATE orders SET status = 'failed', digiflazz_status = 'Gagal', updated_at = now() WHERE id = $1`,
        [o.id]
      );
      await pool.query(
        `INSERT INTO digiflazz_logs (order_id, action, request_payload, response_payload) VALUES ($1,'koreksi-kredensial-lama',$2,$3)`,
        [o.id, { ref_id: o.ref_id, oldSign, expected }, { message: 'Order dibuat dengan kredensial Digiflazz lama sebelum rotasi. Tidak bisa dicek ulang. Order ditandai gagal, silakan buat order baru.' }]
      );
      fixed++;
    } else {
      console.log(`- ${o.ref_id}: sign OK (${oldSign}) skip`);
    }
  }

  // Juga tandai order pending_payment yang sudah expired tapi belum di-expire cron
  const expired = await pool.query(
    `UPDATE orders SET status = 'expired', updated_at = now() WHERE status = 'pending_payment' AND expired_at < now() RETURNING ref_id`
  );
  if (expired.rows.length) console.log(`Expired ${expired.rows.length} pending_payment:`, expired.rows.map(r=>r.ref_id).join(', '));

  console.log(`Done. Fixed ${fixed} stale pending orders.`);
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });

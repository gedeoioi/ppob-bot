const { Pool } = require('pg');
const config = require('../config');

const pool = new Pool({ connectionString: config.databaseUrl });

pool.on('error', (err) => {
  // Jangan biarkan koneksi idle yang error mematikan seluruh proses bot
  console.error('[db] Unexpected error on idle client', err);
});

/**
 * Query sederhana. Untuk transaksi (butuh BEGIN/COMMIT) gunakan withTransaction().
 */
async function query(text, params) {
  return pool.query(text, params);
}

/**
 * Helper transaksi DB - WAJIB dipakai untuk operasi yang menyentuh saldo/order
 * supaya tidak ada race condition (misal: cek saldo lalu potong saldo harus atomik).
 */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };

/**
 * Jalankan schema.sql ke database menggunakan koneksi pg langsung dari Node.
 * Tidak butuh perintah `psql` terpasang di PATH sistem - cocok untuk Windows
 * yang sering belum ada psql di PATH secara default.
 *
 * Cara pakai: npm run migrate
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const config = require('../src/config');

async function main() {
  const schemaPath = path.join(__dirname, '..', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  const pool = new Pool({ connectionString: config.databaseUrl });

  console.log('Menjalankan schema.sql ke database...');
  try {
    // pool.query dengan multi-statement string (tanpa parameter) otomatis
    // pakai "simple query protocol" pg yang mendukung banyak statement SQL sekaligus.
    await pool.query(sql);
    console.log('Migrasi berhasil! Semua tabel sudah dibuat/diperbarui.');
  } catch (err) {
    console.error('Migrasi gagal:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();

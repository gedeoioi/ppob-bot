const { Pool } = require('pg');
const config = require('../config');

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: parseInt(process.env.PG_POOL_MAX || '10', 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  // Enable SSL when DATABASE_URL points to managed Postgres (e.g. Neon/Supabase) or when PGSSLMODE=require
  ssl:
    process.env.PGSSLMODE === 'require' || config.databaseUrl.includes('sslmode=require')
      ? { rejectUnauthorized: false }
      : undefined,
  application_name: 'ppob-bot',
});

pool.on('error', (err) => {
  // Jangan biarkan koneksi idle yang error mematikan seluruh proses bot
  console.error('[db] Unexpected error on idle client', err.message);
});

async function query(text, params) {
  return pool.query(text, params);
}

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

async function checkHealth() {
  await pool.query('SELECT 1');
}

async function close() {
  await pool.end();
}

module.exports = { pool, query, withTransaction, checkHealth, close };

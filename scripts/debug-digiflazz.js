require('dotenv').config();
const { Pool } = require('pg');
const crypto = require('crypto');
const cfg = require('../src/config');

const pool = new Pool({ connectionString: cfg.databaseUrl });

async function main() {
  const ref = process.argv[2] || 'ORD1788352444517222866';
  const r = await pool.query('SELECT * FROM orders WHERE ref_id = $1', [ref]);
  console.log('=== orders ===');
  console.log(JSON.stringify(r.rows, null, 2));
  if (r.rows.length === 0) {
    const all = await pool.query('SELECT ref_id, buyer_sku_code, customer_no, status, digiflazz_status, created_at FROM orders ORDER BY id DESC LIMIT 8');
    console.log('=== recent orders ===');
    console.log(JSON.stringify(all.rows, null, 2));
    await pool.end();
    return;
  }
  const id = r.rows[0].id;
  const logs = await pool.query('SELECT action, request_payload, response_payload, created_at FROM digiflazz_logs WHERE order_id = $1 ORDER BY id', [id]);
  console.log('=== digiflazz_logs ===');
  for (const lg of logs.rows) {
    console.log('---', lg.action, lg.created_at);
    console.log('req:', JSON.stringify(lg.request_payload, null, 2));
    console.log('res:', JSON.stringify(lg.response_payload, null, 2));
    const reqSign = lg.request_payload?.sign;
    const expected = crypto.createHash('md5').update(cfg.digiflazz.username + cfg.digiflazz.apiKey + ref).digest('hex');
    console.log('sign in DB:', reqSign);
    console.log('sign expected now (username+apiKey+refId):', expected, reqSign === expected ? 'MATCH' : 'MISMATCH');
  }
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });

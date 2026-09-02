require('dotenv').config();
const { Pool } = require('pg');
const crypto = require('crypto');
const cfg = require('../src/config');
(async () => {
  const pool = new Pool({ connectionString: cfg.databaseUrl });
  const ref = process.argv[2];
  let rows;
  if (ref) {
    rows = (await pool.query('SELECT * FROM orders WHERE ref_id=$1', [ref])).rows;
  } else {
    rows = (await pool.query('SELECT * FROM orders ORDER BY id DESC LIMIT 1')).rows;
  }
  console.log('latest order:', JSON.stringify(rows[0], null, 2));
  if (!rows[0]) { await pool.end(); return; }
  const id = rows[0].id;
  const refId = rows[0].ref_id;
  const logs = (await pool.query('SELECT action, request_payload, response_payload, created_at FROM digiflazz_logs WHERE order_id=$1 ORDER BY id DESC LIMIT 2', [id])).rows;
  console.log('logs:', JSON.stringify(logs, null, 2));
  const md5 = s => crypto.createHash('md5').update(s).digest('hex');
  const u = String(cfg.digiflazz.username).trim();
  const k = String(cfg.digiflazz.apiKey).trim();
  console.log('creds username=['+u+'] len='+u.length+' hex='+Buffer.from(u).toString('hex'));
  console.log('creds apiKey=['+k+'] len='+k.length+' hex='+Buffer.from(k).toString('hex'));
  console.log('expected sign md5(u+k+ref):', md5(u+k+refId));
  if (logs[0]) console.log('sign in last log:', logs[0].request_payload?.sign);
  // live test with a dummy ref to see if signature logic matches server
  const dummyRef = 'ORDTEST' + Date.now();
  const dummySign = md5(u+k+dummyRef);
  console.log('dummy ref test', dummyRef, 'sign', dummySign);
  const axios = require('axios');
  try {
    const { data } = await axios.post(cfg.digiflazz.baseUrl + '/transaction', {
      username: u,
      buyer_sku_code: rows[0].buyer_sku_code,
      customer_no: rows[0].customer_no,
      ref_id: dummyRef,
      sign: dummySign,
      testing: true
    }, { timeout: 8000 });
    console.log('dummy transaction response:', JSON.stringify(data,null,2).slice(0,1500));
  } catch(e) {
    console.log('dummy transaction error:', JSON.stringify(e.response?.data || e.message,null,2).slice(0,1500));
  }
  await pool.end();
})();

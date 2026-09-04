/**
 * Simulasi callback iPaymu sukses ke /webhook/ipaymu lokal.
 * Jalankan: node scripts/test-ipaymu-webhook.js [ORDxxx|TOPxxx]
 */
const crypto = require('crypto');
const http = require('http');
const config = require('../src/config');
const db = require('../src/db');

function sortedJson(obj) {
  const sorted = Object.keys(obj).sort((a, b) => a.localeCompare(b)).reduce((acc, k) => { acc[k] = obj[k]; return acc; }, {});
  return JSON.stringify(sorted).replace(/\//g, '\\/');
}

async function main() {
  const refArg = process.argv[2];
  let refId = refArg;
  if (!refId) {
    const r = await db.query(`SELECT ref_id FROM orders WHERE status='pending_payment' ORDER BY created_at DESC LIMIT 1`);
    if (!r.rows.length) {
      const t = await db.query(`SELECT ref_id FROM topups WHERE status='pending_payment' ORDER BY created_at DESC LIMIT 1`);
      if (!t.rows.length) throw new Error('Tidak ada order/topup pending_payment.');
      refId = t.rows[0].ref_id;
    } else refId = r.rows[0].ref_id;
  }
  console.log('refId:', refId);

  const va = config.payment.ipaymu.va || '1179000899';
  const body = {
    trx_id: 12345678,
    sid: 'SESSION-TEST',
    reference_id: refId,
    referenceId: refId,
    status: 'berhasil',
    status_code: 1,
    status_desc: 'Success',
    transaction_status_code: 1,
    amount: '10000',
    total: '10000',
    sub_total: '10000',
    fee: '0',
    paid_off: 10000,
    via: 'qris',
    channel: 'mpm',
    merchant: va,
    is_escrow: false,
    additional_info: [],
  };
  const signature = crypto.createHmac('sha256', va).update(sortedJson(body)).digest('hex');
  console.log('signature:', signature.slice(0, 16) + '...');

  const payload = JSON.stringify(body);
  const req = http.request({
    host: 'localhost', port: config.app.port, path: '/webhook/ipaymu', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'X-Signature': signature },
  }, (res) => {
    let data = '';
    res.on('data', (c) => (data += c));
    res.on('end', () => { console.log('status:', res.statusCode, 'body:', data); process.exit(0); });
  });
  req.on('error', (e) => { console.error(e.message); process.exit(1); });
  req.write(payload);
  req.end();
}

main().catch((e) => { console.error(e.message); process.exit(1); });

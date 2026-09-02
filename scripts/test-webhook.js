/**
 * Script simulasi callback Duitku "pembayaran sukses", untuk uji coba lokal
 * TANPA perlu ngrok atau akun Duitku beneran.
 *
 * Cara pakai:
 *   node scripts/test-webhook.js                 -> ambil order pending_payment TERBARU otomatis
 *   node scripts/test-webhook.js ORD1234567ABCDE  -> pakai ref_id order tertentu
 *
 * Script ini akan:
 * 1. Mencari order di DB (berdasarkan ref_id yang dikasih, atau yang terbaru berstatus pending_payment)
 * 2. Menghitung signature yang BENAR persis seperti cara Duitku menghitungnya
 * 3. Mengirim POST ke endpoint /webhook/duitku lokal, seolah-olah dari Duitku
 *
 * PENTING: pastikan aplikasi utama (npm run dev / npm start) sedang berjalan
 * di terminal lain sebelum menjalankan script ini.
 */
const crypto = require('crypto');
const http = require('http');
const { URLSearchParams } = require('url');
const config = require('../src/config');
const db = require('../src/db');

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

async function findOrder(refIdArg) {
  if (refIdArg) {
    const res = await db.query('SELECT * FROM orders WHERE ref_id = $1', [refIdArg]);
    if (res.rows.length === 0) {
      throw new Error(`Order dengan ref_id "${refIdArg}" tidak ditemukan.`);
    }
    return res.rows[0];
  }

  const res = await db.query(
    `SELECT * FROM orders WHERE status = 'pending_payment' ORDER BY created_at DESC LIMIT 1`
  );
  if (res.rows.length === 0) {
    throw new Error(
      'Tidak ada order berstatus pending_payment. Buat order dulu lewat bot (/produk), baru jalankan script ini.'
    );
  }
  return res.rows[0];
}

function sendWebhook({ host, port, path, formBody }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host,
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(formBody),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    req.write(formBody);
    req.end();
  });
}

async function main() {
  const refIdArg = process.argv[2];
  const { merchantCode, merchantKey } = config.payment.duitku;

  console.log('Mencari order...');
  const order = await findOrder(refIdArg);
  console.log(`Order ditemukan: ref_id=${order.ref_id}, total_bayar=${order.total_bayar}, status=${order.status}`);

  if (order.status !== 'pending_payment') {
    console.warn(
      `Peringatan: status order ini sudah "${order.status}" (bukan pending_payment). ` +
        `Webhook tetap dikirim, tapi handlePaymentPaid() akan skip karena sudah pernah diproses.`
    );
  }

  const amount = String(order.total_bayar);
  const merchantOrderId = order.ref_id;
  const signature = md5(`${merchantCode}${amount}${merchantOrderId}${merchantKey}`);

  const formBody = new URLSearchParams({
    merchantCode,
    amount,
    merchantOrderId,
    productDetail: 'Pembayaran PPOB (simulasi test-webhook.js)',
    additionalParam: '',
    paymentCode: 'SP',
    resultCode: '00', // 00 = sukses
    merchantUserId: '',
    reference: 'TESTREF' + Date.now(),
    signature,
  }).toString();

  // Ambil host & port dari PUBLIC_BASE_URL kalau diisi localhost, atau default ke localhost:PORT
  const port = config.app.port;
  console.log(`Mengirim simulasi webhook ke http://localhost:${port}/webhook/duitku ...`);

  const result = await sendWebhook({
    host: 'localhost',
    port,
    path: '/webhook/duitku',
    formBody,
  });

  console.log(`Response status: ${result.statusCode}`);
  console.log(`Response body: ${result.body}`);
  console.log('\nCek terminal aplikasi utama (npm run dev) untuk lihat log proses topup ke Digiflazz.');

  process.exit(0);
}

main().catch((err) => {
  console.error('Gagal menjalankan simulasi webhook:', err.message);
  process.exit(1);
});

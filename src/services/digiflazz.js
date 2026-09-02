const axios = require('axios');
const crypto = require('crypto');
const config = require('../config');
const db = require('../db');

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

function getCreds() {
  // Baca fresh dari config tiap request — cegah stale setelah rotasi kredensial + restart
  // Trim untuk hindari spasi/newline yang sering kebawa dari copy-paste dashboard
  return {
    username: String(config.digiflazz.username).trim(),
    apiKey: String(config.digiflazz.apiKey).trim(),
    baseUrl: String(config.digiflazz.baseUrl).trim(),
  };
}

/**
 * Ambil daftar harga produk prabayar dari Digiflazz.
 * Panggil ini secara berkala (cron/interval), JANGAN setiap kali user buka menu,
 * supaya tidak membebani API dan supaya harga_jual di DB tetap konsisten.
 */
async function getPriceList() {
  const { username, apiKey, baseUrl } = getCreds();
  const sign = md5(`${username}${apiKey}pricelist`);
  const { data } = await axios.post(`${baseUrl}/price-list`, {
    cmd: 'prepaid',
    username,
    sign,
  });
  return data.data; // array produk
}

/**
 * Eksekusi topup/transaksi ke Digiflazz.
 * PENTING soal idempotensi:
 * - refId HARUS sama persis dengan orders.ref_id yang sudah dibuat di DB kita.
 * - Kalau Digiflazz balas status "Pending", jangan generate refId baru -
 *   ulangi request dengan refId yang SAMA untuk mendapat status terbaru.
 * - Jangan panggil ulang untuk refId yang sama dalam interval < 1 menit.
 */
async function topup({ orderId, refId, buyerSkuCode, customerNo }) {
  const { username, apiKey, baseUrl } = getCreds();
  const sign = md5(`${username}${apiKey}${refId}`);
  const payload = {
    username,
    buyer_sku_code: buyerSkuCode,
    customer_no: customerNo,
    ref_id: refId,
    sign,
    ...(config.digiflazz.testing ? { testing: true } : {}),
  };

  let responseData;
  try {
    const { data } = await axios.post(`${baseUrl}/transaction`, payload);
    responseData = data;
  } catch (err) {
    // Digiflazz kadang balas HTTP non-2xx (400/500) dengan body JSON yang tetap
    // berisi detail errornya di err.response.data - itu yang penting untuk debug,
    // BUKAN objek axios error yang panjang dan bikin bingung di console.
    responseData = err.response?.data || { error: err.message };
    console.error('[digiflazz:topup] Request gagal. Response dari Digiflazz:', JSON.stringify(responseData, null, 2));
  }

  await db.query(
    `INSERT INTO digiflazz_logs (order_id, action, request_payload, response_payload)
     VALUES ($1, 'topup', $2, $3)`,
    [orderId, payload, responseData]
  );

  if (!responseData.data) {
    throw new Error(`Digiflazz tidak mengembalikan data yang valid: ${JSON.stringify(responseData)}`);
  }

  return responseData.data; // { ref_id, status: 'Sukses'|'Gagal'|'Pending', sn, message, rc, ... }
}

/**
 * Cek ulang status transaksi PREPAID yang sebelumnya "Pending".
 * Dipakai oleh cron polling untuk status yang belum final.
 *
 * PENTING: Digiflazz TIDAK punya endpoint/command cek-status terpisah untuk produk
 * prepaid (beda dengan pascabayar yang pakai commands:'status-pasca'). Cara yang
 * benar untuk prepaid: kirim ULANG payload yang PERSIS SAMA (ref_id sama) ke
 * endpoint /transaction - karena ref_id bersifat idempotent di sisi Digiflazz,
 * mereka akan balas status TERBARU tanpa membuat transaksi baru/dobel charge.
 */
async function checkStatus({ orderId, refId, buyerSkuCode, customerNo }) {
  const { username, apiKey, baseUrl } = getCreds();
  const sign = md5(`${username}${apiKey}${refId}`);
  const payload = {
    username,
    buyer_sku_code: buyerSkuCode,
    customer_no: customerNo,
    ref_id: refId,
    sign,
    ...(config.digiflazz.testing ? { testing: true } : {}),
  };

  let responseData;
  try {
    const { data } = await axios.post(`${baseUrl}/transaction`, payload);
    responseData = data;
  } catch (err) {
    responseData = err.response?.data || { error: err.message };
    console.error('[digiflazz:checkStatus] Request gagal. Response dari Digiflazz:', JSON.stringify(responseData, null, 2));
  }

  await db.query(
    `INSERT INTO digiflazz_logs (order_id, action, request_payload, response_payload)
     VALUES ($1, 'cek-status', $2, $3)`,
    [orderId, payload, responseData]
  );

  if (!responseData.data) {
    throw new Error(`Digiflazz tidak mengembalikan data yang valid: ${JSON.stringify(responseData)}`);
  }

  return responseData.data;
}

/**
 * Verifikasi signature webhook dari Digiflazz (X-Hub-Signature, format sha1=...).
 * WAJIB dipanggil sebelum memproses body webhook apa pun.
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!signatureHeader || !config.digiflazz.webhookSecret) return false;
  const expected =
    'sha1=' +
    crypto
      .createHmac('sha1', config.digiflazz.webhookSecret)
      .update(rawBody)
      .digest('hex');
  // Gunakan timing-safe compare untuk hindari timing attack
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { getPriceList, topup, checkStatus, verifyWebhookSignature };

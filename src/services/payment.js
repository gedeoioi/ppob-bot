const axios = require('axios');
const crypto = require('crypto');
const config = require('../config');

const { merchantCode, merchantKey, mode } = config.payment.duitku;

const baseUrl =
  mode === 'production'
    ? 'https://passport.duitku.com/webapi/api/merchant/v2/inquiry'
    : 'https://sandbox.duitku.com/webapi/api/merchant/v2/inquiry';

// Kode metode pembayaran QRIS di Duitku
const PAYMENT_METHOD_QRIS = 'SP';

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

/**
 * Generate QRIS dinamis untuk satu order via Duitku (Direct API v2/inquiry).
 *
 * refId dipakai sebagai merchantOrderId - HARUS unik dan sama dengan orders.ref_id
 * di DB kita, supaya callback bisa dicocokkan balik ke order yang benar.
 *
 * Signature request: MD5(merchantCode + merchantOrderId + paymentAmount + merchantKey)
 * (formula ini konsisten dengan skema signature Duitku yang dipakai di endpoint lain
 * seperti pengecekan status transaksi - lihat dokumentasi resmi di docs.duitku.com
 * untuk versi API yang aktif di akun kamu, karena Duitku punya beberapa varian API).
 */
async function createQris({ refId, amount, expiredAtUnix }) {
  // Mode mock: skip panggilan API Duitku sama sekali, generate QR dummy lokal.
  // Berguna untuk testing tanpa akun Duitku - QR ini TIDAK BISA dibayar beneran,
  // cuma untuk lihat tampilan bot dan tes alur pakai npm run test:webhook.
  if (config.payment.mock) {
    console.log(`[payment:mock] Skip panggilan API Duitku untuk order ${refId} (PAYMENT_MOCK=true)`);
    return {
      gatewayRef: 'MOCK-' + refId,
      qrString: `MOCK-QRIS|refId=${refId}|amount=${amount}|jangan-discan-beneran`,
      raw: { mock: true },
    };
  }

  const signature = md5(`${merchantCode}${refId}${amount}${merchantKey}`);

  // Duitku minta expiryPeriod dalam MENIT dari sekarang, bukan unix timestamp
  const expiryPeriodMinutes = expiredAtUnix
    ? Math.max(1, Math.round((expiredAtUnix - Math.floor(Date.now() / 1000)) / 60))
    : 15;

  const payload = {
    merchantCode,
    paymentAmount: amount,
    paymentMethod: PAYMENT_METHOD_QRIS,
    merchantOrderId: refId,
    productDetails: 'Pembayaran PPOB',
    callbackUrl: `${config.app.publicBaseUrl}/webhook/duitku`,
    returnUrl: `${config.app.publicBaseUrl}/webhook/duitku/return`,
    expiryPeriod: expiryPeriodMinutes,
    signature,
  };

  const { data } = await axios.post(baseUrl, payload, {
    headers: { 'Content-Type': 'application/json' },
  });

  if (!data.qrString && !data.paymentUrl) {
    throw new Error(`Duitku gagal generate QRIS: ${data.statusMessage || JSON.stringify(data)}`);
  }

  return {
    gatewayRef: data.reference, // reference unik dari Duitku, simpan untuk cek status
    qrString: data.qrString || data.paymentUrl,
    raw: data,
  };
}

/**
 * Verifikasi signature callback Duitku.
 * Duitku mengirim callback sebagai application/x-www-form-urlencoded dengan field:
 * merchantCode, amount, merchantOrderId, resultCode ("00" = sukses), reference, signature, dll.
 *
 * Formula signature callback: MD5(merchantCode + amount + merchantOrderId + merchantKey)
 * PENTING: field-nya "amount" (bukan "paymentAmount") khusus di payload callback.
 */
function verifyCallbackSignature(body) {
  const { merchantCode: bodyMerchantCode, amount, merchantOrderId, signature } = body;
  if (!signature || !amount || !merchantOrderId) return false;

  const expected = md5(`${bodyMerchantCode}${amount}${merchantOrderId}${merchantKey}`);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Cek status transaksi ke Duitku (dipakai worker/cron untuk polling
 * transaksi yang belum dapat callback, misal karena jaringan bermasalah).
 */
async function checkTransactionStatus({ refId }) {
  const signature = md5(`${merchantCode}${refId}${merchantKey}`);
  const statusUrl =
    mode === 'production'
      ? 'https://passport.duitku.com/webapi/api/merchant/transactionStatus'
      : 'https://sandbox.duitku.com/webapi/api/merchant/transactionStatus';

  const { data } = await axios.post(statusUrl, {
    merchantCode,
    merchantOrderId: refId,
    signature,
  });

  return data; // { statusCode, statusMessage, amount, reference, ... }
}

module.exports = { createQris, verifyCallbackSignature, checkTransactionStatus };

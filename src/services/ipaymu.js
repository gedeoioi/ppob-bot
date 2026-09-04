const axios = require('axios');
const crypto = require('crypto');
const config = require('../config');
const db = require('../db');

function getCreds() {
  return {
    va: String(config.payment.ipaymu.va || '').trim(),
    apiKey: String(config.payment.ipaymu.apiKey || '').trim(),
    mode: config.payment.ipaymu.mode || 'sandbox',
  };
}

function getBaseUrl() {
  const { mode } = getCreds();
  return mode === 'production' ? 'https://my.ipaymu.com' : 'https://sandbox.ipaymu.com';
}

function requireCreds() {
  const c = getCreds();
  if (!c.va || !c.apiKey) {
    throw new Error('IPAYMU_VA / IPAYMU_API_KEY belum diisi di .env (PAYMENT_GATEWAY=ipaymu butuh ini)');
  }
  return c;
}

function timestampNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function signRequest({ method, va, bodyObj, apiKey }) {
  const bodyJson = JSON.stringify(bodyObj);
  const bodyHash = crypto.createHash('sha256').update(bodyJson).digest('hex').toLowerCase();
  const stringToSign = `${method.toUpperCase()}:${va}:${bodyHash}:${apiKey}`;
  return crypto.createHmac('sha256', apiKey).update(stringToSign).digest('hex');
}

async function postApi({ path, bodyObj }) {
  const { va, apiKey } = requireCreds();
  const method = 'POST';
  const signature = signRequest({ method, va, bodyObj, apiKey });
  const { data } = await axios.post(getBaseUrl() + path, bodyObj, {
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      va,
      signature,
      timestamp: timestampNow(),
    },
    timeout: 15000,
  });
  return data;
}

/**
 * Generate QRIS dinamis via iPaymu Direct Payment.
 * method=qris, channel=mpm — sesuai docs.ipaymu.com direct-payment.
 * referenceId dipakai sebagai orders.ref_id / topups.ref_id agar callback cocok.
 */
async function createQris({ refId, amount, expiredAtUnix, buyerName, buyerPhone, productName }) {
  // expired dalam menit → iPaymu pakai expired + expiredType
  const expiredMinutes = expiredAtUnix
    ? Math.max(1, Math.round((expiredAtUnix - Math.floor(Date.now() / 1000)) / 60))
    : 15;
  // iPaymu max expiredType minutes — jika > 24 jam fallback ke hours
  let expired = expiredMinutes;
  let expiredType = 'minutes';
  if (expiredMinutes > 1440) { expired = Math.ceil(expiredMinutes / 60); expiredType = 'hours'; }

  // iPaymu validasi ketat: phone harus nomor HP valid, email valid,
  // notifyUrl harus https publik (bukan localhost).
  // refId mengandung huruf (ORD/TOP + hex) → tidak valid sebagai email lokal,
  // jadi pakai email dummy yang valid agar tidak 406.
  const digits = String(buyerPhone || '').replace(/\D/g, '');
  const safePhone = /^08\d{8,13}$/.test(digits) ? digits : '081200000001';
  const safeEmail = 'buyer@ppob.local';
  const bodyObj = {
    name: String(buyerName || 'PPOB Buyer').slice(0, 50),
    phone: safePhone,
    email: safeEmail,
    amount: Number(amount),
    notifyUrl: `${config.app.publicBaseUrl}/webhook/ipaymu`,
    expired,
    expiredType,
    comments: `Pembayaran PPOB ${refId}`.slice(0, 100),
    referenceId: refId,
    paymentMethod: 'qris',
    paymentChannel: 'mpm',
    product: [String(productName || 'Pembayaran PPOB').slice(0, 50)],
    qty: [1],
    price: [Number(amount)],
  };

  let data;
  try {
    data = await postApi({ path: '/api/v2/payment/direct', bodyObj });
  } catch (e) {
    // 406 dari iPaymu biasanya validasi field (email/notifyUrl/phone) — tampilkan body agar jelas
    const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    throw new Error(`iPaymu 406/invalid request: ${detail}`);
  }

  if (data.Status !== 200 || !data.Success || !data.Data) {
    throw new Error(`iPaymu gagal generate QRIS: ${data.Message || JSON.stringify(data)}`);
  }

  // Direct QRIS tidak selalu return qrString; bisa berupa Url redirect/payment page.
  // Bot akan render Url sebagai QR agar tetap bisa di-scan.
  const qrPayload = data.Data.QrString || data.Data.QrUrl || data.Data.Url || data.Data.PaymentNo;
  if (!qrPayload) {
    throw new Error(`iPaymu tidak mengembalikan QR/Url: ${JSON.stringify(data.Data)}`);
  }

  return {
    gatewayRef: String(data.Data.TransactionId || data.Data.ReferenceId || refId),
    transactionId: data.Data.TransactionId,
    qrString: String(qrPayload),
    paymentUrl: data.Data.Url || null,
    raw: data,
  };
}

/**
 * Cek status transaksi ke iPaymu via transactionId.
 */
async function checkTransactionStatus({ transactionId }) {
  const data = await postApi({ path: '/api/v2/transaction', bodyObj: { transactionId: String(transactionId) } });
  return data; // { Status, Data: { Status: 0 pending, 1 success, ... } }
}

function normalizeCallback(raw) {
  const out = {};
  for (const k of Object.keys(raw || {})) {
    let v = raw[k];
    if (k === 'is_escrow') out[k] = (v === 'true' || v === '1' || v === 1 || v === true);
    else if (['trx_id', 'status_code', 'transaction_status_code', 'paid_off'].includes(k)) {
      const n = parseInt(v, 10);
      out[k] = Number.isNaN(n) ? v : n;
    } else if (k === 'additional_info') {
      out[k] = (v === '[]' || v === undefined) ? [] : v;
    } else {
      out[k] = v === undefined || v === null ? v : String(v);
    }
  }
  if (!Object.prototype.hasOwnProperty.call(out, 'additional_info')) out.additional_info = [];
  return out;
}

function sortedJson(obj) {
  const sorted = Object.keys(obj).sort((a, b) => a.localeCompare(b)).reduce((acc, k) => { acc[k] = obj[k]; return acc; }, {});
  return JSON.stringify(sorted).replace(/\//g, '\\/');
}

function verifyCallbackSignature(rawBody, signatureHeader) {
  try {
    const { va } = getCreds();
    if (!va || !signatureHeader) return false;
    const normalized = normalizeCallback(rawBody);
    if (normalized.signature) delete normalized.signature;
    const jsonBody = sortedJson(normalized);
    const calc = crypto.createHmac('sha256', va).update(jsonBody).digest('hex');
    const a = Buffer.from(calc);
    const b = Buffer.from(String(signatureHeader).trim());
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (_) {
    return false;
  }
}

async function logCallback({ refId, valid, payload }) {
  try {
    await db.query(
      `INSERT INTO webhook_logs (source, signature_valid, raw_payload) VALUES ($1,$2,$3)`,
      ['ipaymu', !!valid, payload || {}]
    );
  } catch (_) {}
}

module.exports = {
  getCreds, requireCreds, getBaseUrl, timestampNow, signRequest,
  postApi, createQris, checkTransactionStatus,
  normalizeCallback, verifyCallbackSignature, logCallback,
};

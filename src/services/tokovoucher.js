const axios = require('axios');
const crypto = require('crypto');
const config = require('../config');
const db = require('../db');

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

function getCreds() {
  const memberCode = String(config.tokovoucher.memberCode || '').trim();
  const secret = String(config.tokovoucher.secret || '').trim();
  const baseUrl = String(config.tokovoucher.baseUrl || 'https://api.tokovoucher.net').trim().replace(/\/$/, '');
  return { memberCode, secret, baseUrl };
}

function requireCreds() {
  const { memberCode, secret } = getCreds();
  if (!memberCode || !secret) {
    throw new Error('TOKOVOUCHER_MEMBER_CODE / TOKOVOUCHER_SECRET belum diisi di .env (TRANSACTION_PROVIDER=tokovoucher butuh ini)');
  }
  return getCreds();
}

function signatureForRef(memberCode, secret, refId) {
  return md5(`${memberCode}:${secret}:${refId}`);
}

// ── Produk ────────────────────────────────────────────────────────
async function getProductFull() {
  const { memberCode, secret, baseUrl } = requireCreds();
  // GET /member/produk/full?member_code=&signature=
  // signature = member default signature (md5 member handling beda di docs, pakai secret via member area)
  // Untuk full list, docs pakai signature default — kita coba signature = md5(memberCode:secret:memberCode) fallback ke secret
  // Praktis: TokoVoucher signature default = yang tampil di pengaturan secret-key (bisa berupa md5(memberCode:secret))
  const signature = secret.length === 32 ? secret : md5(`${memberCode}:${secret}`);
  const url = `${baseUrl}/member/produk/full?member_code=${encodeURIComponent(memberCode)}&signature=${encodeURIComponent(signature)}`;
  const { data } = await axios.get(url, { timeout: 15000 });
  if (data.status !== 1 && data.status !== '1') {
    throw new Error(`TokoVoucher getProductFull gagal: ${data.error_msg || JSON.stringify(data)}`);
  }
  return data.data; // { category, operator, jenis, produk }
}

async function getProductByCode(kode) {
  const { memberCode, secret, baseUrl } = getCreds();
  const signature = secret.length === 32 ? secret : md5(`${memberCode}:${secret}`);
  const url = `${baseUrl}/produk/code?member_code=${encodeURIComponent(memberCode)}&signature=${encodeURIComponent(signature)}&kode=${encodeURIComponent(kode)}`;
  const { data } = await axios.get(url, { timeout: 15000 });
  if (data.status !== 1 && data.status !== '1') {
    throw new Error(`TokoVoucher produk code ${kode} gagal: ${data.error_msg || JSON.stringify(data)}`);
  }
  return data.data;
}

async function getBalance() {
  const { memberCode, secret, baseUrl } = requireCreds();
  const signature = secret.length === 32 ? secret : md5(`${memberCode}:${secret}`);
  const url = `${baseUrl}/member?member_code=${encodeURIComponent(memberCode)}&signature=${encodeURIComponent(signature)}`;
  const { data } = await axios.get(url, { timeout: 10000 });
  if (data.status !== 1 && data.status !== '1') throw new Error(`TokoVoucher cek saldo gagal: ${data.error_msg || JSON.stringify(data)}`);
  return data.data; // { saldo, nama, member_code }
}

// ── Transaksi ─────────────────────────────────────────────────────
/**
 * Topup via TokoVoucher — dipetakan ke interface yang sama dengan digiflazz.topup
 * agar order.js tidak perlu tahu bedanya.
 */
async function topup({ orderId, refId, buyerSkuCode, customerNo, serverId = '' }) {
  const { memberCode, secret, baseUrl } = requireCreds();
  const signature = signatureForRef(memberCode, secret, refId);

  // Pisah tujuan|server_id jika customerNo mengandung "|"
  let tujuan = String(customerNo).trim();
  let sid = String(serverId || '').trim();
  if (!sid && tujuan.includes('|')) {
    const parts = tujuan.split('|');
    tujuan = parts[0].trim();
    sid = parts.slice(1).join('|').trim();
  }

  const payload = {
    ref_id: refId,
    produk: buyerSkuCode,
    tujuan,
    server_id: sid,
    member_code: memberCode,
    signature,
  };

  let raw;
  try {
    const { data } = await axios.post(`${baseUrl}/v1/transaksi`, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    });
    raw = data;
  } catch (err) {
    raw = err.response?.data || { error: err.message };
    // Semua HTTP error / timeout harus dianggap PENDING sesuai docs
    if (!raw.status) {
      raw = { status: 'pending', message: `HTTP error dianggap pending: ${err.message}`, ref_id: refId, sn: '', trx_id: '' };
    }
    console.error('[tokovoucher:topup] HTTP error, dianggap pending:', JSON.stringify(raw, null, 2));
  }

  await db.query(
    `INSERT INTO provider_logs (order_id, provider, action, request_payload, response_payload)
     VALUES ($1,'tokovoucher','topup',$2,$3)`,
    [orderId, payload, raw]
  ).catch(async () => {
    // fallback ke digiflazz_logs jika provider_logs belum ada (belum migrate)
    await db.query(
      `INSERT INTO digiflazz_logs (order_id, action, request_payload, response_payload)
       VALUES ($1,'topup',$2,$3)`,
      [orderId, { provider: 'tokovoucher', ...payload }, raw]
    );
  });

  // Normalisasi ke format Digiflazz { status: Sukses/Gagal/Pending, sn, message, ... }
  // TokoVoucher: status = sukses/gagal/pending (lowercase)
  if (raw.status === 0 || raw.error_msg) {
    const msg = String(raw.error_msg || '');
    const low = msg.toLowerCase();
    // Transient: rate limit — anggap Pending agar polling ulang, bukan Failed
    if (low.includes('limitasi') || low.includes('limit') || low.includes('terlalu') || low.includes('coba')) {
      console.warn('[tokovoucher:topup] rate limit, dianggap Pending:', msg);
      return { status: 'Pending', sn: '', message: msg, ref_id: refId, trx_id: '', raw };
    }
    // Signature/IP — permanent Gagal agar refund & admin tau
    throw new Error(`TokoVoucher error: ${raw.error_msg || JSON.stringify(raw)}`);
  }
  const mapped = mapStatus(raw);
  return mapped;
}

async function checkStatus({ orderId, refId }) {
  const { memberCode, secret, baseUrl } = requireCreds();
  const signature = signatureForRef(memberCode, secret, refId);
  const payload = { ref_id: refId, member_code: memberCode, signature };

  let raw;
  try {
    const { data } = await axios.post(`${baseUrl}/v1/transaksi/status`, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    });
    raw = data;
  } catch (err) {
    raw = err.response?.data || { error: err.message };
    if (!raw.status) raw = { status: 'pending', message: `HTTP error dianggap pending: ${err.message}`, ref_id: refId, sn: '' };
    console.error('[tokovoucher:checkStatus] HTTP error, dianggap pending:', JSON.stringify(raw, null, 2));
  }

  await db.query(
    `INSERT INTO provider_logs (order_id, provider, action, request_payload, response_payload)
     VALUES ($1,'tokovoucher','cek-status',$2,$3)`,
    [orderId, payload, raw]
  ).catch(async () => {
    await db.query(
      `INSERT INTO digiflazz_logs (order_id, action, request_payload, response_payload)
       VALUES ($1,'cek-status',$2,$3)`,
      [orderId, { provider: 'tokovoucher', ...payload }, raw]
    );
  });

  if (raw.status === 0 || raw.error_msg) {
    const msg = String(raw.error_msg || '');
    const low = msg.toLowerCase();
    if (low.includes('limitasi') || low.includes('limit') || low.includes('coba')) {
      console.warn('[tokovoucher:checkStatus] rate limit, dianggap Pending:', msg);
      return { status: 'Pending', sn: '', message: msg, ref_id: refId, trx_id: '', raw };
    }
    throw new Error(`TokoVoucher cek status error: ${raw.error_msg || JSON.stringify(raw)}`);
  }
  return mapStatus(raw);
}

function mapStatus(raw) {
  const s = String(raw.status || '').toLowerCase();
  let status;
  if (s === 'sukses') status = 'Sukses';
  else if (s === 'gagal') status = 'Gagal';
  else status = 'Pending';
  return {
    status,
    sn: raw.sn || '',
    message: raw.message || '',
    ref_id: raw.ref_id || raw.refId || '',
    trx_id: raw.trx_id || raw.trxId || '',
    price: raw.price,
    sisa_saldo: raw.sisa_saldo,
    produk: raw.produk,
    raw,
  };
}

function verifyWebhookSignature(refId, headerValue) {
  const { memberCode, secret } = getCreds();
  if (!memberCode || !secret || !refId || !headerValue) return false;
  const expected = signatureForRef(memberCode, secret, String(refId).trim());
  const a = Buffer.from(expected);
  const b = Buffer.from(String(headerValue).trim());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  getProductFull,
  getProductByCode,
  getBalance,
  topup,
  checkStatus,
  verifyWebhookSignature,
  signatureForRef,
};

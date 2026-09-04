const axios = require('axios');
const crypto = require('crypto');
const config = require('../config');

function getCreds() {
  return {
    merchantCode: String(config.payment.duitku.merchantCode || '').trim(),
    merchantKey: String(config.payment.duitku.merchantKey || '').trim(),
    mode: config.payment.duitku.mode || 'sandbox',
  };
}

function getBaseUrl() {
  const { mode } = getCreds();
  return mode === 'production'
    ? 'https://passport.duitku.com/webapi/api/merchant/v2/inquiry'
    : 'https://sandbox.duitku.com/webapi/api/merchant/v2/inquiry';
}

// Kode metode pembayaran QRIS di Duitku
const PAYMENT_METHOD_QRIS = 'SP';

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

async function createQris({ refId, amount, expiredAtUnix }) {
  const { merchantCode, merchantKey } = getCreds();
  const signature = md5(`${merchantCode}${refId}${amount}${merchantKey}`);

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

  const { data } = await axios.post(getBaseUrl(), payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000,
  });

  if (!data.qrString && !data.paymentUrl) {
    throw new Error(`Duitku gagal generate QRIS: ${data.statusMessage || JSON.stringify(data)}`);
  }

  return {
    gatewayRef: data.reference,
    qrString: data.qrString || data.paymentUrl,
    raw: data,
  };
}

function verifyCallbackSignature(body) {
  const { merchantKey } = getCreds();
  const { merchantCode: bodyMerchantCode, amount, merchantOrderId, signature } = body;
  if (!signature || !amount || !merchantOrderId) return false;

  const expected = md5(`${bodyMerchantCode}${amount}${merchantOrderId}${merchantKey}`);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function checkTransactionStatus({ refId }) {
  const { merchantCode, merchantKey, mode } = getCreds();
  const signature = md5(`${merchantCode}${refId}${merchantKey}`);
  const statusUrl =
    mode === 'production'
      ? 'https://passport.duitku.com/webapi/api/merchant/transactionStatus'
      : 'https://sandbox.duitku.com/webapi/api/merchant/transactionStatus';

  const { data } = await axios.post(statusUrl, {
    merchantCode,
    merchantOrderId: refId,
    signature,
  }, { timeout: 15000 });

  return data;
}

module.exports = { createQris, verifyCallbackSignature, checkTransactionStatus };

const config = require('../config');

/**
 * Router payment gateway QRIS.
 * PAYMENT_GATEWAY=duitku → src/services/duitku.js
 * PAYMENT_GATEWAY=ipaymu → src/services/ipaymu.js
 * PAYMENT_MOCK=true → QR dummy lokal (untuk testing tanpa akun gateway).
 *
 * Interface disatukan:
 *   createQris({ refId, amount, expiredAtUnix, buyerName, buyerPhone, productName })
 *     → { gatewayRef, qrString, raw, transactionId? }
 *   verifyCallbackSignature(body, signatureHeader?) → boolean
 *   checkTransactionStatus({ refId, transactionId? })
 */

function currentGateway() {
  return (config.payment.gateway || 'duitku').toLowerCase();
}

function getGatewayService(name) {
  const g = (name || currentGateway()).toLowerCase();
  if (g === 'ipaymu') return require('./ipaymu');
  if (g === 'duitku') return require('./duitku');
  throw new Error(`Payment gateway tidak dikenal: ${g}`);
}

async function createQris({ refId, amount, expiredAtUnix, buyerName, buyerPhone, productName }) {
  if (config.payment.mock) {
    const gw = currentGateway();
    console.log(`[payment:mock] Skip panggilan API ${gw} untuk order ${refId} (PAYMENT_MOCK=true)`);
    return {
      gatewayRef: 'MOCK-' + refId,
      qrString: `MOCK-QRIS|refId=${refId}|amount=${amount}|jangan-discan-beneran`,
      raw: { mock: true, gateway: gw },
    };
  }
  const svc = getGatewayService();
  return svc.createQris({ refId, amount, expiredAtUnix, buyerName, buyerPhone, productName });
}

function verifyCallbackSignature(body, signatureHeader) {
  const svc = getGatewayService();
  // duitku: verify(body) — ipaymu: verify(body, x-signature)
  if (currentGateway() === 'ipaymu') return svc.verifyCallbackSignature(body, signatureHeader);
  return svc.verifyCallbackSignature(body);
}

async function checkTransactionStatus({ refId, transactionId }) {
  const svc = getGatewayService();
  return svc.checkTransactionStatus({ refId, transactionId });
}

module.exports = { currentGateway, getGatewayService, createQris, verifyCallbackSignature, checkTransactionStatus };

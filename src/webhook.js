const express = require('express');
const db = require('./db');
const payment = require('./services/payment');
const orderService = require('./services/order');

function createWebhookApp({ onOrderSuccess, onOrderFailed } = {}) {
  const app = express();

  // Duitku mengirim callback sebagai application/x-www-form-urlencoded,
  // BUKAN JSON - jadi parser-nya beda dari kebanyakan payment gateway lain.
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  app.post('/webhook/duitku', async (req, res) => {
    const body = req.body;
    const isValid = payment.verifyCallbackSignature(body);

    await db.query(
      `INSERT INTO webhook_logs (source, signature_valid, raw_payload) VALUES ($1,$2,$3)`,
      ['duitku', isValid, body]
    );

    if (!isValid) {
      // JANGAN proses apa pun kalau signature tidak valid - bisa jadi request palsu
      return res.status(400).send('invalid signature');
    }

    // Duitku expect balasan teks polos "OK" (bukan JSON) untuk anggap callback diterima.
    res.status(200).send('OK');

    try {
      const { merchantOrderId: refId, resultCode } = body;
      // resultCode "00" = pembayaran sukses (lihat dokumentasi callback Duitku)
      if (resultCode === '00') {
        const result = await orderService.handlePaymentPaid({ refId });
        if (!result.skipped && onOrderSuccess) await onOrderSuccess(result.order);
      }
    } catch (err) {
      console.error('[webhook/duitku] gagal proses order:', err.message);
      if (onOrderFailed) await onOrderFailed(err);
    }
  });

  // Halaman redirect setelah user selesai bayar (returnUrl) - opsional, sekadar info di browser
  app.get('/webhook/duitku/return', (_req, res) => {
    res.send('Pembayaran diproses. Silakan kembali ke Telegram untuk melihat status transaksi.');
  });

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  return app;
}

module.exports = { createWebhookApp };

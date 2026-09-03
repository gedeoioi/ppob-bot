const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const pinoHttp = require('pino-http');
const path = require('path');
const db = require('./db');
const redis = require('./db/redis');
const payment = require('./services/payment');
const orderService = require('./services/order');
const topupService = require('./services/topup');
const config = require('./config');
const logger = require('./logger');

function createWebhookApp({ onOrderSuccess, onOrderFailed } = {}) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(pinoHttp({ logger, autoLogging: true }));

  const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Terlalu banyak request, coba lagi nanti.' },
  });
  app.use(globalLimiter);

  app.use(express.urlencoded({ extended: true, limit: '32kb' }));
  app.use(express.json({ limit: '32kb' }));

  const webhookLimiter = rateLimit({
    windowMs: config.webhookRateLimitWindowMs,
    max: config.webhookRateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.ip,
    message: 'Too many webhook requests',
  });

  // onTopupSuccess callback untuk notifikasi Telegram — di-inject dari index.js
  let onTopupSuccess = null;
  app.locals.setTopupHandler = (fn) => { onTopupSuccess = fn; };

  // Webhook TokoVoucher — header X-TokoVoucher-Authorization: md5(MEMBER_CODE:SECRET:REF_ID)
  app.post('/webhook/tokovoucher', async (req, res) => {
    const auth = req.headers['x-tokovoucher-authorization'] || req.headers['X-TokoVoucher-Authorization'];
    const { ref_id: refId, status, sn, trx_id } = req.body || {};

    // Log mentah untuk forensik (selalu tulis, valid atau tidak)
    try {
      const isValidPreview = (() => {
        try {
          const tokv = require('./services/tokovoucher');
          return refId ? tokv.verifyWebhookSignature(refId, auth) : false;
        } catch (_) { return false; }
      })();
      await db.query(
        `INSERT INTO webhook_logs (source, signature_valid, raw_payload) VALUES ($1,$2,$3)`,
        ['tokovoucher', isValidPreview, req.body || {}]
      );
    } catch (e) {
      req.log.error({ err: e.message }, '[webhook/tokovoucher] gagal tulis webhook_logs');
    }

    if (!refId) return res.status(400).send('missing ref_id');

    const tokv = require('./services/tokovoucher');
    if (!tokv.verifyWebhookSignature(refId, auth)) {
      req.log.warn({ refId, auth }, '[webhook/tokovoucher] invalid signature');
      return res.status(401).send('invalid signature');
    }

    res.status(200).send('OK');

    // Hanya proses jika status final; pending diabaikan (polling akan urus)
    const s = String(status || '').toLowerCase();
    if (s !== 'sukses' && s !== 'gagal') {
      req.log.info({ refId, status }, '[webhook/tokovoucher] status non-final, diabaikan');
      return;
    }

    try {
      const mapped = {
        status: s === 'sukses' ? 'Sukses' : 'Gagal',
        sn: sn || '',
        message: req.body.message || '',
        ref_id: refId,
        trx_id: trx_id || '',
      };
      // Cari order berdasarkan ref_id
      const orderRes = await db.query('SELECT id, status FROM orders WHERE ref_id = $1', [refId]);
      if (orderRes.rows.length === 0) {
        req.log.warn({ refId }, '[webhook/tokovoucher] order tidak ditemukan');
        return;
      }
      const orderId = orderRes.rows[0].id;

      // Idempotent yang benar: selama order masih processing, webhook berhak finalisasi.
      // Sebelumnya cek digiflazz_status === 'Pending' terlalu ketat untuk TokoVoucher (webhook bisa datang sebelum polling sempat set Pending).
      // Cukup cek status === 'processing' — jika sudah success/failed/expired, skip.
      const cur = await db.query('SELECT status, digiflazz_status, provider FROM orders WHERE id=$1', [orderId]);
      if (cur.rows[0] && cur.rows[0].status !== 'processing') {
        req.log.info({ refId, curStatus: cur.rows[0].status }, '[webhook/tokovoucher] skip, status bukan processing');
        return;
      }
      // Provider mismatch warning (order lama digiflazz tapi webhook tokovoucher) — tetap proses karena ref_id valid
      if (cur.rows[0] && cur.rows[0].provider && cur.rows[0].provider !== 'tokovoucher') {
        req.log.warn({ refId, provider: cur.rows[0].provider }, '[webhook/tokovoucher] provider mismatch, tetap proses');
      }

      const orderService = require('./services/order');
      const updated = await orderService.applyDigiflazzResult(orderId, mapped);
      if (updated.status !== 'processing' && onOrderSuccess) await onOrderSuccess(updated);
    } catch (err) {
      req.log.error({ err: err.message, refId }, '[webhook/tokovoucher] gagal proses');
      if (onOrderFailed) await onOrderFailed(err);
    }
  });

  app.post('/webhook/duitku', webhookLimiter, async (req, res) => {
    const body = req.body;
    const isValid = payment.verifyCallbackSignature(body);

    try {
      await db.query(
        `INSERT INTO webhook_logs (source, signature_valid, raw_payload) VALUES ($1,$2,$3)`,
        ['duitku', isValid, body]
      );
    } catch (e) {
      req.log.error({ err: e.message }, '[webhook/duitku] gagal tulis webhook_logs');
    }

    if (!isValid) {
      req.log.warn({ ip: req.ip, body }, '[webhook/duitku] invalid signature');
      return res.status(400).send('invalid signature');
    }

    res.status(200).send('OK');

    try {
      const { merchantOrderId: refId, resultCode } = body;
      if (resultCode !== '00') {
        req.log.info({ refId, resultCode }, '[webhook/duitku] callback non-sukses, diabaikan');
        return;
      }

      // Route berdasarkan prefix ref_id: TOP* = topup saldo, ORD* = order produk
      if (refId && refId.startsWith('TOP')) {
        const result = await topupService.handleTopupPaid({ refId });
        if (!result.skipped) {
          req.log.info({ refId, newSaldo: result.newSaldo }, '[webhook/duitku] topup success');
          if (onTopupSuccess) await onTopupSuccess(result.topup, result.newSaldo);
          // Fallback ke onOrderSuccess agar bot tetap dapat notifikasi generik jika handler topup belum di-set
          else if (onOrderSuccess) await onOrderSuccess({ ...result.topup, status: 'topup_success', ref_id: refId });
        } else {
          req.log.info({ refId, reason: result.reason }, '[webhook/duitku] topup skipped');
        }
      } else {
        const result = await orderService.handlePaymentPaid({ refId });
        if (!result.skipped && onOrderSuccess) await onOrderSuccess(result.order);
      }
    } catch (err) {
      req.log.error({ err: err.message, refId: body.merchantOrderId }, '[webhook/duitku] gagal proses callback');
      if (onOrderFailed) await onOrderFailed(err);
    }
  });

  app.get('/webhook/duitku/return', (_req, res) => {
    res.send('Pembayaran diproses. Silakan kembali ke Telegram untuk melihat status transaksi.');
  });

  app.get('/healthz', (_req, res) => res.json({ ok: true, env: config.env, uptime: process.uptime() }));

  app.get('/readyz', async (_req, res) => {
    try {
      await db.checkHealth();
      await redis.checkHealth();
      res.json({ ok: true });
    } catch (err) {
      res.status(503).json({ ok: false, error: err.message });
    }
  });

  // Landing page — serve static dari /public, fallback ke index.html untuk "/"
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h', etag: true }));
  app.get('/', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    req.log.error({ err: err.message, stack: err.stack }, 'Unhandled express error');
    res.status(500).json({ error: config.isProd ? 'Internal server error' : err.message });
  });

  return app;
}

module.exports = { createWebhookApp };

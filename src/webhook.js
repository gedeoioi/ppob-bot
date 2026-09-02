const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const pinoHttp = require('pino-http');
const db = require('./db');
const redis = require('./db/redis');
const payment = require('./services/payment');
const orderService = require('./services/order');
const config = require('./config');
const logger = require('./logger');

function createWebhookApp({ onOrderSuccess, onOrderFailed } = {}) {
  const app = express();

  // Di belakang Nginx reverse proxy — penting agar req.ip benar & rate-limit akurat
  app.set('trust proxy', 1);

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(pinoHttp({ logger, autoLogging: true }));

  // Global rate limit ringan untuk semua endpoint (anti spam scanner)
  const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Terlalu banyak request, coba lagi nanti.' },
  });
  app.use(globalLimiter);

  // Body parser dengan limit kecil — webhook Duitku hanya form kecil
  app.use(express.urlencoded({ extended: true, limit: '32kb' }));
  app.use(express.json({ limit: '32kb' }));

  // Rate limit KHUSUS webhook Duitku — lebih ketat
  const webhookLimiter = rateLimit({
    windowMs: config.webhookRateLimitWindowMs,
    max: config.webhookRateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.ip,
    message: 'Too many webhook requests',
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

    // Duitku expect balasan teks polos "OK"
    res.status(200).send('OK');

    try {
      const { merchantOrderId: refId, resultCode } = body;
      if (resultCode === '00') {
        const result = await orderService.handlePaymentPaid({ refId });
        if (!result.skipped && onOrderSuccess) await onOrderSuccess(result.order);
      } else {
        req.log.info({ refId: body.merchantOrderId, resultCode }, '[webhook/duitku] callback non-sukses, diabaikan');
      }
    } catch (err) {
      req.log.error({ err: err.message, refId: body.merchantOrderId }, '[webhook/duitku] gagal proses order');
      if (onOrderFailed) await onOrderFailed(err);
    }
  });

  app.get('/webhook/duitku/return', (_req, res) => {
    res.send('Pembayaran diproses. Silakan kembali ke Telegram untuk melihat status transaksi.');
  });

  app.get('/healthz', (_req, res) => res.json({ ok: true, env: config.env, uptime: process.uptime() }));

  // Readiness: cek DB + Redis beneran — dipakai Docker HEALTHCHECK & load balancer
  app.get('/readyz', async (_req, res) => {
    try {
      await db.checkHealth();
      await redis.checkHealth();
      res.json({ ok: true });
    } catch (err) {
      res.status(503).json({ ok: false, error: err.message });
    }
  });

  // 404 handler
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // Error handler global — jangan bocorkan stack ke client di production
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    req.log.error({ err: err.message, stack: err.stack }, 'Unhandled express error');
    res.status(500).json({ error: config.isProd ? 'Internal server error' : err.message });
  });

  return app;
}

module.exports = { createWebhookApp };

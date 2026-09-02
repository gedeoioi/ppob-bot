require('dotenv').config();

function required(name) {
  const val = process.env[name];
  if (!val || String(val).trim() === '') {
    throw new Error(`Environment variable ${name} wajib diisi (cek file .env)`);
  }
  return val.trim();
}

function optional(name, fallback = '') {
  const v = process.env[name];
  return v == null || v === '' ? fallback : String(v).trim();
}

const nodeEnv = optional('NODE_ENV', 'development');
const isProd = nodeEnv === 'production';

function parsePositiveInt(name, fallback) {
  const raw = optional(name, String(fallback));
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) throw new Error(`Environment variable ${name} harus angka positif (got: ${raw})`);
  return n;
}

// Hard guard: prevent leaking sandbox/ngrok into production
function validateProdSafety(cfg) {
  if (!isProd) return;
  const errs = [];
  if (cfg.digiflazz.testing) errs.push('DIGIFLAZZ_TESTING harus false di production');
  if (cfg.payment.mock) errs.push('PAYMENT_MOCK harus false di production');
  if (cfg.payment.duitku.mode !== 'production') errs.push('DUITKU_MODE harus production di production');
  if (cfg.app.publicBaseUrl.includes('ngrok') || cfg.app.publicBaseUrl.includes('localhost')) {
    errs.push('PUBLIC_BASE_URL tidak boleh ngrok/localhost di production');
  }
  if (cfg.app.orderExpiryMinutes < 5) errs.push('ORDER_EXPIRY_MINUTES minimal 5 di production');
  if (errs.length) throw new Error('Config production tidak aman:\n- ' + errs.join('\n- '));
}

function validateTelegramToken(token) {
  if (/^isi[_-]/i.test(token) || token.toLowerCase().includes('isi_token')) {
    throw new Error(
      'TELEGRAM_BOT_TOKEN masih placeholder "isi_token_botfather". Ganti dengan token asli dari @BotFather (contoh: 1234567890:AAH...).'
    );
  }
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
    throw new Error(
      'Format TELEGRAM_BOT_TOKEN tidak valid. Harus seperti "1234567890:AAH..." dari @BotFather. Cek kembali .env.'
    );
  }
}

const rawTelegramToken = required('TELEGRAM_BOT_TOKEN');
validateTelegramToken(rawTelegramToken);

const cfg = {
  env: nodeEnv,
  isProd,
  telegramToken: rawTelegramToken,
  databaseUrl: required('DATABASE_URL'),
  redisUrl: optional('REDIS_URL', 'redis://localhost:6379'),

  digiflazz: {
    username: required('DIGIFLAZZ_USERNAME'),
    apiKey: required('DIGIFLAZZ_API_KEY'),
    webhookSecret: optional('DIGIFLAZZ_WEBHOOK_SECRET', ''),
    baseUrl: 'https://api.digiflazz.com/v1',
    testing: optional('DIGIFLAZZ_TESTING', 'false') === 'true',
  },

  tokovoucher: {
    memberCode: optional('TOKOVOUCHER_MEMBER_CODE', ''),
    secret: optional('TOKOVOUCHER_SECRET', ''),
    baseUrl: optional('TOKOVOUCHER_BASE_URL', 'https://api.tokovoucher.net').replace(/\/$/, ''),
  },

  transactionProvider: (() => {
    const p = optional('TRANSACTION_PROVIDER', 'digiflazz').toLowerCase();
    if (!['digiflazz', 'tokovoucher'].includes(p)) throw new Error('TRANSACTION_PROVIDER harus digiflazz atau tokovoucher');
    return p;
  })(),

  payment: {
    gateway: optional('PAYMENT_GATEWAY', 'duitku'),
    mock: optional('PAYMENT_MOCK', 'false') === 'true',
    duitku: {
      merchantCode: optional('PAYMENT_MOCK', 'false') === 'true'
        ? (optional('DUITKU_MERCHANT_CODE', 'MOCKCODE'))
        : required('DUITKU_MERCHANT_CODE'),
      merchantKey: optional('PAYMENT_MOCK', 'false') === 'true'
        ? (optional('DUITKU_MERCHANT_KEY', 'mock-secret-key'))
        : required('DUITKU_MERCHANT_KEY'),
      mode: optional('DUITKU_MODE', 'sandbox'), // sandbox | production
    },
  },

  app: {
    port: parsePositiveInt('PORT', 3000),
    publicBaseUrl: optional('PUBLIC_BASE_URL', 'http://localhost:3000').replace(/\/$/, ''),
    orderExpiryMinutes: parsePositiveInt('ORDER_EXPIRY_MINUTES', 15),
  },

  logLevel: optional('LOG_LEVEL', isProd ? 'info' : 'debug'),
  webhookRateLimitWindowMs: parsePositiveInt('WEBHOOK_RATELIMIT_WINDOW_MS', 60 * 1000),
  webhookRateLimitMax: parsePositiveInt('WEBHOOK_RATELIMIT_MAX', 60),

  adminIds: (process.env.ADMIN_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n)),
};

validateProdSafety(cfg);

if (cfg.payment.mock || cfg.digiflazz.testing) {
  console.warn('[config] PERINGATAN: mode testing/mock aktif — jangan pakai di production dengan uang asli.');
}

cfg.isAdmin = (telegramId) => cfg.adminIds.includes(Number(telegramId));

module.exports = cfg;

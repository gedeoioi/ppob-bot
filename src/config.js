require('dotenv').config();

function required(name) {
  const val = process.env[name];
  if (!val) {
    throw new Error(`Environment variable ${name} wajib diisi (cek file .env)`);
  }
  return val;
}

module.exports = {
  telegramToken: required('TELEGRAM_BOT_TOKEN'),
  databaseUrl: required('DATABASE_URL'),
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',

  digiflazz: {
    username: required('DIGIFLAZZ_USERNAME'),
    apiKey: required('DIGIFLAZZ_API_KEY'),
    webhookSecret: process.env.DIGIFLAZZ_WEBHOOK_SECRET || '',
    baseUrl: 'https://api.digiflazz.com/v1',
    // true = simulasi (tidak potong saldo asli, respons dummy dari Digiflazz).
    // WAJIB false lagi sebelum benar-benar live.
    testing: process.env.DIGIFLAZZ_TESTING === 'true',
  },

  payment: {
    gateway: process.env.PAYMENT_GATEWAY || 'duitku',
    // true = tidak benar-benar panggil API Duitku, generate QR dummy lokal.
    // Berguna untuk testing alur order/topup tanpa perlu akun Duitku dulu.
    // WAJIB false lagi sebelum benar-benar live (QR dummy tidak bisa dibayar beneran).
    mock: process.env.PAYMENT_MOCK === 'true',
    duitku: {
      merchantCode: process.env.PAYMENT_MOCK === 'true'
        ? (process.env.DUITKU_MERCHANT_CODE || 'MOCKCODE')
        : required('DUITKU_MERCHANT_CODE'),
      merchantKey: process.env.PAYMENT_MOCK === 'true'
        ? (process.env.DUITKU_MERCHANT_KEY || 'mock-secret-key')
        : required('DUITKU_MERCHANT_KEY'),
      mode: process.env.DUITKU_MODE || 'sandbox', // sandbox | production
    },
  },

  app: {
    port: parseInt(process.env.PORT || '3000', 10),
    publicBaseUrl: process.env.PUBLIC_BASE_URL || 'http://localhost:3000',
    orderExpiryMinutes: parseInt(process.env.ORDER_EXPIRY_MINUTES || '15', 10),
  },
};

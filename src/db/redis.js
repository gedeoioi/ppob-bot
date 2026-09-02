const Redis = require('ioredis');
const config = require('../config');

const redis = new Redis(config.redisUrl);

/**
 * Distributed lock sederhana pakai SET NX PX.
 * Dipakai untuk memastikan satu order/webhook hanya diproses SATU KALI,
 * meskipun provider mengirim webhook retry berkali-kali secara bersamaan.
 *
 * @param {string} key - key unik, misal `lock:order:${refId}`
 * @param {number} ttlMs - berapa lama lock ditahan
 * @returns {Promise<boolean>} true jika berhasil dapat lock, false jika sudah dikunci proses lain
 */
async function acquireLock(key, ttlMs = 10000) {
  const result = await redis.set(key, '1', 'PX', ttlMs, 'NX');
  return result === 'OK';
}

async function releaseLock(key) {
  await redis.del(key);
}

module.exports = { redis, acquireLock, releaseLock };

const Redis = require('ioredis');
const config = require('../config');

const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  enableOfflineQueue: true,
  retryStrategy(times) {
    // exponential backoff capped at 2s
    return Math.min(times * 200, 2000);
  },
  reconnectOnError(err) {
    // reconnect on READONLY etc.
    const targetErrors = ['READONLY', 'ETIMEDOUT', 'ECONNRESET'];
    return targetErrors.some((t) => err.message.includes(t));
  },
  lazyConnect: false,
});

redis.on('error', (err) => console.error('[redis] error:', err.message));
redis.on('connect', () => console.log('[redis] connected'));
redis.on('ready', () => console.log('[redis] ready'));
redis.on('close', () => console.warn('[redis] connection closed'));

async function acquireLock(key, ttlMs = 10_000) {
  try {
    const result = await redis.set(key, '1', 'PX', ttlMs, 'NX');
    return result === 'OK';
  } catch (err) {
    console.error('[redis] acquireLock error:', err.message);
    return false;
  }
}

async function releaseLock(key) {
  try {
    await redis.del(key);
  } catch (err) {
    console.error('[redis] releaseLock error:', err.message);
  }
}

async function checkHealth() {
  const pong = await redis.ping();
  if (pong !== 'PONG') throw new Error('Redis ping failed: ' + pong);
}

async function close() {
  try {
    await redis.quit();
  } catch (_) {
    redis.disconnect();
  }
}

module.exports = { redis, acquireLock, releaseLock, checkHealth, close };

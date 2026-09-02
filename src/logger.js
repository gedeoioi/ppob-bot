const pino = require('pino');

const level = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

let logger;
try {
  // Pretty print only if pino-pretty is installed and not in production
  if (process.env.NODE_ENV !== 'production') require.resolve('pino-pretty');
  logger =
    process.env.NODE_ENV !== 'production'
      ? pino({
          level,
          base: { service: 'ppob-bot' },
          transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } },
        })
      : pino({ level, base: { service: 'ppob-bot' } });
} catch (_) {
  logger = pino({ level, base: { service: 'ppob-bot' } });
}

module.exports = logger;

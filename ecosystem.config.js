// PM2 config for VPS without Docker (alternative to docker-compose)
// Usage: npm i -g pm2 && pm2 start ecosystem.config.js --env production && pm2 save && pm2 startup
module.exports = {
  apps: [
    {
      name: 'ppob-bot',
      script: 'src/index.js',
      instances: 1, // keep 1 — bot long-polling + cron must not duplicate
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '300M',
      autorestart: true,
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
      },
      error_file: 'logs/error.log',
      out_file: 'logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      kill_timeout: 10_000,
      wait_ready: false,
    },
  ],
};

# PPOB Bot — Telegram

Bot Telegram untuk jualan pulsa, paket data, PLN & voucher game. Pembayaran via **QRIS** atau **saldo** — proses otomatis.

- Landing page simpel di `https://domainmu.com/`
- Callback QRIS: `POST /webhook/duitku`, TokoVoucher: `POST /webhook/tokovoucher`

## Fitur

- `/produk` + `/kategori` + pagination, `/topup` QRIS, `/saldo` & `/mutasi`, `/riwayat`
- Dua provider: `digiflazz` / `tokovoucher` / `both` (hybrid per produk)
- Refund otomatis jika transaksi gagal

## Tech stack

Node 20, Express, grammy, PostgreSQL, Redis, Duitku, Digiflazz/TokoVoucher, Docker.

## Setup lokal

```bash
npm install
cp .env.example .env   # isi kredensial
npm run migrate
npm run sync:products              # Digiflazz
# atau
npm run sync:tokovoucher           # TokoVoucher
npm run dev
```

Env penting: `TELEGRAM_BOT_TOKEN`, `DATABASE_URL`, `REDIS_URL`, `TRANSACTION_PROVIDER`, `PAYMENT_MOCK`, `PUBLIC_BASE_URL` (lihat `.env.example`).

## Deploy VPS (Docker)

Rangkuman — detail lengkap: [`docs/deploy-vps.md`](docs/deploy-vps.md)

```bash
# VPS
git clone <repo> /opt/ppob-bot && cd /opt/ppob-bot
cp .env.example .env && nano .env
docker compose up -d --build
docker compose exec app npm run migrate
docker compose exec app npm run sync:products
curl http://127.0.0.1:3000/healthz

# Nginx + HTTPS
sudo cp nginx.conf.example /etc/nginx/sites-available/ppob-bot
# edit server_name domainmu.com
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d domainmu.com
```

Webhook Duitku: `https://domainmu.com/webhook/duitku` · TokoVoucher: `https://domainmu.com/webhook/tokovoucher` (+ IP whitelist di dashboard).

## Perintah

| Perintah | Deskripsi |
|----------|-----------|
| `npm run migrate` | Buat tabel (schema.sql) |
| `npm run sync:products` | Sync Digiflazz |
| `npm run sync:tokovoucher` | Sync TokoVoucher |
| `node scripts/sync-tokovoucher.js --reset-kategori` | Rapikan kategori |
| `node scripts/recalc-markup.js` | Hitung ulang markup (`markup.config.js`) |
| `npm run test:webhook` | Simulasi callback Duitku |

## Lisensi

Private — untuk kebutuhan internal.

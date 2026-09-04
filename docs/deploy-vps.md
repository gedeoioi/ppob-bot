# Deploy PPOB Bot ke VPS — Step by Step (Docker + Nginx + HTTPS + Webhook + Landing)

Dokumen ini merangkum langkah deploy lengkap agar bot, landing page, dan webhook siap produksi.

> Prasyarat: VPS Ubuntu 22.04/24.04 (1 vCPU / 1–2 GB RAM cukup), domain yang A record-nya sudah mengarah ke IP VPS, dan akses `root`/`sudo`.

---

## 0. Arsitektur singkat

```
Telegram (long polling) → Node app :3000 (bot + /webhook/* + /public landing)
Duitku QRIS  POST → https://domainmu.com/webhook/duitku
TokoVoucher  POST → https://domainmu.com/webhook/tokovoucher (jika pakai TokoVoucher)
Nginx :80/:443 (TLS) ──proxy──► app :3000
Postgres :5432, Redis :6379 (compose)
Landing: https://domainmu.com/  → public/index.html (hanya cara kerja bot)
```

---

## 1. Siapkan VPS & domain

### 1a. DNS
Di registrar/Cloudflare:
- `A @ → IP_VPS` dan `A www → IP_VPS` (atau sesuai domainmu, mis `deoioi.my.id`).

Cek:
```bash
dig domainmu.com +short
nslookup domainmu.com
```

### 1b. Akses awal VPS
```bash
ssh root@IP_VPS
apt update && apt upgrade -y
adduser deploy
usermod -aG sudo deploy
rsync -a ~/.ssh /home/deploy/ 2>/dev/null || true; chown -R deploy:deploy /home/deploy/.ssh
su - deploy
```

### 1c. Firewall
```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
sudo ufw status verbose
```

---

## 2. Install Docker

```bash
sudo apt install -y ca-certificates curl gnupg git
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update && sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker deploy
newgrp docker   # atau re-login: exit → ssh deploy@IP
docker ps
```

---

## 3. Ambil kode & buat `.env` production

```bash
cd /opt
sudo git clone https://github.com/KAMU/ppob-bot-private.git ppob-bot
sudo chown -R deploy:deploy ppob-bot
cd /opt/ppob-bot
cp .env.example .env
nano .env
```

Isi minimal (sesuaikan):

```ini
NODE_ENV=production
PORT=3000
PUBLIC_BASE_URL=https://domainmu.com
ORDER_EXPIRY_MINUTES=15
LOG_LEVEL=info

# DB/Redis — compose override ke postgres/redis
DATABASE_URL=postgres://ppob_user:PASSWORD_KUAT@postgres:5432/ppob_bot
POSTGRES_DB=ppob_bot
POSTGRES_USER=ppob_user
POSTGRES_PASSWORD=PASSWORD_KUAT

REDIS_URL=redis://redis:6379
# jika pakai password redis:
# REDIS_PASSWORD=PASSWORD_KUAT_REDIS
# REDIS_URL=redis://:PASSWORD_KUAT_REDIS@redis:6379

TELEGRAM_BOT_TOKEN=1234567890:AAH...
TRANSACTION_PROVIDER=digiflazz   # digiflazz | tokovoucher | both

DIGIFLAZZ_USERNAME=...
DIGIFLAZZ_API_KEY=...
DIGIFLAZZ_TESTING=false

TOKOVOUCHER_MEMBER_CODE=...      # jika tokovoucher/both
TOKOVOUCHER_SECRET=...

PAYMENT_GATEWAY=duitku
PAYMENT_MOCK=false               # true hanya untuk staging dummy QR
DUITKU_MERCHANT_CODE=...
DUITKU_MERCHANT_KEY=...
DUITKU_MODE=production           # sandbox | production

ADMIN_IDS=2110398202
```

> `docker-compose.yml:44-46` override `DATABASE_URL`/`REDIS_URL` ke service internal saat `NODE_ENV=production`, jadi `.env` yang tulis `localhost` tetap aman.

Validasi guard (`src/config.js`): di production, `PAYMENT_MOCK` & `DIGIFLAZZ_TESTING` harus `false`, `DUITKU_MODE=production`, `PUBLIC_BASE_URL` tidak boleh `ngrok/localhost`.

---

## 4. Build, migrasi, & seed produk

```bash
docker compose up -d --build
docker compose ps            # all healthy
docker compose logs app --tail 50
# harap: [webhook] listening on port 3000, [bot] Telegram bot running

# Migrasi DB (buat tabel users, products, orders, topups, etc.)
docker compose exec app npm run migrate

# Seed produk (pilih salah satu sesuai provider):
docker compose exec app npm run sync:products              # Digiflazz (30 teratas)
docker compose exec app node scripts/sync-products.js Telkomsel
docker compose exec app npm run sync:tokovoucher           # TokoVoucher
docker compose exec app node scripts/sync-tokovoucher.js FF
docker compose exec app node scripts/sync-tokovoucher.js --reset-kategori  # rapikan 19→9 kategori
docker compose exec app node scripts/check-kategori.js
docker compose exec app node scripts/recalc-markup.js --dry-run
docker compose exec app node scripts/recalc-markup.js      # terapkan markup config

# Cek health
curl http://127.0.0.1:3000/healthz   # {"ok":true}
curl http://127.0.0.1:3000/readyz    # {"ok":true}
curl http://127.0.0.1:3000/ | head   # landing html
```

### Error yang sering muncul
- `POSTGRES_PASSWORD is missing` → cek `.env` ada `POSTGRES_PASSWORD=...` tanpa spasi `VAR = val`.
- `"/package-lock.json": not found` → sudah di-fix di `Dockerfile` (fallback `npm install`), pull terbaru.
- `redis unhealthy` → sudah di-fix, cek `docker compose logs redis`, pastikan `REDIS_PASSWORD` konsisten.
- `Config production tidak aman: PAYMENT_MOCK harus false` → set `PAYMENT_MOCK=false` + dummy Duitku untuk lolos start, atau `NODE_ENV=development` untuk staging.

---

## 5. Nginx + HTTPS (landing + webhook)

File template sudah ada: `nginx.conf.example`. Pasang:

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo cp nginx.conf.example /etc/nginx/sites-available/ppob-bot
sudo nano /etc/nginx/sites-available/ppob-bot   # ganti server_name domainmu.com
sudo ln -s /etc/nginx/sites-available/ppob-bot /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# HTTP dulu (sebelum TLS) untuk verifikasi:
curl http://domainmu.com/        # landing
curl http://domainmu.com/healthz

# Issuer TLS (butuh DNS sudah propagasi):
sudo certbot --nginx -d domainmu.com -d www.domainmu.com
sudo nginx -t && sudo systemctl reload nginx
curl https://domainmu.com/
```

> Jika domain belum propagasi (`SERVFAIL`), pakai IP sementara:
> - `PUBLIC_BASE_URL=http://IP_VPS:3000` + `server_name IP_VPS` di nginx
> - Ganti balik ke `https://domainmu.com` setelah `dig domainmu.com +short` keluar IP.

Landing dilayani oleh Node static `public/index.html` + `express.static(public)` di `src/webhook.js`. Nginx `location /` proxy semuanya ke app; `/webhook/` dan `/healthz` juga di-proxy.

---

## 6. Aktifkan Webhook

### Duitku QRIS
- Dashboard Duitku → Callback URL: `https://domainmu.com/webhook/duitku`
- Return URL (opsional): `https://domainmu.com/webhook/duitku/return`
- Verifikasi: bayar QRIS real atau `docker compose exec app node scripts/test-webhook.js ORDxxx` lalu cek `SELECT source, signature_valid FROM webhook_logs ORDER BY id DESC LIMIT 5;` dan notif bot.

### TokoVoucher (jika `tokovoucher`/`both`)
- `member.tokovoucher.net` → pengaturan webhook → URL: `https://domainmu.com/webhook/tokovoucher`
- IP whitelist: `member.tokovoucher.net/pengaturan/ip-whitelist` → tambah IP VPS.
- Header `X-TokoVoucher-Authorization: md5(MEMBER_CODE:SECRET:REF_ID)` sudah diverifikasi di `src/services/tokovoucher.js:199`.

### Tanpa webhook
Bot tetap jalan via polling (`src/jobs/index.js`: Digiflazz 2 menit, TokoVoucher 10 menit), hanya notifikasi lebih lambat. Webhook dianjurkan untuk real-time.

---

## 7. Cek bot & operasional

Telegram:
- `/start` → `/produk` → pilih produk → masukkan nomor → `💰 Bayar Saldo` / `💳 Bayar QRIS` → cek `/riwayat`, `/saldo`, `/mutasi`.

DB:
```bash
docker compose exec postgres psql -U ppob_user -d ppob_bot -c "SELECT ref_id, status, provider, total_bayar FROM orders ORDER BY id DESC LIMIT 5;"
```

Admin:
- `/admin` (hanya `ADMIN_IDS`) — stats, transaksi, refund, tambah saldo member, dll.

Landing: `https://domainmu.com/` hanya cara kerja bot (tanpa bahas markup/provider).

Logs & health:
```bash
docker compose logs -f app --tail 100
curl https://domainmu.com/readyz
```

---

## 8. Update & backup

```bash
cd /opt/ppob-bot
git pull
docker compose up -d --build

# Jika edit markup:
nano markup.config.js
docker compose exec app node scripts/recalc-markup.js

# Reset kategori TokoVoucher (19→9):
docker compose exec app node scripts/sync-tokovoucher.js --reset-kategori

# Reset produk total:
docker compose exec postgres psql -U ppob_user -d ppob_bot -c "DELETE FROM products;"
docker compose exec app npm run sync:tokovoucher
docker compose exec app npm run sync:products

# Backup harian Postgres (contoh crontab):
# (crontab -l 2>/dev/null; echo "0 2 * * * pg_dump postgres://ppob_user:PASS@localhost:5432/ppob_bot | gzip > /home/deploy/backup-\$(date +\%F).sql.gz") | crontab -
```

---

## 9. Skrip referensi cepat

```bash
npm run migrate
npm run sync:products
npm run sync:tokovoucher
node scripts/check-kategori.js
node scripts/check-markup.js
node scripts/recalc-markup.js --dry-run; node scripts/recalc-markup.js
node scripts/sync-tokovoucher.js --reset-kategori
```

Selesai — bot, landing, & webhook siap produksi.

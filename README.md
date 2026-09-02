# Bot Telegram PPOB (Digiflazz + QRIS Dinamis)

Bot Telegram untuk jualan produk PPOB (pulsa, token listrik, dll) via API Digiflazz,
dengan pembayaran QRIS dinamis yang otomatis memproses order begitu pembayaran diterima.

## Struktur Project

```
ppob-bot/
├── schema.sql              # skema database PostgreSQL
├── .env.example            # contoh konfigurasi environment
├── package.json
└── src/
    ├── config.js            # baca & validasi environment variable
    ├── db/
    │   ├── index.js         # koneksi PostgreSQL + helper transaksi
    │   └── redis.js         # koneksi Redis + distributed lock
    ├── services/
    │   ├── digiflazz.js     # integrasi API Digiflazz (topup, cek status, verifikasi webhook)
    │   ├── payment.js       # integrasi payment gateway QRIS (Duitku)
    │   └── order.js         # logika bisnis order (buat order, proses pembayaran sukses)
    ├── bot.js               # handler bot Telegram (grammy)
    ├── webhook.js           # server Express penerima webhook payment gateway
    └── index.js             # entry point, menjalankan bot + webhook bersamaan
```

## Setup

1. Install dependencies:
   ```
   npm install
   ```

2. Copy `.env.example` ke `.env`, lalu isi semua kredensial (Telegram, Digiflazz, Duitku, DB).

3. Buat database PostgreSQL, lalu jalankan schema:
   ```
   npm run migrate
   ```
   (pastikan `DATABASE_URL` di `.env` sudah benar sebelum menjalankan ini)

4. Pastikan Redis berjalan (lokal atau managed, misal Upstash/Redis Cloud).

5. Isi tabel `products` secara manual atau buat script sinkronisasi dari
   `digiflazz.getPriceList()` (lihat `src/services/digiflazz.js`) untuk mengambil
   daftar harga terbaru dan menyimpannya + markup ke tabel `products`.

6. Jalankan aplikasi:
   ```
   npm start
   ```

7. Daftarkan URL callback di dashboard Duitku (menu Project/Merchant Settings) ke:
   ```
   https://domainmu.com/webhook/duitku
   ```
   Domain harus HTTPS aktif (pakai Nginx + Let's Encrypt jika di VPS).

## Testing Tanpa Akun Duitku Sama Sekali (Mode Mock)

Kalau kamu belum punya akun Duitku dan cuma mau tes alur bot dulu, aktifkan mode mock:

```
PAYMENT_MOCK=true
```

Dengan ini, `createQris()` **tidak** memanggil API Duitku sama sekali — langsung generate
QR dummy lokal. Kamu tetap bisa jalankan seluruh alur order → simulasi bayar
(`npm run test:webhook`) → topup Digiflazz (`DIGIFLAZZ_TESTING=true`) dari ujung ke
ujung tanpa akun Duitku. QR dummy ini **tidak bisa dipindai/dibayar beneran** — kalau
sudah siap tes generate QRIS yang sungguhan bisa dipindai, matikan `PAYMENT_MOCK`
(set `false` atau hapus barisnya) dan isi kredensial Duitku sandbox yang asli.

## Uji Coba Tanpa Ngrok / Tanpa Akun Duitku Beneran

Untuk tes alur order → pembayaran → topup Digiflazz secara lokal tanpa perlu expose
server ke internet, gunakan script simulasi webhook:

```bash
# pastikan npm run dev sedang berjalan di terminal lain, lalu:
npm run test:webhook

# atau simulasikan order tertentu (ref_id bisa dilihat dari pesan bot / tabel orders):
node scripts/test-webhook.js ORD1234567ABCDE
```

Script ini otomatis mencari order `pending_payment` terbaru (atau order dengan
`ref_id` yang kamu tentukan), menghitung signature Duitku yang valid, lalu mengirim
POST ke `/webhook/duitku` seolah-olah dari Duitku beneran. Cocok untuk memastikan
logika idempotensi, update status order, dan pemanggilan Digiflazz (pakai
`DIGIFLAZZ_TESTING=true` supaya tidak potong saldo asli) sudah berjalan benar
sebelum kamu repot setup ngrok/akun sandbox Duitku.



- **Verifikasi versi API Duitku**: Duitku punya beberapa varian API (POP vs Direct API v2).
  Kode di `src/services/payment.js` memakai endpoint Direct API `v2/inquiry` dengan metode
  `SP` (QRIS) — cek dashboard Duitku kamu untuk memastikan endpoint & format signature
  yang aktif untuk akunmu sama persis, karena Duitku bisa mengaktifkan API berbeda per merchant.
- **Kalau ganti ke provider lain** (Midtrans/Xendit/Tripay), cukup tulis ulang
  `src/services/payment.js` dan sesuaikan path/format body di `src/webhook.js` —
  bagian `order.js` dan `bot.js` tidak perlu diubah karena sudah dipisah per lapisan.
- **Cron job sudah otomatis aktif** (lihat `src/jobs/index.js`, didaftarkan dari
  `src/index.js` saat aplikasi start):
  - Tiap 1 menit: order `pending_payment` yang lewat `expired_at` diubah jadi `expired`
  - Tiap 2 menit: order `processing` dengan status Digiflazz `Pending` dicek ulang
    otomatis (menghormati anjuran Digiflazz untuk tidak polling ref_id yang sama
    lebih cepat dari 1 menit)
- **Sinkronisasi harga**: jalankan `digiflazz.getPriceList()` terjadwal (misal tiap jam)
  untuk update `harga_beli`/`harga_jual` di tabel `products`, supaya harga tidak basi.
- **Jangan commit file `.env`** ke git — sudah seharusnya ada di `.gitignore`.
- Kode ini adalah **kerangka dasar (MVP)**, bukan sistem siap produksi penuh. Sebelum
  live dengan uang sungguhan, tambahkan: rate limiting per user, admin panel untuk
  approve/refund manual, logging terstruktur, monitoring uptime, dan pengujian end-to-end
  untuk skenario webhook duplikat/gagal.

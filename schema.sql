-- ============================================================
-- Schema Database Bot Telegram PPOB (Digiflazz + QRIS Dinamis)
-- Termasuk fitur saldo member, topup via QRIS, dan refund otomatis
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
    id              BIGSERIAL PRIMARY KEY,
    telegram_id     BIGINT UNIQUE NOT NULL,
    username        VARCHAR(64),
    full_name       VARCHAR(128),
    saldo           BIGINT NOT NULL DEFAULT 0,       -- dalam rupiah, integer (hindari float untuk uang)
    role            VARCHAR(16) NOT NULL DEFAULT 'user', -- user | admin
    is_banned       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
    id              BIGSERIAL PRIMARY KEY,
    buyer_sku_code  VARCHAR(64) UNIQUE NOT NULL,   -- kode SKU dari Digiflazz
    nama            VARCHAR(128) NOT NULL,
    kategori        VARCHAR(64),
    brand           VARCHAR(64),
    tipe            VARCHAR(32),                    -- prepaid | postpaid
    harga_beli      BIGINT NOT NULL,                -- harga dari Digiflazz
    markup          BIGINT NOT NULL DEFAULT 0,       -- markup tetap (rupiah)
    harga_jual      BIGINT NOT NULL,                 -- harga_beli + markup, di-cache, tetap re-validasi saat order
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- status order: pending_payment | paid | processing | success | failed | expired | cancelled
CREATE TABLE IF NOT EXISTS orders (
    id                  BIGSERIAL PRIMARY KEY,
    ref_id              VARCHAR(64) UNIQUE NOT NULL,   -- dipakai sebagai ref_id ke Digiflazz, HARUS unik & idempotent
    user_id             BIGINT NOT NULL REFERENCES users(id),
    buyer_sku_code      VARCHAR(64) NOT NULL,
    customer_no         VARCHAR(64) NOT NULL,           -- nomor HP / ID pelanggan tujuan
    harga_jual          BIGINT NOT NULL,                -- harga dasar produk saat order dibuat
    kode_unik           SMALLINT NOT NULL DEFAULT 0,     -- 3 digit unik untuk pencocokan pembayaran
    total_bayar         BIGINT NOT NULL,                 -- harga_jual + kode_unik
    status              VARCHAR(20) NOT NULL DEFAULT 'pending_payment',
    digiflazz_status    VARCHAR(20),                     -- Sukses | Gagal | Pending
    digiflazz_sn        VARCHAR(128),                    -- serial number hasil transaksi
    expired_at          TIMESTAMPTZ NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);

-- Kolom tambahan untuk refund (idempotent, cek existence sebelum update)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_source VARCHAR(16) NOT NULL DEFAULT 'qris'; -- qris | saldo
ALTER TABLE orders ADD COLUMN IF NOT EXISTS provider VARCHAR(32) NOT NULL DEFAULT 'digiflazz';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS provider_trx_id VARCHAR(64);

-- satu order bisa punya beberapa payment attempt (misal QRIS expired lalu generate ulang)
CREATE TABLE IF NOT EXISTS payments (
    id              BIGSERIAL PRIMARY KEY,
    order_id        BIGINT NOT NULL REFERENCES orders(id),
    gateway         VARCHAR(32) NOT NULL,        -- tripay | duitku | midtrans | xendit
    gateway_ref     VARCHAR(128),                -- reference id dari provider
    qr_string       TEXT,                        -- payload QRIS untuk render QR image
    amount          BIGINT NOT NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | paid | expired | failed
    paid_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_gateway_ref ON payments(gateway_ref);

-- Topup saldo via QRIS (alur terpisah dari orders produk) — buat duluan sebelum balance_mutations FK ke topups
CREATE TABLE IF NOT EXISTS topups (
    id              BIGSERIAL PRIMARY KEY,
    ref_id          VARCHAR(64) UNIQUE NOT NULL,   -- TOP + timestamp + random, dipakai sebagai merchantOrderId
    user_id         BIGINT NOT NULL REFERENCES users(id),
    amount          BIGINT NOT NULL,                -- nominal topup sebelum kode unik
    kode_unik       SMALLINT NOT NULL DEFAULT 0,
    total_bayar     BIGINT NOT NULL,                -- amount + kode_unik (yang dibayar via QRIS)
    status          VARCHAR(20) NOT NULL DEFAULT 'pending_payment', -- pending_payment | paid | success | failed | expired
    gateway         VARCHAR(32) NOT NULL DEFAULT 'duitku',
    gateway_ref     VARCHAR(128),
    qr_string       TEXT,
    expired_at      TIMESTAMPTZ NOT NULL,
    paid_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_topups_user ON topups(user_id);
CREATE INDEX IF NOT EXISTS idx_topups_status ON topups(status);
CREATE INDEX IF NOT EXISTS idx_topups_ref ON topups(ref_id);

-- Tambah kolom topup_id ke balance_mutations jika DB lama belum punya (harus setelah topups dibuat)
-- Untuk DB lama, kolom topup_id mungkin belum ada — buat secara eksplisit agar balance_mutations baru bisa refer ke topups
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'balance_mutations') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'balance_mutations' AND column_name = 'topup_id') THEN
      ALTER TABLE balance_mutations ADD COLUMN topup_id BIGINT REFERENCES topups(id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'balance_mutations' AND column_name = 'description') THEN
      ALTER TABLE balance_mutations ADD COLUMN description VARCHAR(255);
    END IF;
  END IF;
END $$;

-- audit log tiap request/response ke Digiflazz / TokoVoucher
CREATE TABLE IF NOT EXISTS digiflazz_logs (
    id              BIGSERIAL PRIMARY KEY,
    order_id        BIGINT REFERENCES orders(id),
    action          VARCHAR(32) NOT NULL,   -- topup | cek-status | cek-harga
    request_payload JSONB,
    response_payload JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- log provider baru (tokovoucher dll) — fallback digiflazz_logs jika belum ada
CREATE TABLE IF NOT EXISTS provider_logs (
    id              BIGSERIAL PRIMARY KEY,
    order_id        BIGINT REFERENCES orders(id),
    provider        VARCHAR(32) NOT NULL,   -- tokovoucher | digiflazz
    action          VARCHAR(32) NOT NULL,
    request_payload JSONB,
    response_payload JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- simpan payload mentah tiap webhook masuk (payment gateway maupun Digiflazz) untuk forensik
CREATE TABLE IF NOT EXISTS webhook_logs (
    id              BIGSERIAL PRIMARY KEY,
    source          VARCHAR(32) NOT NULL,   -- tripay | duitku | midtrans | digiflazz
    signature_valid BOOLEAN NOT NULL,
    raw_payload     JSONB NOT NULL,
    processed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- catatan mutasi saldo (top up, refund, pembayaran order via saldo)
CREATE TABLE IF NOT EXISTS balance_mutations (
    id              BIGSERIAL PRIMARY KEY,
    user_id         BIGINT NOT NULL REFERENCES users(id),
    order_id        BIGINT REFERENCES orders(id),
    topup_id        BIGINT REFERENCES topups(id),
    amount          BIGINT NOT NULL,      -- positif = kredit, negatif = debit
    reason          VARCHAR(64) NOT NULL, -- topup | order_payment | refund | admin_adjust | topup_refund
    description     VARCHAR(255),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
) ;

CREATE INDEX IF NOT EXISTS idx_balance_user ON balance_mutations(user_id);
CREATE INDEX IF NOT EXISTS idx_balance_order ON balance_mutations(order_id);
CREATE INDEX IF NOT EXISTS idx_balance_topup ON balance_mutations(topup_id);

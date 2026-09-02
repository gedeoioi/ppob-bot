-- ============================================================
-- Schema Database Bot Telegram PPOB (Digiflazz + QRIS Dinamis)
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

-- audit log tiap request/response ke Digiflazz
CREATE TABLE IF NOT EXISTS digiflazz_logs (
    id              BIGSERIAL PRIMARY KEY,
    order_id        BIGINT REFERENCES orders(id),
    action          VARCHAR(32) NOT NULL,   -- topup | cek-status | cek-harga
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

-- catatan mutasi saldo (top up manual, refund, dsb) - opsional tapi disarankan untuk audit
CREATE TABLE IF NOT EXISTS balance_mutations (
    id              BIGSERIAL PRIMARY KEY,
    user_id         BIGINT NOT NULL REFERENCES users(id),
    order_id        BIGINT REFERENCES orders(id),
    amount          BIGINT NOT NULL,      -- positif = kredit, negatif = debit
    reason          VARCHAR(64) NOT NULL, -- deposit | order_payment | refund | admin_adjust
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

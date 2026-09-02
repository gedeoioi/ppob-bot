/**
 * Sync produk dari TokoVoucher ke tabel products lokal.
 * Simpan kode_produk TokoVoucher ke buyer_sku_code (provider-agnostic).
 * Jalankan: node scripts/sync-tokovoucher.js [kodeFilter]
 *   kodeFilter opsional misal FF / ML untuk filter prefix kode.
 */
const db = require('../src/db');
const tokv = require('../src/services/tokovoucher');

const MARKUP_DEFAULT = 500;

async function main() {
  const kodeFilter = process.argv[2]; // misal FF
  console.log('Mengambil daftar produk dari TokoVoucher...');
  let full;
  try {
    full = await tokv.getProductFull();
  } catch (e) {
    console.error('Gagal ambil full:', e.message);
    // fallback coba ambil via kode jika full gagal
    if (kodeFilter) {
      console.log(`Fallback: ambil produk kode ${kodeFilter} ...`);
      const list = await tokv.getProductByCode(kodeFilter);
      full = { produk: list.map(p => ({ kode_produk: p.code, nama: p.nama_produk, deskripsi: p.deskripsi, price: p.price, status: p.status, kategori_id: 0, operator_id: 0, jenis_id: 0 })), category: [], operator: [], jenis: [] };
    } else throw e;
  }

  const produk = full.produk || [];
  const categories = new Map((full.category || []).map(c => [c.id, c.nama]));
  const operators = new Map((full.operator || []).map(o => [o.id, o]));
  const jenisMap = new Map((full.jenis || []).map(j => [j.id, j]));

  let filtered = produk.filter(p => p.status === 1);
  if (kodeFilter) {
    const f = kodeFilter.toLowerCase();
    filtered = filtered.filter(p => String(p.kode_produk || '').toLowerCase().startsWith(f));
  }
  if (filtered.length === 0) {
    console.log('Tidak ada produk aktif yang cocok.');
    process.exit(0);
  }
  const toInsert = kodeFilter ? filtered : filtered.slice(0, 80);
  console.log(`Menyimpan ${toInsert.length} produk ke database (dari ${filtered.length} cocok)...`);

  for (const p of toInsert) {
    const kategori = categories.get(p.kategori_id) || categories.get(p.category_id) || 'Lainnya';
    const op = operators.get(p.operator_id);
    const brand = op ? op.nama : 'TokoVoucher';
    const tipe = 'prepaid';
    const nama = p.nama || p.deskripsi || p.kode_produk;
    const price = Number(p.price || p.price_vip || 0);
    const hargaJual = price + MARKUP_DEFAULT;

    await db.query(
      `INSERT INTO products (buyer_sku_code, nama, kategori, brand, tipe, harga_beli, markup, harga_jual, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)
       ON CONFLICT (buyer_sku_code) DO UPDATE SET
         nama = EXCLUDED.nama,
         kategori = EXCLUDED.kategori,
         brand = EXCLUDED.brand,
         harga_beli = EXCLUDED.harga_beli,
         harga_jual = EXCLUDED.harga_jual,
         updated_at = now()`,
      [p.kode_produk, nama, kategori || 'Voucher Game', brand, tipe, price, MARKUP_DEFAULT, hargaJual]
    );
    console.log(`  - ${p.kode_produk} | ${nama} | ${kategori} | Rp${hargaJual.toLocaleString('id-ID')}`);
  }
  console.log('\nSelesai. Cek: SELECT buyer_sku_code, nama, harga_jual FROM products WHERE brand LIKE %Toko% LIMIT 10;');
  process.exit(0);
}

main().catch(err => {
  console.error('Gagal sync tokvoucher:', err.response?.data || err.message);
  process.exit(1);
});

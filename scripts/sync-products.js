/**
 * Ambil daftar harga produk PREPAID dari Digiflazz, lalu simpan/update ke tabel
 * products di database lokal. Dipakai supaya kamu punya buyer_sku_code yang VALID
 * (dikenal Digiflazz), bukan sekadar SKU karangan yang pasti gagal saat topup.
 *
 * Cara pakai:
 *   node scripts/sync-products.js                -> sync semua produk (bisa ratusan!)
 *   node scripts/sync-products.js Telkomsel       -> sync hanya brand tertentu (rekomendasi untuk testing)
 *
 * Markup default 1000 (bisa diubah manual lewat SQL nanti, atau ubah MARKUP_DEFAULT di bawah).
 */
const db = require('../src/db');
const digiflazz = require('../src/services/digiflazz');

const MARKUP_DEFAULT = 1000;

async function main() {
  const brandFilter = process.argv[2]; // opsional, contoh: "Telkomsel"

  console.log('Mengambil daftar harga dari Digiflazz...');
  const priceList = await digiflazz.getPriceList();

  let filtered = priceList.filter((p) => p.seller_product_status && p.buyer_product_status);
  if (brandFilter) {
    filtered = filtered.filter((p) => p.brand?.toLowerCase().includes(brandFilter.toLowerCase()));
  }

  if (filtered.length === 0) {
    console.log('Tidak ada produk yang cocok/aktif. Coba tanpa filter brand atau cek nama brand-nya.');
    process.exit(0);
  }

  // Batasi supaya tidak insert ratusan produk sekaligus saat testing tanpa filter
  const toInsert = brandFilter ? filtered : filtered.slice(0, 30);
  console.log(`Menyimpan ${toInsert.length} produk ke database...`);

  for (const p of toInsert) {
    const hargaJual = Number(p.price) + MARKUP_DEFAULT;
    await db.query(
      `INSERT INTO products (buyer_sku_code, nama, kategori, brand, tipe, harga_beli, markup, harga_jual, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)
       ON CONFLICT (buyer_sku_code) DO UPDATE SET
         nama = EXCLUDED.nama,
         harga_beli = EXCLUDED.harga_beli,
         harga_jual = EXCLUDED.harga_jual,
         updated_at = now()`,
      [p.buyer_sku_code, p.product_name, p.category, p.brand, p.type, p.price, MARKUP_DEFAULT, hargaJual]
    );
    console.log(`  - ${p.buyer_sku_code} | ${p.product_name} | Rp${hargaJual.toLocaleString('id-ID')}`);
  }

  console.log('\nSelesai. Cek dengan: SELECT * FROM products;');
  process.exit(0);
}

main().catch((err) => {
  console.error('Gagal sync produk:', err.response?.data || err.message);
  process.exit(1);
});

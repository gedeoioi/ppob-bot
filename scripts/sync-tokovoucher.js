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
  // Filter kategori tambahan: arg2 bisa berupa nama kategori TokoVoucher, misal "Topup Game"
  const kategoriFilter = process.argv[3];
  if (kodeFilter) {
    const f = kodeFilter.toLowerCase();
    // Jika filter terlihat seperti kategori (mengandung spasi / panjang >4), pakai filter kategori
    if (kodeFilter.includes(' ') || /pulsa|pln|game|voucher|ewallet|tagihan/i.test(kodeFilter)) {
      const catIds = [...categories.entries()].filter(([id, name]) => String(name).toLowerCase().includes(f)).map(([id])=>id);
      if (catIds.length) {
        filtered = filtered.filter(p => catIds.includes(p.kategori_id) || catIds.includes(p.category_id));
        console.log(`Filter kategori "${kodeFilter}" -> ids ${catIds.join(',')} cocok ${filtered.length}`);
      }
    } else {
      filtered = filtered.filter(p => String(p.kode_produk || '').toLowerCase().startsWith(f));
    }
  }
  if (kategoriFilter) {
    const cf = kategoriFilter.toLowerCase();
    const catIds2 = [...categories.entries()].filter(([id, name]) => String(name).toLowerCase().includes(cf)).map(([id])=>id);
    if (catIds2.length) filtered = filtered.filter(p => catIds2.includes(p.kategori_id) || catIds2.includes(p.category_id));
  }
  if (filtered.length === 0) {
    console.log('Tidak ada produk aktif yang cocok. Kategori tersedia:', [...categories.values()].join(', '));
    process.exit(0);
  }
  const toInsert = kodeFilter ? filtered.slice(0, 120) : filtered.slice(0, 80);
  console.log(`Menyimpan ${toInsert.length} produk ke database (dari ${filtered.length} cocok)...`);

  // Map kategori TokoVoucher (full list) ke label konsisten + emoji
  const CATEGORY_MAP = {
    // Game
    'Topup Game': '🎮 Topup Game',
    'Voucher Game': '🎮 Voucher Game',
    'Games': '🎮 Topup Game',
    // Pulsa/Data
    'Pulsa': '📱 Pulsa',
    'Paket Data': '📶 Paket Data',
    'Data': '📶 Paket Data',
    'Voucher Data': '📶 Paket Data',
    'Masa Aktif': '📱 Pulsa',
    'Telpon & SMS': '📱 Pulsa',
    'Aktivasi Perdana': '📱 Pulsa',
    'Philippines Topup': '🌏 Topup Luar Negeri',
    'Singapore Topup': '🌏 Topup Luar Negeri',
    // PLN
    'PLN': '⚡ PLN',
    'Token PLN': '⚡ PLN',
    // E-Wallet
    'E-Money': '💳 E-Wallet',
    'E-Wallet': '💳 E-Wallet',
    'E-Wallet / E-Money': '💳 E-Wallet',
    'Transfer Dana': '💳 E-Wallet',
    // Tagihan
    'Tagihan': '🧾 Tagihan',
    'Pascabayar': '🧾 Pascabayar',
    'TV': '📺 TV & Hiburan',
    'Hiburan': '📺 TV & Hiburan',
    'Injek Voucher Kosong': '📦 Lainnya',
  };
  function prettyKategori(raw) {
    if (!raw) return '📦 Lainnya';
    const t = String(raw).trim();
    if (CATEGORY_MAP[t]) return CATEGORY_MAP[t];
    // Fallback: pertahankan nama asli dengan kapitalisasi rapi
    // Hilangkan prefix angka / simbol aneh dari API
    return t.replace(/\s+/g, ' ').trim();
  }
  // Urutan kategori yang diinginkan di menu (dipakai juga di bot.js)
  const ORDER = ['🎮 Topup Game','🎮 Voucher Game','📱 Pulsa','📶 Paket Data','⚡ PLN','💳 E-Wallet','🧾 Tagihan','🧾 Pascabayar','📺 TV & Hiburan','🌏 Topup Luar Negeri','📦 Lainnya'];

  for (const p of toInsert) {
    const rawKat = categories.get(p.kategori_id) || categories.get(p.category_id) || categories.get(p.kategori) || p.category || 'Lainnya';
    // Jika kategori masih Lainnya, coba tebak dari brand/operator
    let kategori = prettyKategori(rawKat);
    if (kategori === '📦 Lainnya' || kategori === 'Lainnya') {
      const op = operators.get(p.operator_id);
      const brandTmp = op ? op.nama : '';
      const low = `${p.nama||''} ${p.deskripsi||''} ${brandTmp}`.toLowerCase();
      if (/(free fire|mobile legend|ml|pubg|genshin|valorant|diamond|game)/.test(low)) kategori = '🎮 Topup Game';
      else if (/(pulsa|telkomsel|xl|axis|indosat|tri|smartfren|by\.u)/.test(low)) kategori = '📱 Pulsa';
    }
    const op = operators.get(p.operator_id);
    const brand = op ? op.nama : 'TokoVoucher';
    const tipe = 'prepaid';
    // Nama produk TokoVoucher sering redundant "Free Fire 5 Diamond" — rapikan
    let nama = p.nama || p.deskripsi || p.kode_produk;
    nama = String(nama).replace(/\s+/g,' ').trim();
    if (nama.length > 64) nama = nama.slice(0, 62).trim() + '…';
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
      [p.kode_produk, nama, kategori, brand, tipe, price, MARKUP_DEFAULT, hargaJual]
    );
    console.log(`  - ${p.kode_produk} | ${nama} | ${kategori} | Rp${hargaJual.toLocaleString('id-ID')}`);
  }
  console.log('\nSelesai. Cek: SELECT buyer_sku_code, nama, harga_jual FROM products WHERE brand LIKE %Toko% LIMIT 10;');
  process.exit(0);
}

async function resetKategori() {
  console.log('Reset kategori: gabung semua kategori lama ke mapping baru (tidak hapus produk)...');
  const MAP = {
    'Games': '🎮 Topup Game',
    'Topup Game': '🎮 Topup Game',
    'Voucher Game': '🎮 Voucher Game',
    'Pulsa': '📱 Pulsa',
    'Masa Aktif': '📱 Pulsa',
    'Telpon & SMS': '📱 Pulsa',
    'Aktivasi Perdana': '📱 Pulsa',
    'Philippines Topup': '🌏 Topup Luar Negeri',
    'Singapore Topup': '🌏 Topup Luar Negeri',
    'Paket Data': '📶 Paket Data',
    'Data': '📶 Paket Data',
    'Voucher Data': '📶 Paket Data',
    'PLN': '⚡ PLN',
    'E-Money': '💳 E-Wallet',
    'Transfer Dana': '💳 E-Wallet',
    'Pascabayar': '🧾 Pascabayar',
    'TV': '📺 TV & Hiburan',
    'Hiburan': '📺 TV & Hiburan',
    'Injek Voucher Kosong': '📦 Lainnya',
  };
  for (const [oldKat, newKat] of Object.entries(MAP)) {
    const r = await db.query('UPDATE products SET kategori=$1, updated_at=now() WHERE kategori=$2', [newKat, oldKat]);
    if (r.rowCount > 0) console.log(`  ${oldKat} -> ${newKat} : ${r.rowCount} produk`);
  }
  console.log('Reset selesai. Jalankan ulang check-kategori untuk verifikasi.');
}

if (process.argv.includes('--reset-kategori')) {
  resetKategori().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
}

main().catch(err => {
  console.error('Gagal sync tokvoucher:', err.response?.data || err.message);
  process.exit(1);
});

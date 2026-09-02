/**
 * Konfigurasi markup berdasarkan range harga_beli.
 * Diurutkan dari max terkecil ke terbesar. Jika harga melebihi max terakhir, pakai rule terakhir.
 * Ganti angka sesuai kebijakan bisnis. Restart sync agar terpakai.
 * MARKUP bisa berupa nilai fixed (rupiah) atau persen — lihat type.
 *
 * Contoh di bawah: margin kecil untuk produk murah, besar untuk produk mahal.
 */
module.exports = [
  // harga_beli 0 - 5.000 => markup 500
  { max: 5000, markup: 500, type: 'fixed' },
  // 5.001 - 15.000 => 800
  { max: 15000, markup: 800, type: 'fixed' },
  // 15.001 - 50.000 => 1.200
  { max: 50000, markup: 1200, type: 'fixed' },
  // 50.001 - 100.000 => 2.000
  { max: 100000, markup: 2000, type: 'fixed' },
  // 100.001 - 300.000 => 3.500
  { max: 300000, markup: 3500, type: 'fixed' },
  // >300.000 => 5.000
  { max: Infinity, markup: 5000, type: 'fixed' },

  // Alternatif persen (uncomment jika mau):
  // { max: 100000, markup: 5, type: 'percent' }, // 5%
];

function calcMarkup(hargaBeli) {
  const price = Number(hargaBeli);
  for (const rule of module.exports) {
    if (price <= rule.max) {
      if (rule.type === 'percent') return Math.round(price * (rule.markup / 100));
      return rule.markup;
    }
  }
  return module.exports[module.exports.length - 1].markup;
}

module.exports.calcMarkup = calcMarkup;

/**
 * Hitung ulang markup & harga_jual untuk semua produk yang sudah ada di DB
 * sesuai markup.config.js, tanpa perlu sync ulang ke provider.
 * Jalankan: node scripts/recalc-markup.js [--dry-run]
 */
const db = require('../src/db');
const { calcMarkup } = require('../markup.config');

async function main() {
  const dry = process.argv.includes('--dry-run');
  const res = await db.query('SELECT id, buyer_sku_code, nama, harga_beli, markup, harga_jual FROM products ORDER BY harga_beli');
  if (res.rows.length === 0) { console.log('Tidak ada produk.'); process.exit(0); }
  console.log(`${dry ? '[DRY RUN] ' : ''}Recalc ${res.rows.length} produk...`);
  let changed = 0;
  for (const p of res.rows) {
    const newMarkup = calcMarkup(p.harga_beli);
    const newJual = Number(p.harga_beli) + newMarkup;
    if (newMarkup !== Number(p.markup) || newJual !== Number(p.harga_jual)) {
      changed++;
      console.log(`  ${p.buyer_sku_code} | ${p.nama.slice(0,30)} | beli ${p.harga_beli} markup ${p.markup}->${newMarkup} jual ${p.harga_jual}->${newJual}`);
      if (!dry) {
        await db.query('UPDATE products SET markup=$1, harga_jual=$2, updated_at=now() WHERE id=$3', [newMarkup, newJual, p.id]);
      }
    }
  }
  console.log(`\nSelesai. ${changed} produk perlu update${dry ? ' (dry-run, tidak disimpan)' : ''}.`);
  if (dry) console.log('Jalankan tanpa --dry-run untuk simpan.');
  await db.pool.end();
}
main().catch(e=>{console.error(e);process.exit(1);});

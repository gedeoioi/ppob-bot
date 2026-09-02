const config = require('../config');

/**
 * Router provider transaksi.
 * Single-provider toggle via TRANSACTION_PROVIDER=digiflazz|tokovoucher
 * Tambah provider baru: tambah case di sini + service mirror digiflazz/tokovoucher.
 */

function getProviderService(name) {
  const p = (name || config.transactionProvider || 'digiflazz').toLowerCase();
  if (p === 'tokovoucher') return require('./tokovoucher');
  if (p === 'digiflazz') return require('./digiflazz');
  throw new Error(`Provider tidak dikenal: ${p}`);
}

function currentProvider() {
  return (config.transactionProvider || 'digiflazz').toLowerCase();
}

function getProviderServiceForOrder(order) {
  const p = (order && order.provider ? String(order.provider) : currentProvider()).toLowerCase();
  // Jika both tapi order.provider masih global 'both' (sebelum fix), fallback ke digiflazz
  if (p === 'both') return getProviderService('digiflazz');
  return getProviderService(p);
}

function resolveProviderForProduct(product) {
  const mode = currentProvider();
  if (mode !== 'both') return mode;
  // Hybrid: pakai kolom products.provider per produk; fallback ke digiflazz untuk produk lama tanpa provider
  const pp = product && product.provider ? String(product.provider).toLowerCase() : '';
  if (pp === 'tokovoucher' || pp === 'digiflazz') return pp;
  return 'digiflazz';
}

function isHybrid() {
  return currentProvider() === 'both';
}

module.exports = { getProviderService, currentProvider, getProviderServiceForOrder, resolveProviderForProduct, isHybrid };

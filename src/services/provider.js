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
  // Per-order provider disimpan di orders.provider; fallback ke global jika kosong (order lama)
  const p = (order && order.provider ? String(order.provider) : currentProvider()).toLowerCase();
  return getProviderService(p);
}

module.exports = { getProviderService, currentProvider, getProviderServiceForOrder };

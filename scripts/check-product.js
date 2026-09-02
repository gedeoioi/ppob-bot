const axios = require('axios');
const crypto = require('crypto');
const cfg = require('../src/config');
(async () => {
  const u = String(cfg.digiflazz.username).trim();
  const k = String(cfg.digiflazz.apiKey).trim();
  const sign = crypto.createHash('md5').update(u+k+'pricelist').digest('hex');
  const { data } = await axios.post(cfg.digiflazz.baseUrl+'/price-list', { cmd:'prepaid', username:u, sign }, {timeout:8000});
  const list = data.data || [];
  const sku = process.argv[2] || '3m5w64';
  const found = list.find(p=>p.buyer_sku_code===sku);
  console.log('total pricelist', list.length);
  console.log('search', sku, found ? JSON.stringify(found,null,2) : 'NOT FOUND');
  if (!found) {
    console.log('available skus sample', list.slice(0,5).map(p=>p.buyer_sku_code).join(', '));
  }
})();

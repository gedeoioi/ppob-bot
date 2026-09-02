const axios = require('axios');
const crypto = require('crypto');
const cfg = require('../src/config');
(async () => {
  const u = String(cfg.digiflazz.username).trim();
  const k = String(cfg.digiflazz.apiKey).trim();
  const sign = crypto.createHash('md5').update(u+k+'pricelist').digest('hex');
  console.log('username', u, 'apiKey', k, 'sign', sign);
  try {
    const {data} = await axios.post(cfg.digiflazz.baseUrl+'/price-list', {cmd:'prepaid', username:u, sign}, {timeout:8000});
    const arr = Array.isArray(data.data) ? data.data : [];
    console.log('pricelist ok, items', arr.length, 'keys', Object.keys(data));
    if (arr.length) console.log('first sku', arr[0].buyer_sku_code, 'name', arr[0].product_name);
    else console.log('raw', JSON.stringify(data).slice(0,1000));
  } catch(e) {
    console.log('pricelist error', JSON.stringify(e.response?.data||e.message).slice(0,1000));
  }
})();

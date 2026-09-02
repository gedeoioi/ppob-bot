const {calcMarkup} = require('../markup.config');
[1000,5000,5001,15000,15001,50000,50001,100000,150000,300000,500000].forEach(p=>console.log(p, '->', calcMarkup(p)));

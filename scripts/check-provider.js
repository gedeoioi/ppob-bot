const c=require('../src/config'); console.log('transactionProvider',c.transactionProvider);
const p=require('../src/services/provider'); console.log('currentProvider',p.currentProvider());
const svc=p.getProviderService(); console.log('svc has topup',typeof svc.topup, 'checkStatus', typeof svc.checkStatus);

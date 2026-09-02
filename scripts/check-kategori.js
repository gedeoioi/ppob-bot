const db=require('../src/db');
(async()=>{
  const r=await db.query('SELECT kategori, COUNT(*)::int cnt FROM products GROUP BY kategori ORDER BY kategori');
  console.log(JSON.stringify(r.rows,null,2));
  const r2=await db.query('SELECT COUNT(*)::int total FROM products WHERE is_active=true');
  console.log('total active', r2.rows[0].total);
  await db.pool.end();
})();

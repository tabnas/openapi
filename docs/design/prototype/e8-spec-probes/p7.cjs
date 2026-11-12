const {o}=require('./h.cjs');
const t=o.parse('openapi: 3.1.0\na: &x {b: [1]}\nc: *x');
console.log('alias shares identity:', t.a===t.c, t.a.b===t.c.b);
// Billion laughs. n=7 (467 bytes) exhausts the heap and aborts the
// process, so it runs only when asked: P7_MAX=7 node p7.cjs
for (const n of [3,4,5,6,7].filter((n) => n <= Number(process.env.P7_MAX || 6))) {
  let s='openapi: 3.1.0\nl0: &l0 [x, x, x, x, x, x, x, x, x, x]\n';
  for(let i=1;i<=n;i++){ s+=`l${i}: &l${i} [${Array(10).fill('*l'+(i-1)).join(', ')}]\n`; }
  const t0=Date.now(); const before=process.memoryUsage().heapUsed;
  let r; try{ r=o.parse(s);}catch(e){console.log('n',n,'ERR',e.code);continue;}
  const ms=Date.now()-t0; const mem=(process.memoryUsage().heapUsed-before)/1e6;
  // count leaves without following identity
  let shared = r['l'+n][0]===r['l'+n][1];
  console.log(`n=${n} bytes=${s.length} parse=${ms}ms heapDelta=${mem.toFixed(1)}MB expanded leaves=10^${n+1} items-shared=${shared}`);
  const t1=Date.now(); try{ o.resolve(r); console.log('   resolve ms', Date.now()-t1);}catch(e){console.log('   resolve err',e.message.slice(0,80));}
}

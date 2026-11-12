const o=require(process.env.OPENAPI_DIST || require('node:path').join(__dirname, '..', '..', '..', '..', 'ts', 'dist', 'openapi.js'));
function show(v){try{return JSON.stringify(v,(k,x)=>typeof x==='number'&&!isFinite(x)?String(x):typeof x==='bigint'?x+'n':x);}catch(e){return '<'+e.message+'>';}}
function P(label,text,opts){let out;try{out=show(o.parse(text,opts));}catch(e){out='ERROR '+(e.code||'')+' '+String(e.message).split('\n')[0].slice(0,140);}console.log(label.padEnd(34),'|',JSON.stringify(text).slice(0,90),'=>',out.slice(0,300));}
module.exports={o,P,show};

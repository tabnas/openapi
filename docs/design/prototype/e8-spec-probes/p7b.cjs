const {o,show}=require('./h.cjs');
function tryit(label,f){const t0=Date.now();try{const r=f();console.log(label,'OK',Date.now()-t0+'ms',typeof r==='string'?r:'')}catch(e){console.log(label,'ERR',e.code||e.name,String(e.message).slice(0,100),Date.now()-t0+'ms')}}
for(const d of [100,500,1000,5000,20000]){
  const json='{"openapi":"3.1.0","x":'+'{"a":'.repeat(d)+'1'+'}'.repeat(d)+'}';
  tryit(`json fast depth ${d}`,()=>{const r=o.parse(json);return 'resolve:'+(()=>{try{o.resolve(r);return 'ok'}catch(e){return 'ERR '+(e.code||e.name)+' '+e.message.slice(0,60)}})()});
  tryit(`json grammar depth ${d}`,()=>{o.parse(json,{fast:false})});
  const yflow='openapi: 3.1.0\nx: '+'['.repeat(d)+'1'+']'.repeat(d);
  tryit(`yaml flow depth ${d}`,()=>{o.parse(yflow)});
  let yb='openapi: 3.1.0\n'; for(let i=0;i<Math.min(d,2000);i++) yb+=' '.repeat(i)+'k'+i+':\n'; 
  tryit(`yaml block depth ${Math.min(d,2000)}`,()=>{o.parse(yb)});
}
// schema depth in components with resolve
const d=3000; const sch='{"openapi":"3.1.0","components":{"schemas":{"A":'+'{"properties":{"p":'.repeat(d)+'{"$ref":"#/components/schemas/A"}'+'}}'.repeat(d)+'}}}';
tryit('resolve deep schema 3000',()=>{const r=o.parse(sch);const x=o.resolve(r);return 'cuts '+x.cuts.length});
tryit('resolve deep schema maxDepth 100',()=>{const r=o.parse(sch);const x=o.resolve(r,{maxDepth:100});return 'cuts '+x.cuts.length});
// long ref chain
let comps={}; const N=5000; for(let i=0;i<N;i++) comps['S'+i]={$ref:'#/components/schemas/S'+(i+1)}; comps['S'+N]={type:'string'};
tryit('ref chain 5000',()=>{const x=o.resolve({openapi:'3.1.0',components:{schemas:comps}});return 'unres '+x.unresolved.length+' S0='+show(x.tree.components.schemas.S0)});

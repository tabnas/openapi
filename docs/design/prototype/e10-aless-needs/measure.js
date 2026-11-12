const path=process.env.OPENAPI_TS || require('node:path').join(__dirname, '..', '..', '..', '..', 'ts') + '/'
const {parse,resolve,make}=require(path+'dist/openapi.js')
const {recordPositions}=require(path+'node_modules/@tabnas/expr')
const fs=require('fs')
const [file,mode]=process.argv.slice(2)
const text=fs.readFileSync(file,'utf8')
const mb=()=>{global.gc();return (process.memoryUsage().heapUsed/1048576).toFixed(0)+'MB heap'}
const t=()=>Number(process.hrtime.bigint()/1000000n)
console.log('start',mode,(text.length/1048576).toFixed(1)+'MB text',mb())
let t0=t(), raw, pos, tn
if(mode==='positions'){tn=make();pos=recordPositions(tn);raw=parse(text,{instance:tn,fast:false})}
else if(mode==='grammar'){raw=parse(text,{fast:false})}
else raw=parse(text)
console.log('parse ms',t()-t0,mb())
t0=t()
const out=resolve(raw,pos?{positions:pos}:{})
console.log('resolve ms',t()-t0,mb())
const P=out.provenance
console.log('sites',P.length,'unresolved',out.unresolved.length,'cuts',out.cuts.length,'connections',out.connections.length,'dataSlots',out.dataSlots)
const st={};for(const p of P)st[p.status]=(st[p.status]||0)+1;console.log('status',st)
const kd={};for(const p of P)kd[p.kind+'/'+p.type]=(kd[p.kind+'/'+p.type]||0)+1;console.log('kinds',kd)
const fan=new Map();for(const p of P)if(p.target)fan.set(p.target,(fan.get(p.target)||0)+1)
const top=[...fan].sort((a,b)=>b[1]-a[1]).slice(0,5);console.log('distinct targets',fan.size,'top fan-in',JSON.stringify(top))
if(pos){let w=0;for(const p of P)if(p.row)w++;console.log('sites with row',w)}
const ck={};for(const c of out.connections)ck[c.kind]=(ck[c.kind]||0)+1;console.log('connection kinds',ck)
// raw walk: count $ref maps, cost of a raw index
t0=t();let refs=0,nodes=0;const st2=[raw];while(st2.length){const n=st2.pop();nodes++;if(n&&typeof n==='object'){if(!Array.isArray(n)&&'$ref' in n)refs++;for(const k of Object.keys(n))st2.push(n[k])}}
console.log('raw walk ms',t()-t0,'raw values',nodes,'raw $ref maps',refs)
// expansion size: how big does a full unfold of resolved tree get (written out), capped
t0=t();let written=0;const cap=5e7;const st3=[[out.tree,0]]
while(st3.length&&written<cap){const [n]=st3.pop();written++;if(n&&typeof n==='object'){for(const k of Object.keys(n))st3.push([n[k]])}}
console.log('written-out values of resolved tree (cap 5e7)',written,written>=cap?'CAPPED':'', 'ms',t()-t0)

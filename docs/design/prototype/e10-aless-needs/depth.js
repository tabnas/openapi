const path=process.env.OPENAPI_TS || require('node:path').join(__dirname, '..', '..', '..', '..', 'ts') + '/'
const {parse,resolve}=require(path+'dist/openapi.js')
const raw=parse(require('fs').readFileSync(process.argv[2],'utf8'))
const out=resolve(raw)
// raw max depth
let rawMax=0;{const st=[[raw,0]];while(st.length){const [n,d]=st.pop();if(d>rawMax)rawMax=d;if(n&&typeof n==='object')for(const k of Object.keys(n))st.push([n[k],d+1])}}
// written-out resolved max depth and max refs along a path (count site crossings by identity of shared targets: use provenance targets set)
let maxD=0,count=0;const st=[[out.tree,0]];while(st.length){const [n,d]=st.pop();count++;if(d>maxD)maxD=d;if(n&&typeof n==='object')for(const k of Object.keys(n))st.push([n[k],d+1])}
console.log('raw max depth',rawMax,'resolved written-out max depth',maxD,'values',count)
// reference hops: from each site, follow target chain: count nested sites inside the target subtree recursively = longest chain of nested refs
const P=out.provenance;const byAt=new Map(P.map(p=>[p.at,p]))
const sitesUnder=new Map();for(const p of P){ /* group sites by component root */ }
const targets=[...new Set(P.map(p=>p.target).filter(Boolean))]
const inside=t=>P.filter(p=>p.at===t||p.at.startsWith(t+'/'))
const memo=new Map()
function hops(t,stack){if(memo.has(t))return memo.get(t);if(stack.has(t))return 0;stack.add(t);let m=0;for(const s of inside(t)) if(s.target) m=Math.max(m,1+hops(s.target,stack));stack.delete(t);memo.set(t,m);return m}
let best=0;for(const t of targets)best=Math.max(best,hops(t,new Set()));console.log('longest chain of nested references',best)

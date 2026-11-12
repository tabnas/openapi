const path=process.env.OPENAPI_TS || require('node:path').join(__dirname, '..', '..', '..', '..', 'ts') + '/'
const {parse,resolve,make}=require(path+'dist/openapi.js')
const {recordPositions}=require(path+'node_modules/@tabnas/expr')
const fs=require('fs')
const text=fs.readFileSync((process.env.ALESS_DIR || '../aless') + '/examples/bookshelf-openapi.yaml','utf8')
const tn=make(); const pos=recordPositions(tn)
const raw=parse(text,{instance:tn})
const out=resolve(raw,{positions:pos})
console.log('version',out.version,'sites',out.provenance.length,'unresolved',out.unresolved.length,'cuts',out.cuts.length,'conns',out.connections.length)
for (const p of out.provenance.slice(0,6)) console.log(JSON.stringify(p))
const kinds={};for(const p of out.provenance){kinds[p.kind+'/'+p.type]=(kinds[p.kind+'/'+p.type]||0)+1};console.log(kinds)
const byT={};for(const p of out.provenance){byT[p.target]=(byT[p.target]||0)+1};console.log(byT)
for (const c of out.connections) console.log(JSON.stringify(c))
// sharing: identity
console.log('shared identity:', out.tree.paths['/api/shelf/{shelf_id}'].get.responses['200'].content['application/json'].schema === out.tree.components.schemas.Shelf)
// what does a site look like for Shelf allOf
console.log(JSON.stringify(out.tree.components.schemas.Shelf).slice(0,300))
// sortOrder with description + allOf: 3.0 sibling
console.log(JSON.stringify(out.tree.components.schemas.Shelf.allOf[1].properties.sortOrder))
// positions: does every container get one?
let withPos=0,total=0;(function w(n){if(n&&typeof n==='object'){total++; if(pos(n))withPos++; for(const k of Object.keys(n)) w(n[k])}})(raw)
console.log('containers',total,'with positions',withPos)
const t=pos(raw.paths['/api/shelf']); console.log('pos of /api/shelf map', t&&{r:t.rI,c:t.cI,src:t.src,name:t.name})
const t2=pos(raw.servers); console.log('pos of servers list', t2&&{r:t2.rI,c:t2.cI,src:t2.src})
// cycle test
const cyc=parse('{"openapi":"3.0.0","components":{"schemas":{"Node":{"type":"object","properties":{"next":{"$ref":"#/components/schemas/Node"},"kids":{"type":"array","items":{"$ref":"#/components/schemas/Node"}}}}}},"paths":{"/a":{"get":{"responses":{"200":{"description":"x","content":{"application/json":{"schema":{"$ref":"#/components/schemas/Node"}}}}}}}}}')
const co=resolve(cyc); console.log('cycle prov',JSON.stringify(co.provenance)); console.log('cuts',JSON.stringify(co.cuts))
// ext ref + sibling 3.1
const e=resolve(parse('{"openapi":"3.1.0","components":{"schemas":{"A":{"$ref":"./pet.yaml#/Pet","description":"d"},"B":{"$ref":"#/components/schemas/C","description":"over"},"C":{"type":"string"}}}}'))
console.log(JSON.stringify(e.provenance)); console.log(JSON.stringify(e.unresolved)); console.log(JSON.stringify(e.tree.components.schemas))

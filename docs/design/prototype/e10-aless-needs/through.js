const path=process.env.OPENAPI_TS || require('node:path').join(__dirname, '..', '..', '..', '..', 'ts') + '/'
const {parse,resolve}=require(path+'dist/openapi.js')
const raw=parse(JSON.stringify({openapi:'3.0.3',paths:{},components:{schemas:{
 A:{$ref:'#/components/schemas/B'}, B:{$ref:'#/components/schemas/C'}, C:{type:'object',properties:{x:{type:'string'}}},
 T:{$ref:'#/components/schemas/A/properties/x'},
 L1:{$ref:'#/components/schemas/L2'}, L2:{$ref:'#/components/schemas/L1'},
 Bad:{$ref:'#/components/schemas/Nope'}, Arr:{$ref:'#/components/schemas/C/required'},
}}}))
const out=resolve(raw)
for(const p of out.provenance) console.log(JSON.stringify(p))
console.log('unresolved',JSON.stringify(out.unresolved)); console.log('cuts',JSON.stringify(out.cuts))
console.log('raw C identical in tree?', out.tree.components.schemas.C===raw.components.schemas.C)
console.log('tree.A===tree.C', out.tree.components.schemas.A===out.tree.components.schemas.C)
console.log('T value', JSON.stringify(out.tree.components.schemas.T))
// raw tree mutated?
console.log('raw A still ref', JSON.stringify(raw.components.schemas.A))
// connections incl. discriminator mapping, security, operationId link
const r2=resolve(parse(JSON.stringify({openapi:'3.0.3',
 security:[{key:[]}],
 paths:{'/p':{get:{operationId:'getP',responses:{'200':{description:'ok',links:{L:{operationId:'getP'}}}}}}},
 components:{securitySchemes:{key:{type:'apiKey',name:'k',in:'header'}},schemas:{Pet:{oneOf:[{$ref:'#/components/schemas/Cat'}],discriminator:{propertyName:'t',mapping:{cat:'Cat',dog:'#/components/schemas/Dog'}}},Cat:{type:'object'}}}})))
for(const c of r2.connections) console.log(JSON.stringify(c))

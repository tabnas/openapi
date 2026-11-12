const {o,show}=require('./h.cjs');
function R(label,doc,opts={}){let x;try{x=o.resolve(typeof doc==='string'?o.parse(doc):doc,opts)}catch(e){console.log(label.padEnd(30),'THROWS',e.code||e.name,String(e.message).slice(0,150));return}
 const s=x.tree.components&&x.tree.components.schemas; console.log(label.padEnd(30),'unres=',show(x.unresolved).slice(0,300)); return x}
let x;
x=R('dynamicRef', {openapi:'3.1.0',components:{schemas:{
  list:{$id:'https://e.com/list',$dynamicAnchor:'T',type:'array',items:{$dynamicRef:'#T'}},
  strs:{$id:'https://e.com/strs',$ref:'list',$defs:{s:{$dynamicAnchor:'T',type:'string'}}}}}});
if(x){console.log('  list.items=',show(x.tree.components.schemas.list.items),' conns=',show(x.connections))}
x=R('$id absolute ref',{openapi:'3.1.0',components:{schemas:{A:{$id:'https://e.com/a',type:'string'},B:{$ref:'https://e.com/a'}}}}); if(x)console.log('  B=',show(x.tree.components.schemas.B));
x=R('$id relative sibling',{openapi:'3.1.0',components:{schemas:{A:{$id:'https://e.com/s/a.json',type:'string'},B:{$id:'https://e.com/s/b.json',$ref:'a.json'}}}}); if(x)console.log('  B=',show(x.tree.components.schemas.B));
x=R('$id then #/components',{openapi:'3.1.0',components:{schemas:{A:{type:'string'},B:{$id:'https://e.com/b',properties:{p:{$ref:'#/components/schemas/A'}}}}}}); if(x)console.log('  B.p=',show(x.tree.components.schemas.B.properties.p));
x=R('$id relative no base',{openapi:'3.1.0',components:{schemas:{A:{$id:'a.json',type:'string'},B:{$ref:'a.json'}}}}); if(x)console.log('  B=',show(x.tree.components.schemas.B));
x=R('$anchor',{openapi:'3.1.0',components:{schemas:{A:{$anchor:'foo',type:'string'},B:{$ref:'#foo'}}}}); if(x)console.log('  B=',show(x.tree.components.schemas.B));
R('$anchor in 3.0 (none)',{openapi:'3.0.3',components:{schemas:{A:{$anchor:'foo',type:'string'},B:{$ref:'#foo'}}}});
x=R('draft-07 $schema',{openapi:'3.1.0',components:{schemas:{A:{type:'string'},B:{$schema:'http://json-schema.org/draft-07/schema#',$ref:'#/components/schemas/A'}}}}); if(x)console.log('  B=',show(x.tree.components.schemas.B));
R('2020-12 with trailing #',{openapi:'3.1.0',components:{schemas:{A:{type:'string'},B:{$schema:'https://json-schema.org/draft/2020-12/schema#',$ref:'#/components/schemas/A'}}}});
R('2019-09 dialect',{openapi:'3.1.0',components:{schemas:{A:{type:'string'},B:{$schema:'https://json-schema.org/draft/2019-09/schema',$ref:'#/components/schemas/A'}}}});
R('custom jsonSchemaDialect',{openapi:'3.1.0',jsonSchemaDialect:'https://example.com/my-dialect',components:{schemas:{A:{type:'string'},B:{$ref:'#/components/schemas/A'}}},paths:{'/a':{get:{responses:{'200':{description:'x',content:{'a/b':{schema:{$ref:'#/components/schemas/A'}}}}}}}}});
R('oas dialect w/o /base',{openapi:'3.1.0',jsonSchemaDialect:'https://spec.openapis.org/oas/3.1/dialect/2024-11-10',components:{schemas:{A:{type:'string'},B:{$ref:'#/components/schemas/A'}}}});
R('same-doc via retrievalUri',{openapi:'3.1.0',components:{schemas:{A:{type:'string'},B:{$ref:'https://e.com/api.yaml#/components/schemas/A'}}}},{retrievalUri:'https://e.com/api.yaml'});
R('same-doc via own file name',{openapi:'3.1.0',components:{schemas:{A:{type:'string'},B:{$ref:'api.yaml#/components/schemas/A'}}}},{retrievalUri:'https://e.com/v1/api.yaml'});
R('$self 3.2',{openapi:'3.2.0',$self:'https://e.com/root.yaml',components:{schemas:{A:{type:'string'},B:{$ref:'root.yaml#/components/schemas/A'}}}});
R('$self ignored in 3.1',{openapi:'3.1.0',$self:'https://e.com/root.yaml',components:{schemas:{A:{type:'string'},B:{$ref:'root.yaml#/components/schemas/A'}}}});
R('external file',{openapi:'3.1.0',components:{schemas:{B:{$ref:'./pet.yaml'}}}});
x=R('2.0 refs',{swagger:'2.0',definitions:{A:{type:'string'},B:{$ref:'#/definitions/A',description:'ignored'}},parameters:{p:{name:'p',in:'query',type:'string'}},responses:{r:{description:'d'}},paths:{'/a':{parameters:[{$ref:'#/parameters/p'}],get:{responses:{'200':{$ref:'#/responses/r'}}}}}}); if(x)console.log('  B=',show(x.tree.definitions.B),' p=',show(x.tree.paths['/a'].parameters[0]));
R('2.0 shorthand Pet',{swagger:'2.0',definitions:{Pet:{type:'string'},B:{$ref:'Pet'}}});
R('2.0 schema id (draft-04)',{swagger:'2.0',definitions:{A:{id:'http://e.com/a',type:'string'},B:{$ref:'http://e.com/a'}}});
x=R('3.0 schema w/ $ref sibling',{openapi:'3.0.3',components:{schemas:{A:{type:'string'},B:{$ref:'#/components/schemas/A',nullable:true}}}}); if(x)console.log('  B=',show(x.tree.components.schemas.B));
x=R('3.1 schema $ref+sibling',{openapi:'3.1.0',components:{schemas:{A:{type:'string'},B:{$ref:'#/components/schemas/A',description:'d',maxLength:3}}}}); if(x)console.log('  B=',show(x.tree.components.schemas.B));
x=R('ref to non-object',{openapi:'3.1.0',components:{schemas:{A:{type:'string',enum:['a']},B:{$ref:'#/components/schemas/A/enum'}}}}); if(x)console.log('  B=',show(x.tree.components.schemas.B));
x=R('path item $ref (local)',{openapi:'3.1.0',paths:{'/a':{$ref:'#/components/pathItems/P',summary:'s'}},components:{pathItems:{P:{get:{responses:{}}}}}}); if(x)console.log('  /a=',show(x.tree.paths['/a']));
x=R('path item $ref in 3.0 to paths',{openapi:'3.0.3',paths:{'/a':{get:{responses:{}}},'/b':{$ref:'#/paths/~1a'}}}); if(x)console.log('  /b=',show(x.tree.paths['/b']));
x=R('webhook $ref',{openapi:'3.1.0',webhooks:{w:{$ref:'#/components/pathItems/P'}},components:{pathItems:{P:{post:{responses:{}}}}}}); if(x)console.log('  w=',show(x.tree.webhooks.w), show(x.provenance));
R('callback $ref',{openapi:'3.1.0',paths:{'/a':{post:{responses:{},callbacks:{cb:{$ref:'#/components/callbacks/C'}}}}},components:{callbacks:{C:{'{$request.body#/url}':{post:{responses:{}}}}}}});
x=R('securityScheme $ref',{openapi:'3.1.0',components:{securitySchemes:{a:{type:'http',scheme:'basic'},b:{$ref:'#/components/securitySchemes/a'}}},security:[{b:[]}]}); if(x)console.log('  conns=',show(x.connections));
x=R('header in encoding $ref',{openapi:'3.1.0',components:{headers:{H:{schema:{type:'string'}}},requestBodies:{R:{content:{'multipart/form-data':{encoding:{f:{headers:{X:{$ref:'#/components/headers/H'}}}}}}}}}}); if(x)console.log('  X=',show(x.tree.components.requestBodies.R.content['multipart/form-data'].encoding.f.headers.X));
x=R('3.2 mediaTypes $ref',{openapi:'3.2.0',components:{mediaTypes:{M:{schema:{type:'string'}}},responses:{R:{description:'d',content:{'a/b':{$ref:'#/components/mediaTypes/M'}}}}}}); if(x)console.log('  R=',show(x.tree.components.responses.R));
x=R('3.2 itemSchema $ref',{openapi:'3.2.0',components:{schemas:{A:{type:'string'}},responses:{R:{description:'d',content:{'application/jsonl':{itemSchema:{$ref:'#/components/schemas/A'}}}}}}}); if(x)console.log('  R=',show(x.tree.components.responses.R));
R('ref in x- ext (data)',{openapi:'3.1.0','x-foo':{$ref:'#/info'},info:{title:'t'}});
x=R('ref in example (data)',{openapi:'3.1.0',components:{schemas:{A:{type:'object',example:{$ref:'#/info'}}}}}); if(x)console.log('  dataSlots=',x.dataSlots);
x=R('ref in definitions (3.1)',{openapi:'3.1.0',components:{schemas:{A:{type:'string'},B:{definitions:{x:{$ref:'#/components/schemas/A'}},$ref:'#/components/schemas/B/definitions/x'}}}}); if(x)console.log('  B=',show(x.tree.components.schemas.B));
x=R('ref in dependencies (3.1)',{openapi:'3.1.0',components:{schemas:{A:{type:'string'},B:{dependencies:{p:{$ref:'#/components/schemas/A'}}}}}}); if(x)console.log('  B=',show(x.tree.components.schemas.B),'dataSlots',x.dataSlots);
x=R('3.0 comp name w/ space',{openapi:'3.0.3',components:{schemas:{A:{type:'string'},'B C':{properties:{p:{$ref:'#/components/schemas/A'}}}}}}); if(x)console.log('  B C=',show(x.tree.components.schemas['B C']),'dataSlots',x.dataSlots);
x=R('ref through ref (pointer thru site)',{openapi:'3.1.0',components:{schemas:{A:{properties:{p:{type:'string'}}},B:{$ref:'#/components/schemas/A'},C:{$ref:'#/components/schemas/B/properties/p'}}}}); if(x)console.log('  C=',show(x.tree.components.schemas.C));
x=R('unknown version 3.3.0',{openapi:'3.3.0',components:{schemas:{A:{type:'string'},B:{$ref:'#/components/schemas/A'}}}}); if(x)console.log('  version=',x.version);
x=R('version 3.0 as number 3',{openapi:3,components:{schemas:{A:{type:'string'},B:{$ref:'#/components/schemas/A',description:'x'}}}}); if(x)console.log('  version=',x.version, show(x.tree.components.schemas.B));
R('urn retrieval',{openapi:'3.1.0',components:{schemas:{A:{type:'string'},B:{$ref:'#/components/schemas/A'}}}},{retrievalUri:'file:///tmp/a.yaml'});
R('relative retrievalUri',{openapi:'3.1.0',components:{schemas:{A:{type:'string'},B:{$ref:'a.yaml#/components/schemas/A'}}}},{retrievalUri:'a.yaml'});
R('windows path retrieval',{openapi:'3.1.0',components:{schemas:{A:{type:'string'},B:{$ref:'#/components/schemas/A'}}}},{retrievalUri:'C:\\specs\\a.yaml'});
R('$ref with query',{openapi:'3.1.0',components:{schemas:{A:{type:'string'},B:{$ref:'?x=1#/components/schemas/A'}}}},{retrievalUri:'https://e.com/a'});

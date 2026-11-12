const {o}=require('./h.cjs');
let y='openapi: 3.1.0\ninfo:\n  title: t\n  version: "1"\npaths:\n';
for(let i=0;i<4000;i++){ y+=`  /r${i}/{id}:\n    get:\n      operationId: op${i}\n      parameters:\n        - name: id\n          in: path\n          required: true\n          schema: {type: string}\n      responses:\n        '200':\n          description: ok\n          content:\n            application/json:\n              schema:\n                $ref: '#/components/schemas/S${i%50}'\n`; }
y+='components:\n  schemas:\n'; for(let i=0;i<50;i++) y+=`    S${i}:\n      type: object\n      properties:\n        a: {type: string}\n        next: {$ref: '#/components/schemas/S${(i+1)%50}'}\n`;
console.log('yaml bytes',y.length);
let t=Date.now(); const r=o.parse(y); console.log('yaml parse ms',Date.now()-t);
const j=JSON.stringify(r); console.log('json bytes',j.length);
t=Date.now(); o.parse(j); console.log('json fast ms',Date.now()-t);
t=Date.now(); o.parse(j,{fast:false}); console.log('json grammar ms',Date.now()-t);
t=Date.now(); const x=o.resolve(r); console.log('resolve ms',Date.now()-t,'sites',x.provenance.length,'cuts',x.cuts.length);

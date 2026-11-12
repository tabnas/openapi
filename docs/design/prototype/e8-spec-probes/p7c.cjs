const {o,show}=require('./h.cjs');
const doc=`openapi: 3.1.0
info: {title: t, version: '1'}
paths:
  /a~b/{c}:
    get:
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/__proto__'
  /x:
    get:
      responses:
        '200':
          $ref: '#/components/responses/constructor'
        '201':
          $ref: '#/components/responses/toString'
        '202':
          $ref: '#/components/responses/'
        '203':
          $ref: '#/components/responses/a~1b~0c'
        '204':
          $ref: '#/paths/~1a~0b~1%7Bc%7D/get/responses/200'
components:
  schemas:
    __proto__: {type: string}
    constructor: {type: integer}
  responses:
    constructor: {description: c}
    toString: {description: ts}
    '': {description: empty-key}
    a/b~c: {description: slashy}
`;
const r=o.parse(doc);
console.log('raw proto key own:',Object.prototype.hasOwnProperty.call(r.components.schemas,'__proto__'));
const x=o.resolve(r);
console.log('unresolved',show(x.unresolved));
const g=x.tree.paths['/x'].get.responses;
console.log('constructor',show(g['200']),'toString',show(g['201']),'empty',show(g['202']),'slashy',show(g['203']),'pathref',show(g['204']));
console.log('proto schema',show(x.tree.paths['/a~b/{c}'].get.responses['200'].content['application/json'].schema));
console.log('fast path proto',show(o.parse('{"openapi":"3.1.0","__proto__":{"x":1}}')), Object.getPrototypeOf(o.parse('{"openapi":"3.1.0","__proto__":{"x":1}}')));
// lone surrogates
const ls=o.parse('{"openapi":"3.1.0","a":"\\ud800"}'); console.log('lone surrogate fast', ls.a.length, ls.a.charCodeAt(0).toString(16));
const ls2=o.parse('openapi: 3.1.0\na: "\\ud800x"'); console.log('lone surrogate yaml', ls2.a.length, ls2.a.charCodeAt(0).toString(16));
// pointer edge cases
const p=o.parse(`openapi: 3.1.0
components:
  schemas:
    L: {type: array, items: [{type: string}], prefixItems: [{type: integer},{type: boolean}]}
    A: {$ref: '#/components/schemas/L/prefixItems/1'}
    B: {$ref: '#/components/schemas/L/prefixItems/01'}
    C: {$ref: '#/components/schemas/L/prefixItems/-'}
    D: {$ref: '#/components/schemas/L/prefixItems/5'}
    E: {$ref: '#'}
    F: {$ref: '#/components/schemas/L/type'}
    G: {$ref: '#/components/schemas/L/'}
    H: {$ref: '#%2Fcomponents%2Fschemas%2FL'}
    I: {$ref: '#/components/schemas/M%20N'}
    'M N': {type: number}
    J: {$ref: '#/components/schemas/M N'}
    K: {$ref: '#/components/schemas/L~2'}
    P: {$ref: '#/components/schemas/%E2%82%AC'}
    '€': {type: number}
    Q: {$ref: '#/components/schemas/€'}
    R: {$ref: '#/components/schemas/L#'}
`);
const y=o.resolve(p);
for(const k of 'ABCDEFGHIJKPQR') console.log(k, show(y.tree.components.schemas[k]).slice(0,80));
console.log(show(y.unresolved));

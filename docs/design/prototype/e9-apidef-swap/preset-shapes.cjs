// The shapes where apidef's own reading of a pointer and the preset
// (`resolve(raw, { compat: 'apidef' })`) part today, or would part under a
// pointer rule that reads the document as written first.
//
// usage: node preset-shapes.cjs <dir>
// where <dir>/lib/parse.js is apidef's built parse stage (ts/dist/parse.js,
// with its yamlalias.js, utility.js and parse/graphql.js beside it, and
// apidef's dependencies installed). `cycles: 'cut'` is given beside the
// preset only so that the result can be printed.
const ap = require(process.argv[2] + '/lib/parse.js')
const oa = require(process.env.OPENAPI_DIST || require('node:path').join(__dirname, '..', '..', '..', '..', 'ts', 'dist', 'openapi.js'))
const J = JSON.stringify
const cases = {
  'P1 a schema that references its own member': { openapi: '3.0.3', info: { title: 't', version: '1' }, paths: {}, components: { schemas: {
    A: { $ref: '#/components/schemas/A/properties/p', properties: { p: { type: 'string' } } } } } },
  'P2 a member of a reference whose own target is missing': { openapi: '3.0.3', info: { title: 't', version: '1' }, paths: {}, components: { schemas: {
    B: { $ref: '#/components/schemas/Missing', properties: { x: { type: 'integer' } } },
    C: { $ref: '#/components/schemas/B/properties/x' } } } },
  'P3 a member of a reference into another document': { openapi: '3.0.3', info: { title: 't', version: '1' }, paths: {}, components: { schemas: {
    B: { $ref: './other.yaml#/B', properties: { x: { type: 'integer' } } },
    C: { $ref: '#/components/schemas/B/properties/x' } } } },
  'P4 a bundled schema that references its own $defs': { openapi: '3.1.0', info: { title: 't', version: '1' }, paths: {}, components: { schemas: {
    B: { $ref: '#/components/schemas/B/$defs/x', $defs: { x: { type: 'string' } } },
    C: { $ref: '#/components/schemas/B' } } } },
}
;(async () => {
  for (const [name, doc] of Object.entries(cases)) {
    const src = J(doc)
    const a = (await ap.parse('OpenAPI', src, { file: 'x.json' })).components.schemas
    const b = oa.resolve(oa.parse(src), { compat: 'apidef', cycles: 'cut' }).tree.components.schemas
    const pick = (s) => J(Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v && v.$ref ? 'as written' : v])))
    console.log(name + '\n   apidef: ' + pick(a) + '\n   preset: ' + pick(b))
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1) })

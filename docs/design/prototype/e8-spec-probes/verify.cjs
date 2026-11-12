const { parse, resolve } = require(process.env.OPENAPI_DIST || require('node:path').join(__dirname, '..', '..', '..', '..', 'ts', 'dist', 'openapi.js'))
const J = (v) => JSON.stringify(v)
const run = (label, doc, pick, opts) => {
  try {
    const r = resolve(JSON.parse(JSON.stringify(doc)), opts || {})
    console.log(label + ':', J(pick(r.tree)), '| unresolved', J(r.unresolved.map(u => u.why)), '| cuts', r.cuts.length,
      '| status', J(r.provenance.map(p => p.status)))
  } catch (e) { console.log(label + ': THROWS', e.code || e.name, String(e.message).slice(0, 80)) }
}
// W2: $ref to own $defs
run('W2 self-$defs', { openapi: '3.1.0', components: { schemas: {
  B: { $ref: '#/components/schemas/B/$defs/x', $defs: { x: { type: 'string' } } },
  C: { $ref: '#/components/schemas/B' } } } }, t => [t.components.schemas.B, t.components.schemas.C])
// W1: pointer through a site, 3.0
run('W1 through-site', { openapi: '3.0.3', components: { schemas: {
  A: { properties: { x: { type: 'string' } } },
  B: { $ref: '#/components/schemas/A', properties: { x: { type: 'integer' } } },
  C: { $ref: '#/components/schemas/B/properties/x' } } } }, t => t.components.schemas.C)
// W3: target outside typed positions
run('W3 context', { openapi: '3.0.3', paths: { '/a': { get: { responses: { '404': { $ref: '#/x-common/NotFound' } } } } },
  'x-common': { NotFound: { description: 'nf', content: { 'application/json': { schema: { $ref: '#/components/schemas/E' } } } } },
  components: { schemas: { E: { type: 'object' } } } }, t => t.paths['/a'].get.responses['404'])
// W4: draft-07 dialect
run('W4 draft-07', { openapi: '3.1.0', components: { schemas: { A: { type: 'string' },
  B: { $schema: 'http://json-schema.org/draft-07/schema#', $ref: '#/components/schemas/A' } } } }, t => t.components.schemas.B)
// duplicates
console.log('dup openapi:', J(parse('paths:\n  /a:\n    get: {}\n  /a:\n    put: {}\nopenapi: 3.0.0\n').paths))
// YAML 1.1 scalars and big ints
console.log('scalars:', J(parse('openapi: 3.1.0\nenum: [NO, SE, On]\nmax: 9223372036854775807\n')))
// trailing empty document
try { console.log('trailing doc:', J(parse('openapi: 3.1.0\n---\n'))) } catch (e) { console.log('trailing doc: ERROR', e.code) }

// E0: one engine instance for both OpenAPI serialisations? The yaml plugin
// (on jsonic) reads JSON text too, since JSON is YAML 1.2 flow syntax. The
// strict json plugin rejects YAML-only syntax. Compare what each grammar
// gives on the same documents.
const { Tabnas } = require('@tabnas/parser')
const { jsonic } = require('@tabnas/jsonic')
const { Yaml } = require('@tabnas/yaml')
const { json } = require('@tabnas/json')
const y = new Tabnas().use(jsonic).use(Yaml)
const j = new Tabnas().use(json)
console.log('start rule: yaml =', y.options.rule.start, '| json =', j.options.rule.start)

const doc = { openapi: '3.2.0', paths: { '/a': { get: { responses: { '200': { description: 'x: y # z',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/A' } } } } } } } },
  components: { schemas: { A: { type: 'string', enum: ['yes', 'no', 'null', '1e3', '2026-01-01', '', ' a '],
  pattern: '^[a-z]{2}:.*$', maximum: 1e400, minimum: -0, 'x-big': 12345678901234567890 } } } }
const want = JSON.stringify(JSON.parse(JSON.stringify(doc)))
const read = (tn, src) => { try { return JSON.stringify(tn.parse(src)) } catch (e) { return 'ERROR ' + e.code } }
for (const [name, src] of Object.entries({ compact: JSON.stringify(doc), 'two-space': JSON.stringify(doc, null, 2), tabs: JSON.stringify(doc, null, '\t') })) {
  const yv = read(y, src), jv = read(j, src)
  console.log(`${name.padEnd(10)} yaml-grammar: ${yv === want ? 'same as JSON.parse' : 'DIFFERS ' + yv.slice(0, 200)} | json-grammar: ${jv === want ? 'same as JSON.parse' : 'DIFFERS ' + jv.slice(0, 200)}`)
}
console.log('\nYAML-only or non-JSON text, which a strict JSON grammar must reject:')
for (const src of ['{openapi: 3.2.0, paths: {}}', '{"a": 1,}', '{"a": "b", "a": "c"}', 'openapi: 3.2.0\n', '{"a":\t1}', '{"a": "line1\\nline2"}', '[1, 2]\n---\n[3]\n']) {
  console.log(`${JSON.stringify(src).padEnd(34)} yaml-grammar: ${read(y, src).padEnd(36)} json-grammar: ${read(j, src)}`)
}

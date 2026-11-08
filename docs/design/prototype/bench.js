// Measurements the second review asked for: parse cost on a large real
// description, the resolver on it, and the serialised size of a shared
// (diamond) structure.
const fs = require('fs')
const { Tabnas } = require('@tabnas/parser')
const { jsonic } = require('@tabnas/jsonic')
const { Yaml } = require('@tabnas/yaml')
const { json } = require('@tabnas/json')
const { resolve } = require('./e3-ref-op.js')
const file = process.argv[2]
const src = fs.readFileSync(file, 'utf8')
const mib = (n) => (n / 1024 / 1024).toFixed(1) + ' MiB'
console.log(`document: ${file}, ${mib(src.length)} of JSON text`)
const time = (label, fn) => { const t0 = Date.now(); const out = fn(); console.log(`  ${label.padEnd(22)} ${String(Date.now() - t0).padStart(6)} ms`); return out }
const viaJSON = time('JSON.parse', () => JSON.parse(src))
const viaJson = time('strict json grammar', () => new Tabnas().use(json).parse(src))
const viaYaml = time('jsonic+yaml grammar', () => new Tabnas().use(jsonic).use(Yaml).parse(src))
console.log('  all three equal as JSON text:', JSON.stringify(viaJSON) === JSON.stringify(viaJson) && JSON.stringify(viaJson) === JSON.stringify(viaYaml))
const countRefs = (n) => n && 'object' === typeof n ? (Array.isArray(n) ? n.reduce((a, v) => a + countRefs(v), 0) : ('string' === typeof n.$ref ? 1 : 0) + Object.values(n).reduce((a, v) => a + countRefs(v), 0)) : 0
console.log(`  openapi ${viaJSON.openapi}, ${Object.keys(viaJSON.paths || {}).length} paths, ${Object.keys((viaJSON.components || {}).schemas || {}).length} schemas, ${countRefs(viaJSON)} $ref maps`)
for (const cycle of ['cut', 'keep']) {
  const out = time(`resolve (cycle: ${cycle})`, () => resolve(viaYaml, { cycle }))
  console.log(`    version ${out.version}; ${out.provenance.length} sites resolved, ${out.unresolved.length} unresolved, ${out.cuts.length} cycle cuts`)
  const t1 = Date.now()
  try { const s = JSON.stringify(out.tree); console.log(`    JSON.stringify(resolved): ${mib(s.length)} in ${Date.now() - t1} ms (raw was ${mib(src.length)})`) }
  catch (e) { console.log(`    JSON.stringify(resolved) FAILED after ${Date.now() - t1} ms: ${e.message.split('\n')[0]}`) }
}
// Diamond sharing: a chain of N schemas, each referring to the next twice.
// In memory the resolved tree is a DAG of N+1 objects; as JSON it is 2^N.
for (const depth of [8, 12, 16]) {
  const doc = { openapi: '3.1.0', components: { schemas: {} } }
  for (let i = 0; i < depth; i++) doc.components.schemas['S' + i] = { type: 'object', properties: { a: { $ref: `#/components/schemas/S${i + 1}` }, b: { $ref: `#/components/schemas/S${i + 1}` } } }
  doc.components.schemas['S' + depth] = { type: 'string' }
  const out = resolve(doc)
  const t0 = Date.now(); const s = JSON.stringify(out.tree)
  console.log(`  diamond depth ${String(depth).padStart(2)}: ${2 * depth} $ref sites, raw ${JSON.stringify(doc).length} B -> resolved JSON ${mib(s.length)} in ${Date.now() - t0} ms (DAG in memory: ${out.provenance.length} sites, ${depth + 1} schema objects)`)
}

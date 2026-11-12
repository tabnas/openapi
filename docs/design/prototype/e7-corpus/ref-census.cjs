// Every $ref value in every document (descriptions and fragments), by text
// pattern, whatever the object model makes of its position: the forms of
// references to other documents, and what the targets are.
// usage: node ref-census.cjs <manifest.jsonl>
const Fs = require('node:fs'), Path = require('node:path')
const W = require('./worker.cjs')
const YAML = W.YAML
const M = Fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map(JSON.parse).filter((r) => !r.dupOf)
const inc = (o, k, n = 1) => { o[k] = (o[k] ?? 0) + n }
const RX = /["']?\$ref["']?\s*:\s*["']?([^"'\s,}]+)/g
const forms = {}, formDocs = {}, srcDocs = {}, target = {}, docKinds = {}
const cache = new Map()
function kindOfFile(p) {
  if (cache.has(p)) return cache.get(p)
  let k
  if (!Fs.existsSync(p)) k = 'missing-file'
  else try {
    const t = Fs.readFileSync(p, 'utf8'); let v
    try { v = JSON.parse(t) } catch { v = YAML.parse(t, { uniqueKeys: false, maxAliasCount: -1 }) }
    if (null == v || 'object' !== typeof v || Array.isArray(v)) k = 'non-map'
    else if ('openapi' in v || 'swagger' in v) k = 'openapi-document'
    else if ('$schema' in v) k = 'json-schema-with-$schema'
    else if (['type', 'properties', 'allOf', 'oneOf', 'anyOf', 'items', 'enum'].some((x) => x in v)) k = 'schema-fragment'
    else if (['get', 'post', 'put', 'delete', 'patch'].some((x) => x in v)) k = 'path-item-fragment'
    else if (['operationId', 'responses', 'requestBody'].some((x) => x in v)) k = 'operation-fragment'
    else if (['content', 'in', 'schema'].some((x) => x in v) || ('description' in v && Object.keys(v).length <= 3)) k = 'response/parameter-fragment'
    else k = 'map-of-named-things/other'
  } catch { k = 'unreadable' }
  cache.set(p, k); return k
}
let i = 0
for (const r of M) {
  if (++i % 1000 === 0) process.stderr.write(`ref-census: ${i} of ${M.length} (${((100 * i) / M.length).toFixed(0)}%)\n`)
  const text = Fs.readFileSync(r.path, 'utf8')
  const seen = new Set()
  let m
  RX.lastIndex = 0
  while ((m = RX.exec(text))) {
    const ref = m[1]
    if (ref.startsWith('#')) continue
    const f = W.extForm(ref)
    inc(forms, f); seen.add(f)
    if (f.startsWith('relative')) {
      const p = Path.resolve(Path.dirname(r.path), decodeURIComponent(ref.split('#')[0]))
      inc(target, (p === r.path ? 'SELF ' : '') + kindOfFile(p) + (ref.includes('#') ? ' (with fragment)' : ' (whole file)'))
    }
  }
  for (const f of seen) inc(formDocs, f)
  if (seen.size) inc(srcDocs, r.source)
}
console.log(JSON.stringify({ refsByForm: forms, docsByForm: formDocs, docsWithNonLocalRefBySource: srcDocs, relativeTargets: target }, null, 1))
